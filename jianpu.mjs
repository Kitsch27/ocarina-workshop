import { degreePitch, rootPitch } from './music.mjs';
import { loadClassicScript } from './score-files.mjs';

const tess = './vendor/tesseract/';
const tessUrl = name => new URL(tess + name, import.meta.url).href;
let library;

export async function makeTextRecognizer(signal, onProgress) {
  library ??= loadClassicScript(tessUrl('tesseract.min.js')).catch(error => {
    library = null;
    throw error;
  });
  await library;
  signal.throwIfAborted();
  const worker = await globalThis.Tesseract.createWorker('eng', 1, {
    workerPath: tessUrl('worker.min.js'),
    corePath: tessUrl(''),
    langPath: tessUrl('').replace(/\/$/, ''),
    workerBlobURL: false,
    cacheMethod: 'write',
    logger: ({ status, progress }) => {
      onProgress(status === 'recognizing text' ? '正在读取简谱数字…' : '载入简谱识别组件…', 0.28 + 0.6 * progress);
    },
    errorHandler: () => {},
  });
  if (signal.aborted) {
    await worker.terminate();
    signal.throwIfAborted();
  }
  return worker;
}

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
      const box = batch[index];
      const scale = 35 / box.h;
      const outWidth = Math.ceil(box.w * scale);
      const left = (index % columns) * cellWidth + Math.floor((cellWidth - outWidth) / 2);
      const top = Math.floor(index / columns) * cellHeight + 16;
      for (let yy = 0; yy < 35; yy++) {
        const source = (box.y + Math.floor(yy / scale)) * width + box.x;
        for (let xx = 0; xx < outWidth; xx++) {
          if (!ink[source + Math.min(box.w - 1, Math.floor(xx / scale))]) continue;
          const pixel = ((top + yy) * canvas.width + left + xx) * 4;
          rgba.data[pixel] = rgba.data[pixel + 1] = rgba.data[pixel + 2] = 0;
        }
      }
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

function timingMarks(box, row, all, medianGap) {
  const xTol = Math.max(box.w * 0.58, row.h * 0.22);
  const near = all.filter(mark => mark !== box && Math.abs(mark.cx - box.cx) <= xTol && mark.h <= row.h * 0.38);
  const under = all.filter(mark => mark.h <= row.h * 0.26 && mark.w / mark.h >= 2.1 && mark.w >= box.w * 0.7 &&
    mark.y >= box.y + box.h && mark.y - (box.y + box.h) < row.h * 0.67 &&
    mark.x <= box.cx + xTol && mark.x + mark.w >= box.cx - xTol);
  const dots = near.filter(mark => mark.w <= row.h * 0.35 && mark.h <= row.h * 0.33 &&
    mark.w / mark.h >= 0.42 && mark.w / mark.h < 2.1 && Math.abs(mark.cy - box.cy) > row.h * 0.48 &&
    Math.abs(mark.cy - box.cy) < row.h * 1.48);
  const octave = Math.max(-2, Math.min(2, dots.reduce((sum, mark) => sum + (mark.cy < box.cy ? 1 : -1), 0)));
  const dotted = all.filter(mark => mark.cx > box.x + box.w && mark.cx - (box.x + box.w) < Math.min(medianGap * 0.55, row.h * 0.74) &&
    Math.abs(mark.cy - box.cy) < row.h * 0.31 && mark.w <= row.h * 0.23 && mark.h <= row.h * 0.24 &&
    mark.w / mark.h > 0.45 && mark.w / mark.h < 2.1).length;
  return { beats: (2 - 2 ** -Math.min(dotted, 2)) / (2 ** Math.min(under.length, 3)), octave };
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
  const barlines = boxes.filter(mark => mark.w / mark.h < 0.15 && mark.h >= strongest.h * 0.93);
  const wideRows = rows.filter(row => row.digits.length >= 4 &&
    row.digits.at(-1).cx - row.digits[0].cx >= canvas.width * 0.23 && row.h <= strongest.h * 1.47);
  const firstMusic = wideRows.find(row => barlines.filter(mark => mark.y < row.y - row.h * 0.2 &&
    mark.y + mark.h > row.y + row.h * 0.2).length >= 2) ??
    wideRows.find(row => row.digits.length >= Math.max(6, strongest.digits.length * 0.45)) ?? rows[0];
  const header = await readHeader(canvas, firstMusic, worker);
  const resolvedKey = key === 'auto' ? header.key : key;
  const root = rootPitch(resolvedKey ?? 'C4');
  const usableRows = rows.filter(row => row.y >= header.end && row.h <= strongest.h * 1.47);
  if (!usableRows.length) return { notes: [], notices: [], parts: 0 };
  const glyphs = await recognizeGlyphs(usableRows, ink, canvas.width, worker, signal);
  let musicRows = usableRows.map(row => ({
    ...row, numbers: row.digits.filter(box => /^[0-7]$/.test(glyphs.get(box)?.text ?? '')),
  })).filter(row => row.numbers.length >= 2 && row.numbers.length / row.digits.length >= 0.52);
  const crossed = row => barlines.filter(mark => mark.y < row.y - row.h * 0.2 &&
    mark.y + mark.h > row.y + row.h * 0.2).length >= 2;
  let systems = groupRows(musicRows, barlines);
  const paired = systems.filter(system => system.length > 1);
  if (paired.length >= 2) {
    systems = systems.filter(system => system.length > 1 || crossed(system[0]) ||
      paired.every(group => !group.some(row => Math.abs(row.y - system[0].y) < row.h * 3.2)));
  }
  const parts = Math.max(0, ...systems.map(system => system.length));
  const notes = [];
  let bar = 0;
  for (const system of systems) {
    const row = system[part];
    if (!row) continue;
    const digits = row.numbers;
    const distances = digits.slice(1).map((box, i) => box.cx - digits[i].cx).sort((a, b) => a - b);
    const gap = distances[Math.floor(distances.length / 2)] ?? row.h;
    const rowMarks = boxes.filter(mark => Math.abs(mark.cy - row.y) < row.h * 1.57);
    const dividers = barlines.filter(mark => !glyphs.has(mark) && mark.h >= row.h * 0.85 &&
      mark.w / mark.h < 0.19 && mark.y < row.y && mark.y + mark.h > row.y).sort((a, b) => a.cx - b.cx);
    const dashes = rowMarks.filter(mark => mark.w >= row.h * 0.54 && mark.w / mark.h >= 3 &&
      Math.abs(mark.cy - row.y) < row.h * 0.27);
    for (const [index, box] of digits.entries()) {
      const { text, confidence } = glyphs.get(box);
      const { beats, octave } = timingMarks(box, row, rowMarks, gap);
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
