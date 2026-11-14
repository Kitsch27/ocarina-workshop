import { degreePitch, rootPitch } from './music.mjs';
export { makeTextRecognizer } from './jianpu-ocr.mjs?v=11';

function components(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const samples = new Uint32Array(256);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) {
    const luma = (0.2126 * data[4 * i] + 0.7152 * data[4 * i + 1] + 0.0722 * data[4 * i + 2]) | 0;
    ink[i] = luma;
    samples[luma]++;
  }
  let bright = 255, dark = 0, count = 0;
  while (bright > 0 && (count += samples[bright]) < ink.length * 0.12) bright--;
  count = 0;
  while (dark < 255 && (count += samples[dark]) < ink.length * 0.009) dark++;
  const threshold = Math.min(221, Math.max(55, dark + (bright - dark) * 0.64));
  const darkPage = dark < 40 && samples.subarray(0, 55).reduce((sum, c) => sum + c, 0) > ink.length * 0.55;
  for (let i = 0; i < ink.length; i++) ink[i] = darkPage ? Number(ink[i] > threshold) : Number(ink[i] < threshold);

  const queue = new Int32Array(ink.length);
  const boxes = [];
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] !== 1) continue;
    let start = 0, end = 1;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    ink[i] = 2;
    queue[0] = i;
    while (start < end) {
      const pos = queue[start++];
      const x = pos % width, y = Math.floor(pos / width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= width) continue;
          const next = pos + dy * width + dx;
          if (ink[next] !== 1) continue;
          queue[end++] = next;
          ink[next] = 2;
        }
      }
    }
    if (end >= 2) {
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      boxes.push({ x: x0, y: y0, w, h, cx: x0 + (w - 1) / 2, cy: y0 + (h - 1) / 2, area: end });
    }
  }
  return { boxes, ink };
}

function findRows(boxes, width, height) {
  const minHeight = Math.max(7, Math.round(width * 0.005));
  const maxHeight = Math.max(23, Math.min(width * 0.085, height * 0.72));
  const candidates = boxes.filter(box =>
    box.h >= minHeight && box.h <= maxHeight &&
    box.w / box.h >= 0.13 && box.w / box.h <= 1.03 &&
    box.area / (box.w * box.h) > 0.11
  ).sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const component of candidates) {
    const row = rows.find(candidate => Math.abs(component.cy - candidate.y) <= 0.28 * candidate.h &&
      component.h / candidate.h >= 0.64 && component.h / candidate.h <= 1.48);
    if (!row) {
      rows.push({ y: component.cy, h: component.h, digits: [component] });
      continue;
    }
    const count = row.digits.length;
    row.y = (row.y * count + component.cy) / (count + 1);
    row.h = (row.h * count + component.h) / (count + 1);
    row.digits.push(component);
  }
  return rows.filter(row => row.digits.length >= 2).sort((a, b) => a.y - b.y).slice(0, 70)
    .map(row => ({ ...row, digits: row.digits.sort((a, b) => a.cx - b.cx) }));
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

function drawGlyph(rgba, box, ink, width, x, y) {
  const scale = 35 / box.h;
  const outWidth = Math.ceil(box.w * scale);
  const left = x - Math.floor(outWidth / 2);
  for (let yy = 0; yy < 35; yy++) {
    const source = (box.y + Math.floor(yy / scale)) * width + box.x;
    for (let xx = 0; xx < outWidth; xx++) {
      if (!ink[source + Math.min(box.w - 1, Math.floor(xx / scale))]) continue;
      const pixel = ((y + yy) * rgba.width + left + xx) * 4;
      rgba.data[pixel] = rgba.data[pixel + 1] = rgba.data[pixel + 2] = 0;
    }
  }
}

