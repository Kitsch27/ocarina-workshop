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

async function refineDigits(rows, glyphs, ink, width, worker, signal) {
  const examples = new Map();
  const positions = rows.flatMap(row => row.digits.filter(box => box.h >= row.h * 0.84 && box.h <= row.h * 1.18));
  const shapes = new Map(positions.map(box => [box, Uint8Array.from({ length: 16 * 24 }, (_, i) => Boolean(ink[
    (box.y + Math.floor((i >> 4) * box.h / 24)) * width + box.x + Math.floor((i % 16) * box.w / 16)
  ]))]));
  const recheck = [];
  for (const box of positions) {
    const glyph = glyphs.get(box);
    if (!(glyph?.confidence >= 0.93) || !/^[0-7]$/.test(glyph.text)) continue;
    const set = examples.get(glyph.text) ?? [];
    if (set.length < 24) set.push(box);
    examples.set(glyph.text, set);
  }
  if (examples.size < 2) return;
  for (const box of positions) {
    const glyph = glyphs.get(box);
    const pixels = shapes.get(box);
    const ranked = [...examples].map(([digit, set]) => {
      const distances = [];
      for (const exemplar of set) {
        if (exemplar === box || Math.abs(box.w / box.h - exemplar.w / exemplar.h) > 0.13) continue;
        const reference = shapes.get(exemplar);
        let mismatch = 0;
        for (let i = 0; i < pixels.length; i++) mismatch += pixels[i] !== reference[i];
        distances.push(mismatch / pixels.length);
      }
      distances.sort((a, b) => a - b);
      return { digit, nearest: distances[0] ?? Infinity, next: distances[1] ?? Infinity };
    }).sort((a, b) => a.nearest - b.nearest);
    const [best, alternative] = ranked;
    if (best.digit === glyph?.text) continue;
    const separation = alternative.nearest - best.nearest;
    const strongMatch = best.nearest <= 0.085 && best.next <= 0.13 && separation >= 0.06;
    const likelyMissing = !glyph && best.nearest <= 0.145 && alternative.nearest - best.nearest >= 0.06;
    if (strongMatch || likelyMissing) {
      glyphs.set(box, { text: best.digit, confidence: 0.82 });
    } else {
      const nearby = ranked.find(entry => entry.digit === glyph?.text);
      // Use a second OCR pass only for a missing glyph or a shape that contradicts the first pass.
      if (!glyph || (nearby && best.nearest <= 0.13 && nearby.nearest - best.nearest >= 0.045)) {
        recheck.push({ box, glyph, best });
      }
    }
  }
  if (!recheck.length) return;
  const { canvas: cell, ctx } = canvasFor(76, 64);
  await worker.setParameters({ tessedit_pageseg_mode: '13', tessedit_char_whitelist: '01234567' });
  for (const { box, glyph, best } of recheck.slice(0, 20)) {
    signal.throwIfAborted();
    ctx.fillRect(0, 0, cell.width, cell.height);
    const rgba = ctx.getImageData(0, 0, cell.width, cell.height);
    drawGlyph(rgba, box, ink, width, cell.width / 2, 14);
    ctx.putImageData(rgba, 0, 0);
    const { data } = await worker.recognize(cell);
    const text = data.text.trim();
    if (!/^[0-7]$/.test(text) || data.confidence < 65) continue;
    if (glyph && text !== best.digit) continue;
    glyphs.set(box, { text, confidence: Math.min(0.9, data.confidence / 100) });
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

function assignAugmentationDots(row, notes, marks, dividers) {
  const assigned = new Map();
  for (const mark of marks) {
    if (mark.w < row.h * 0.12 || mark.h < row.h * 0.12 || mark.w > row.h * 0.35 || mark.h > row.h * 0.35 ||
      mark.w / mark.h < 0.55 || mark.w / mark.h > 1.75 || mark.area / (mark.w * mark.h) < 0.55 ||
      Math.abs(mark.cy - row.y) > row.h * 0.32) continue;
    const note = notes.findLast(box => box.cx < mark.cx);
    if (!note || mark.x < note.x + note.w || mark.cx - (note.x + note.w) > row.h * 1.55 ||
      dividers.some(line => line.cx > note.cx && line.cx < mark.cx)) continue;
    // An octave dot belongs above or below its digit. Avoid using it as an augmentation dot.
    if (Math.abs(mark.cy - note.cy) > row.h * 0.32) continue;
    assigned.set(note, Math.min(2, (assigned.get(note) ?? 0) + 1));
  }
  return assigned;
}

async function readHeader(canvas, firstRow, worker, enhanced) {
  const end = Math.min(Math.floor(firstRow.y - firstRow.h * 0.56), Math.floor(canvas.height * 0.26));
  if (end < 22) return { key: null, end: 0 };
  const { canvas: header, ctx } = canvasFor(canvas.width, end);
  ctx.drawImage(canvas, 0, 0, canvas.width, end, 0, 0, canvas.width, end);
  await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '1=ABCDEFG#b♯♭234567890.' });
  const signature = /1\s*=\s*([A-G][#♯b♭]?)/i;
  const detail = enhanced ? { blocks: true, text: true } : undefined;
  let { data } = await worker.recognize(header, {}, detail);
  let key = signature.exec(data.text)?.[1];
  if (!key) {
    const width = Math.floor(canvas.width * 0.45);
    const { canvas: left, ctx: context } = canvasFor(width, end);
    context.drawImage(canvas, 0, 0, width, end, 0, 0, width, end);
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const probe = await worker.recognize(left, {}, detail);
    data = probe.data;
    key = signature.exec(data.text)?.[1];
  }
  const headerData = { key: key ?? null, end };
  if (!enhanced || !key) return headerData;
  const lines = (data.blocks ?? []).flatMap(block => block.paragraphs).flatMap(paragraph => paragraph.lines);
  for (const line of lines) {
    const symbols = line.words.flatMap(word => word.symbols);
    const signatureIndex = symbols.findIndex((symbol, index) => symbol.text === key[0] &&
      symbols[index - 1]?.text === '=' && symbols[index - 2]?.text === '1');
    if (signatureIndex === -1) continue;
    const first = symbols[signatureIndex - 2].bbox;
    const last = symbols[signatureIndex + key.length - 1]?.bbox ?? symbols[signatureIndex].bbox;
    headerData.signature = { x: first.x0, right: last.x1, y: (first.y0 + first.y1) / 2, h: first.y1 - first.y0 };
    break;
  }
  return headerData;
}

async function readMeterAndTempo(canvas, boxes, ink, header, worker, signal) {
  if (!header.signature) return {};
  const { x, right, y, h } = header.signature;
  const sameSize = box => box.h >= h * 0.48 && box.h <= h * 1.25;
  const nearMeter = boxes.filter(box => box.cx > right && box.cx - right < h * 2.5 && sameSize(box));
  const upper = nearMeter.filter(box => y - box.cy >= h * 0.23 && y - box.cy < h);
  const lower = nearMeter.filter(box => box.cy - y >= h * 0.23 && box.cy - y < h);
  const stacked = upper.flatMap(num => lower.filter(den => Math.abs(den.cx - num.cx) < h * 0.24 && boxes.some(line =>
    Math.abs(line.cx - num.cx) < h * 0.28 && line.cy > num.cy && line.cy < den.cy &&
    line.w >= h * 0.46 && line.w <= h * 1.75 && line.w / line.h >= 3)).map(den => [num, den]));
  let meter;
  if (stacked.length === 1) {
    const [numBox, denBox] = stacked[0];
    const { canvas: digits, ctx } = canvasFor(120, 64);
    const pixels = ctx.getImageData(0, 0, digits.width, digits.height);
    drawGlyph(pixels, numBox, ink, canvas.width, 30, 14);
    drawGlyph(pixels, denBox, ink, canvas.width, 85, 14);
    ctx.putImageData(pixels, 0, 0);
    signal.throwIfAborted();
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '123456789' });
    const { data } = await worker.recognize(digits);
    const reading = /^([23456789])([248])$/.exec(data.text.replace(/\s/g, ''));
    if (reading) meter = { num: Number(reading[1]), den: Number(reading[2]) };
  }

  const tempoMark = boxes.find(box => box.cx >= x - h && box.cx <= x + h * 0.66 &&
    box.y >= y + h * 0.6 && box.y + box.h <= header.end && box.cy <= y + h * 3.2 &&
    box.h >= h * 1.06 && box.h <= h * 1.95 && box.w >= box.h * 0.27 && box.w <= box.h * 0.53);
  let tempo;
  if (tempoMark) {
    const upperStem = Math.round(tempoMark.h * 0.42);
    let flagged = false;
    for (let yy = tempoMark.y; yy < tempoMark.y + upperStem; yy++) {
      let pixels = 0;
      for (let xx = tempoMark.x; xx < tempoMark.x + tempoMark.w; xx++) pixels += Boolean(ink[yy * canvas.width + xx]);
      if (pixels > tempoMark.w * 0.54) flagged = true;
    }
    if (!flagged && !boxes.some(box => box.w < h * 0.45 && box.h < h * 0.45 &&
      box.cx > tempoMark.cx && box.cx - tempoMark.cx < h * 0.85 && Math.abs(box.cy - tempoMark.cy) < h * 0.53)) {
      const left = tempoMark.x + tempoMark.w;
      const top = Math.max(0, tempoMark.y - Math.floor(h * 0.25));
      const width = Math.min(Math.ceil(h * 5), canvas.width - left);
      const height = Math.min(header.end - top, Math.ceil(tempoMark.h + h * 0.45));
      const { canvas: marking, ctx } = canvasFor(width * 2 + 16, height * 2 + 16);
      ctx.drawImage(canvas, left, top, width, height, 8, 8, width * 2, height * 2);
      signal.throwIfAborted();
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '=0123456789' });
      const { data } = await worker.recognize(marking);
      const reading = /^=(\d{2,3})$/.exec(data.text.replace(/\s/g, ''));
      if (reading && Number(reading[1]) >= 30 && Number(reading[1]) <= 240) tempo = Number(reading[1]);
    }
  }
  return { meter, tempo };
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

