import * as ort from './vendor/ort/ort.wasm.min.mjs';
import { detect, normalizeStaff } from './vendor/satb/omr-preprocess.mjs';
import { decodeLine, i2wFromVocab, lineFragment } from './vendor/satb/omr-decode.mjs';
import { pitchNumber } from './music.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.initTimeout = 45000;
const SHARPS = 'FCGDAEB';
const FLATS = 'BEADGCF';
const SIGNS = { '#': 1, '##': 2, '-': -1, '--': -2, n: 0 };
let resources;

function deskew(gray, width, height) {
  const positions = [];
  const stride = Math.max(2, Math.floor(Math.max(width, height) / 700));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (gray[y * width + x] < 0.45) positions.push(x - width / 2, y);
    }
  }
  if (positions.length < 150) return gray;
  const pad = Math.ceil(width * 0.083);
  const rows = new Uint32Array(height + 2 * pad + 1);
  let bestAngle = 0;
  let best = 0;
  const candidates = [0];
  for (let degrees = 0.25; degrees <= 9; degrees += 0.25) candidates.push(degrees, -degrees);
  for (const degrees of candidates) {
    const slope = Math.tan(degrees * Math.PI / 180);
    rows.fill(0);
    for (let p = 0; p < positions.length; p += 2) {
      rows[(positions[p + 1] - slope * positions[p] + pad + 0.5) | 0]++;
    }
    let energy = 0;
    for (const count of rows) energy += count ** 3;
    if (energy > best * 1.017) {
      best = energy;
      bestAngle = degrees;
    }
  }
  if (Math.abs(bestAngle) < 0.25) return gray;
  const slope = Math.tan(bestAngle * Math.PI / 180);
  const flattened = new Float32Array(gray.length).fill(1);
  for (let x = 0; x < width; x++) {
    const delta = slope * (x - width / 2);
    const start = Math.floor(delta);
    const fraction = delta - start;
    for (let y = Math.max(0, -start); y < Math.min(height, height - start - 1); y++) {
      const at = (y + start) * width + x;
      flattened[y * width + x] = gray[at] * (1 - fraction) + gray[at + width] * fraction;
    }
  }
  return flattened;
}

function grayscale(data) {
  const gray = new Float32Array(data.length / 4);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const value = (data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722) | 0;
    gray[i] = value;
    histogram[value]++;
  }
  let low = 0, high = 255, count = 0;
  while (low < 255 && (count += histogram[low]) < gray.length * 0.013) low++;
  count = 0;
  while (high > 0 && (count += histogram[high]) < gray.length * 0.25) high--;
  if (high < low + 48) { low = 0; high = 255; }
  for (let i = 0; i < gray.length; i++) gray[i] = Math.min(1, Math.max(0, (gray[i] - low) / (high - low)));
  return gray;
}

function detectPage(data, width, height) {
  let gray = grayscale(data);
  let layout = detect(gray, width, height);
  if (!layout.boxes.length) {
    const dark = gray.reduce((sum, value) => sum + Number(value < 0.4), 0);
    if (dark > gray.length * 0.57) {
      gray = gray.map(value => 1 - value);
      layout = detect(gray, width, height);
    }
  }
  if (!layout.boxes.length) {
    const flattened = deskew(gray, width, height);
    if (flattened !== gray) {
      gray = flattened;
      layout = detect(gray, width, height);
    }
  }
  return { gray, layout };
}

function normalize(gray, pageWidth, box, top) {
  const crop = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const start = (box.y + y) * pageWidth + box.x;
    crop.set(gray.subarray(start, start + box.w), y * box.w);
  }
  const norm = normalizeStaff(crop, box.w, box.h, box.lineSpacing, top - box.y);
  for (let i = 0; i < norm.data.length; i++) norm.data[i] = 1 - norm.data[i];
  return norm;
}