async function recognizeGlyphs(rows, ink, width, worker, signal) {
  const cellWidth = 50, cellHeight = 68, columns = 34, perBatch = columns * 12;
  const positions = rows.flatMap(row => row.digits);
  if (positions.length > 1700) throw new Error('这一页的符号太密集，请裁剪出主旋律后分段识别。');
  const matches = new Map();
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '01234567#b',
  });
  for (let offset = 0; offset < positions.length; offset += perBatch) {
    signal.throwIfAborted();
    const batch = positions.slice(offset, offset + perBatch);
    const cols = Math.min(columns, batch.length);
    const { canvas, ctx } = canvasFor(cellWidth * cols, cellHeight * Math.ceil(batch.length / columns));
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < batch.length; index++) {
      drawGlyph(rgba, batch[index], ink, width, (index % columns) * cellWidth + 25,
        Math.floor(index / columns) * cellHeight + 16);
    }
    ctx.putImageData(rgba, 0, 0);
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const symbols = (data.blocks ?? []).flatMap(block => block.paragraphs)
      .flatMap(paragraph => paragraph.lines).flatMap(line => line.words).flatMap(word => word.symbols);
    for (const symbol of symbols) {
      if (!/^[0-7#b]$/.test(symbol.text)) continue;
      const x = (symbol.bbox.x0 + symbol.bbox.x1) / 2;
      const y = (symbol.bbox.y0 + symbol.bbox.y1) / 2;
      const position = batch[Math.floor(y / cellHeight) * columns + Math.floor(x / cellWidth)];
      if (position && (matches.get(position)?.confidence ?? -1) < symbol.confidence) {
        matches.set(position, { text: symbol.text, confidence: symbol.confidence / 100 });
      }
    }
  }
  return matches;
}

function recoverMissingDigits(rows, glyphs, ink, width) {
  const missing = [];
  const examples = new Map();
  const sample = box => Uint8Array.from({ length: 16 * 24 }, (_, i) => Number(Boolean(ink[
    (box.y + Math.floor(Math.floor(i / 16) * box.h / 24)) * width + box.x + Math.floor((i % 16) * box.w / 16)
  ])));
  for (const row of rows) for (const box of row.digits) {
    const glyph = glyphs.get(box);
    if (glyph?.confidence >= 0.90 && /^[0-7]$/.test(glyph.text)) {
      if (!examples.has(glyph.text)) examples.set(glyph.text, []);
      const set = examples.get(glyph.text);
      if (set.length < 16) set.push({ pixels: sample(box), ratio: box.w / box.h });
    } else if (!glyph && box.h >= row.h * 0.84 && box.w / box.h >= 0.26) missing.push(box);
  }
  if (examples.size < 2) return;
  for (const box of missing) {
    const pixels = sample(box);
    const ranked = [...examples].map(([text, set]) => {
      let best = Infinity;
      for (const { pixels: reference, ratio } of set) {
        if (Math.abs(box.w / box.h - ratio) > 0.18) continue;
        let mismatch = 0;
        for (const [i, value] of pixels.entries()) mismatch += value !== reference[i];
        best = Math.min(best, mismatch / pixels.length);
      }
      return { text, distance: best };
    }).sort((a, b) => a.distance - b.distance);
    const [best, next] = ranked;
    if (best.distance <= 0.17 && next.distance - best.distance >= 0.055) {
      glyphs.set(box, { text: best.text, confidence: 0.8 });
    }
  }
}

function underlineStrokes(box, ink, width, height) {
  const span = Math.min(Math.floor(box.h * 0.24), Math.floor((box.w + 1) / 2));
  const center = Math.round(box.cx);
  const left = Math.max(0, center - span);
  const right = Math.min(width - 1, center + span);
  const bottom = box.y + box.h;
  const strokes = [];
  let thickness = 0;
  for (let y = bottom; y < Math.min(height, bottom + Math.ceil(box.h * 0.64)); y++) {
    let pixels = 0;
    for (let x = left; x <= right; x++) if (ink[y * width + x]) pixels++;
    if (pixels >= (right - left + 1) * 0.9) thickness++;
    else if (thickness) {
      strokes.push(thickness);
      thickness = 0;
    }
  }
  if (thickness) strokes.push(thickness);
  return strokes;
}