export async function recognizeJianpu(canvas, worker, signal, key, part, { enhanced = false, meter: inheritedMeter } = {}) {
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
  const header = await readHeader(canvas, firstMusic, worker, enhanced);
  const marks = enhanced ? await readMeterAndTempo(canvas, boxes, ink, header, worker, signal) : {};
  const meter = marks.meter ?? inheritedMeter;
  const resolvedKey = key === 'auto' ? header.key : key;
  const root = rootPitch(resolvedKey ?? 'C4');
  const usableRows = rows.filter(row => row.y >= header.end && row.h <= strongest.h * 1.47);
  if (!usableRows.length) return { notes: [], notices: [], parts: 0 };
  const glyphs = await recognizeGlyphs(usableRows, ink, canvas.width, worker, signal);
  const crossed = row => rowDividers(row).length >= 2;
  const reliableRows = usableRows.filter(crossed);
  if (enhanced) await refineDigits(reliableRows, glyphs, ink, canvas.width, worker, signal);
  recoverMissingDigits(reliableRows, glyphs, ink, canvas.width);
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
    const augmentation = enhanced ? assignAugmentationDots(row, digits, rowMarks, dividers) : null;
    const dashes = rowMarks.filter(mark => mark.w >= row.h * 0.54 && mark.w / mark.h >= 3 &&
      Math.abs(mark.cy - row.y) < row.h * 0.27);
    for (const [index, box] of digits.entries()) {
      const { text, confidence } = glyphs.get(box);
      // The gap between two underlines can disappear when a score is photographed or compressed.
      const fusedWidth = Math.max(4, row.h * 0.23, singleStroke * 1.75);
      const underlineCount = underlines.get(box).reduce((sum, stroke) => sum + (stroke >= fusedWidth ? 2 : 1), 0);
      const timing = timingMarks(box, row, rowMarks, gap, underlineCount);
      const beats = augmentation ? (2 - 2 ** -(augmentation.get(box) ?? 0)) / 2 ** Math.min(underlineCount, 3) : timing.beats;
      const nextX = digits[index + 1]?.x ?? box.x + Math.max(row.h * 3, gap * 2);
      const divider = dividers.find(mark => mark.cx > box.cx && mark.cx < nextX);
      const extensions = dashes.filter(mark => mark.cx > box.x + box.w && mark.cx < (divider?.cx ?? nextX));
      const preceding = row.digits.findLast(mark => mark.x + mark.w <= box.x + 1 &&
        box.x - (mark.x + mark.w) < row.h * 0.55 && /^[#b]$/.test(glyphs.get(mark)?.text ?? '') &&
        glyphs.get(mark).confidence >= 0.38);
      const alter = preceding ? (glyphs.get(preceding).text === '#' ? 1 : -1) : 0;
      const note = { pitch: degreePitch(Number(text), root, timing.octave, alter), beats: beats + extensions.length, bar, confidence };
      if (enhanced) {
        note.sourceBox = { x: box.x, y: box.y, w: box.w, h: box.h };
        if (meter) note.meter = meter;
      }
      notes.push(note);
      if (divider) bar++;
    }
    if (notes.at(-1)?.bar === bar) bar++;
  }
  const notices = ['简谱的数字、时值和八度请对照原谱检查。'];
  if (parts > 1) notices.push('已按所选声部读取。');
  if (part > 0 && systems.some(system => !system[part])) notices.push('部分谱行缺少所选声部。');
  if (key === 'auto' && !header.key) notices.push('未读到调号，暂以 1 = C4 计算。');
  return { notes, notices, parts, key: resolvedKey, ...(enhanced ? { meter, tempo: marks.tempo } : {}) };
}