async function loadModel(signal) {
  const timeout = AbortSignal.timeout(60000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  resources ??= Promise.all([
    fetch(new URL('./vendor/satb/omr-line.fp32.onnx', import.meta.url), { signal: requestSignal }).then(async response => {
      if (!response.ok) throw new Error('五线谱模型下载失败。');
      return ort.InferenceSession.create(await response.arrayBuffer(), {
        executionProviders: ['wasm'], graphOptimizationLevel: 'disabled',
      });
    }),
    fetch(new URL('./vendor/satb/vocab.json', import.meta.url), { signal: requestSignal }).then(response => {
      if (!response.ok) throw new Error('词表加载失败。');
      return response.json();
    }),
  ]).then(([session, vocab]) => ({ session, words: i2wFromVocab(vocab.tokens) })).catch(error => {
    resources = null;
    throw error;
  });
  return resources;
}

function convertLine(elements, keyState, barOffset) {
  const notes = [];
  const effective = new Map();
  let bar = barOffset;
  let unread = 0;
  for (const element of elements) {
    if (element.kind === 'unparseable') unread++;
    if (element.kind === 'attribute' && 'keyFifths' in element) keyState.fifths = element.keyFifths;
    if (element.kind === 'barline') {
      if (notes.at(-1)?.bar === bar) bar++;
      effective.clear();
    }
    if (element.kind !== 'note' && element.kind !== 'rest') continue;
    let pitch = null;
    if (element.kind === 'note') {
      const { step, octave } = element.pitch;
      const name = step + octave;
      const explicit = element.sign;
      const direction = keyState.fifths < 0 ? -1 : 1;
      const signature = (direction < 0 ? FLATS : SHARPS).slice(0, Math.abs(keyState.fifths)).includes(step) ? direction : 0;
      if (explicit !== undefined) effective.set(name, explicit);
      const alter = effective.get(name) ?? signature;
      pitch = pitchNumber(step, octave, alter);
    }
    notes.push({ pitch, beats: element.duration.divisions / 48, bar, tie: element.tie, confidence: element.confidence });
  }
  return { notes, nextBar: notes.length ? notes.at(-1).bar + 1 : barOffset, unread };
}

function splitRecords(events) {
  const records = [];
  let record = [];
  for (const event of events) {
    if (event.token === '<b>') {
      if (record.length) records.push(record);
      record = [];
    } else record.push(event);
  }
  if (record.length) records.push(record);
  return records;
}

function readElements(events, box) {
  const staff = { page: 0, system: box.system, staffIndex: box.voice, bbox: [box.x, box.y, box.w, box.h], lineSpacingPx: box.lineSpacing, normSpacing: 10 };
  // Decode each record independently to retain explicit naturals and distinguish
  // them from notes that inherit the current key or an earlier accidental.
  return splitRecords(events).flatMap(record => {
    const sign = record.find(event => Object.hasOwn(SIGNS, event.token));
    return lineFragment(record, staff).map(element => ({ ...element, sign: sign ? SIGNS[sign.token] : undefined }));
  });
}

export async function recognizeStaff({ data, width, height, part, fifths }, onProgress, signal) {
  const { gray, layout } = detectPage(data, width, height);
  if (!layout.boxes.length) return { lines: 0, parts: 0, notes: [], unread: 0 };
  onProgress('载入五线谱识别模型…', 0.2);
  const { session, words } = await loadModel(signal);
  const parts = Math.max(...layout.systems.map(system => system.length));
  const boxes = layout.boxes.filter(box => box.voice === part);
  const keyState = { fifths };
  const notes = [];
  let bar = 0;
  let unread = 0;
  let missing = layout.systems.length - boxes.length;
  let wide = 0;
  for (const [index, box] of boxes.entries()) {
    signal?.throwIfAborted();
    onProgress(`正在读取第 ${index + 1} / ${boxes.length} 行五线谱…`, 0.25 + 0.72 * index / boxes.length);
    await new Promise(resolve => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const staffTop = layout.staves[box.staff].lineCenters[0];
    const input = normalize(gray, width, box, staffTop);
    if (input.width < 12 || input.width > 8500) {
      wide++;
      continue;
    }
    const tensor = new ort.Tensor('float32', input.data, [1, 1, input.height, input.width]);
    const { logits } = await session.run({ input: tensor });
    const [, frames, classes] = logits.dims;
    const events = decodeLine(logits.data, frames, classes, words);
    const result = convertLine(readElements(events, box), keyState, bar);
    if (!result.notes.some(note => note.pitch != null)) missing++;
    notes.push(...result.notes);
    bar = result.nextBar;
    unread += result.unread;
  }
  return { notes, parts, unread, missing, wide, fifths: keyState.fifths };
}