function timingMarks(box, row, all, medianGap, underlineCount) {
  const xTol = Math.max(box.w * 0.58, row.h * 0.22);
  const near = all.filter(mark => mark !== box && Math.abs(mark.cx - box.cx) <= xTol && mark.h <= row.h * 0.38);
  const dots = near.filter(mark => mark.w <= row.h * 0.35 && mark.h <= row.h * 0.33 &&
    mark.w / mark.h >= 0.42 && mark.w / mark.h < 2.1 && Math.abs(mark.cy - box.cy) > row.h * 0.48 &&
    Math.abs(mark.cy - box.cy) < row.h * 1.48);
  const octave = Math.max(-2, Math.min(2, dots.reduce((sum, mark) => sum + (mark.cy < box.cy ? 1 : -1), 0)));
  const dotted = all.filter(mark => mark.cx > box.x + box.w && mark.cx - (box.x + box.w) < Math.min(medianGap * 0.55, row.h * 0.74) &&
    Math.abs(mark.cy - box.cy) < row.h * 0.31 && mark.w <= row.h * 0.23 && mark.h <= row.h * 0.24 &&
    mark.w / mark.h > 0.45 && mark.w / mark.h < 2.1).length;
  return { beats: (2 - 2 ** -Math.min(dotted, 2)) / (2 ** Math.min(underlineCount, 3)), octave };
}

async function readHeader(canvas, firstRow, worker) {
  const end = Math.min(Math.floor(firstRow.y - firstRow.h * 0.56), Math.floor(canvas.height * 0.26));
  if (end < 22) return { key: null, end: 0 };
  const { canvas: header, ctx } = canvasFor(canvas.width, end);
  ctx.drawImage(canvas, 0, 0, canvas.width, end, 0, 0, canvas.width, end);
  await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '1=ABCDEFG#b♯♭234567890.' });
  const signature = /1\s*=\s*([A-G][#♯b♭]?)/i;
  const { data } = await worker.recognize(header);
  let key = signature.exec(data.text)?.[1];
  if (!key) {
    const width = Math.floor(canvas.width * 0.45);
    const { canvas: left, ctx: context } = canvasFor(width, end);
    context.drawImage(canvas, 0, 0, width, end, 0, 0, width, end);
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const probe = await worker.recognize(left);
    key = signature.exec(probe.data.text)?.[1];
  }
  return { key: key ?? null, end };
}

function groupRows(rows, marks) {
  const systems = [];
  for (const row of rows) {
    const last = systems.at(-1);
    const previous = last?.at(-1);
    const close = previous && row.y - previous.y < 3.5 * Math.max(row.h, previous.h);
    const connected = close && marks.filter(mark =>
      mark.y < previous.y + previous.h * 0.25 && mark.y + mark.h > row.y - row.h * 0.25).length >= 2;
    if (connected) last.push(row);
    else systems.push([row]);
  }
  return systems;
}

export async function recognizeJianpu(canvas, worker, signal, key, part) {
  const { boxes, ink } = components(canvas);
  const rows = findRows(boxes, canvas.width, canvas.height);
  if (!rows.length) return { notes: [], notices: [], parts: 0 };
  const strongest = rows.reduce((best, row) => row.digits.length > best.digits.length ? row : best);
  const barlines = boxes.filter(mark => mark.x > 1 && mark.x + mark.w < canvas.width - 1 && mark.w / mark.h < 0.19);
  const rowDividers = row => barlines.filter(mark => mark.y < row.y - row.h * 0.53 &&
    mark.y + mark.h > row.y + row.h * 0.53 && mark.cx > row.digits[0].cx - row.h * 3 &&
    mark.cx < row.digits.at(-1).cx + row.h * 5);
  const wideRows = rows.filter(row => row.digits.length >= 4 &&
    row.digits.at(-1).cx - row.digits[0].cx >= canvas.width * 0.23 && row.h <= strongest.h * 1.47);
  const firstMusic = wideRows.find(row => rowDividers(row).length >= 2) ??
    wideRows.find(row => row.digits.length >= Math.max(6, strongest.digits.length * 0.45)) ?? rows[0];
  const header = await readHeader(canvas, firstMusic, worker);
  const resolvedKey = key === 'auto' ? header.key : key;
  const root = rootPitch(resolvedKey ?? 'C4');
  const usableRows = rows.filter(row => row.y >= header.end && row.h <= strongest.h * 1.47);
  if (!usableRows.length) return { notes: [], notices: [], parts: 0 };
  const glyphs = await recognizeGlyphs(usableRows, ink, canvas.width, worker, signal);
  const crossed = row => rowDividers(row).length >= 2;
  recoverMissingDigits(usableRows.filter(crossed), glyphs, ink, canvas.width);
  let musicRows = usableRows.map(row => ({
    ...row, numbers: row.digits.filter(box => /^[0-7]$/.test(glyphs.get(box)?.text ?? '')),
  })).filter(row => row.numbers.length >= 2 && row.numbers.length / row.digits.length >= 0.52);
  const barredRows = musicRows.filter(crossed);
  const rightEdge = row => rowDividers(row).reduce((right, mark) => Math.max(right, mark.cx), 0);
  if (barredRows.some((row, index) => barredRows.slice(index + 1).some(other =>
    Math.abs(rightEdge(row) - rightEdge(other)) < Math.min(row.h, other.h)))) {
    musicRows = musicRows.filter(row => crossed(row) || row.numbers.some(box =>
      underlineStrokes(box, ink, canvas.width, canvas.height).length) &&
      row.numbers.filter(box => (glyphs.get(box)?.confidence ?? 0) >= 0.70 && glyphs.get(box)?.text !== '0').length >= 2);
  }
  let systems = groupRows(musicRows, barlines);
  const paired = systems.filter(system => system.length > 1);
  if (paired.length >= 2) {
    systems = systems.filter(system => system.length > 1 || crossed(system[0]) ||
      paired.every(group => !group.some(row => Math.abs(row.y - system[0].y) < row.h * 3.2)));
  }
  const parts = Math.max(0, ...systems.map(system => system.length));
  const underlines = new Map();
  for (const row of musicRows) for (const box of row.numbers) {
    underlines.set(box, underlineStrokes(box, ink, canvas.width, canvas.height));
  }
  const strokeWidths = [...underlines.values()].flat().sort((a, b) => a - b);
  const singleStroke = strokeWidths[Math.floor(strokeWidths.length * 0.4)] ?? 1;
  const notes = [];
  let bar = 0;
  for (const system of systems) {
    const row = system[part];
    if (!row) continue;
    const digits = row.numbers;
    const distances = digits.slice(1).map((box, i) => box.cx - digits[i].cx).sort((a, b) => a - b);
    const gap = distances[Math.floor(distances.length / 2)] ?? row.h;
    const rowMarks = boxes.filter(mark => Math.abs(mark.cy - row.y) < row.h * 1.57);
    const dividers = rowDividers(row).sort((a, b) => a.cx - b.cx);
    const dashes = rowMarks.filter(mark => mark.w >= row.h * 0.54 && mark.w / mark.h >= 3 &&
      Math.abs(mark.cy - row.y) < row.h * 0.27);
    for (const [index, box] of digits.entries()) {
      const { text, confidence } = glyphs.get(box);
      // The gap between two underlines can disappear when a score is photographed or compressed.
      const fusedWidth = Math.max(4, row.h * 0.23, singleStroke * 1.75);
      const underlineCount = underlines.get(box).reduce((sum, stroke) => sum + (stroke >= fusedWidth ? 2 : 1), 0);
      const { beats, octave } = timingMarks(box, row, rowMarks, gap, underlineCount);
      const nextX = digits[index + 1]?.x ?? box.x + Math.max(row.h * 3, gap * 2);
      const divider = dividers.find(mark => mark.cx > box.cx && mark.cx < nextX);
      const extensions = dashes.filter(mark => mark.cx > box.x + box.w && mark.cx < (divider?.cx ?? nextX));
      const preceding = row.digits.findLast(mark => mark.x + mark.w <= box.x + 1 &&
        box.x - (mark.x + mark.w) < row.h * 0.55 && /^[#b]$/.test(glyphs.get(mark)?.text ?? '') &&
        glyphs.get(mark).confidence >= 0.38);
      const alter = preceding ? (glyphs.get(preceding).text === '#' ? 1 : -1) : 0;
      notes.push({ pitch: degreePitch(Number(text), root, octave, alter), beats: beats + extensions.length, bar, confidence });
      if (divider) bar++;
    }
    if (notes.at(-1)?.bar === bar) bar++;
  }
  const notices = ['简谱的数字、时值和八度请对照原谱检查。'];
  if (parts > 1) notices.push('已按所选声部读取。');
  if (part > 0 && systems.some(system => !system[part])) notices.push('部分谱行缺少所选声部。');
  if (key === 'auto' && !header.key) notices.push('未读到调号，暂以 1 = C4 计算。');
  return { notes, notices, parts, key: resolvedKey };
}
