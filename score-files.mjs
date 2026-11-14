import { mergeTies, pitchNumber } from './music.mjs';

const MAX_PIXELS = 7_000_000;
const MAX_EDGE = 3600;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const JPG = /^image\/(?:jpe?g|png|webp|avif|bmp|gif|x-ms-bmp)$/i;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|avif|bmp|gif)$/i;
const HEIC = /\.(?:heic|heif)$/i;
const AUDIO_EXT = /\.(?:mp3|wav|m4a|aac|ogg|oga|opus|flac|aif|aiff)$/i;

export function fileKind(file) {
  if (/\.(?:musicxml|xml)$/i.test(file.name) || /(?:musicxml|\/xml)$/.test(file.type)) return 'xml';
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf';
  if (HEIC.test(file.name) || /^image\/hei[cf]$/i.test(file.type)) return 'heic';
  if (JPG.test(file.type) || IMAGE_EXT.test(file.name)) return 'image';
  if (AUDIO_EXT.test(file.name) || file.type.startsWith('audio/')) return 'audio';
  return null;
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

export function imageScale(width, height, target = 1) {
  return Math.min(target, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

export function loadClassicScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error('识别组件加载失败，请刷新页面重试。'));
    };
    document.head.append(script);
  });
}

async function loadImage(file, kind) {
  let blob = file;
  if (kind === 'heic') {
    try {
      const bitmap = await createImageBitmap(file);
      return { image: bitmap, dispose: () => bitmap.close() };
    } catch {
      try {
        const { heicTo } = await import('./vendor/heic/heic-to.mjs');
        blob = await heicTo({ blob: file, type: 'image/png' });
      } catch {
        throw new Error('无法读取这份 HEIC 图片。请将它另存为 JPG 或 PNG 后再试。');
      }
    }
  }
  const src = URL.createObjectURL(blob);
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(src);
    throw new Error('无法打开这张图片，请检查文件内容或另存为 PNG。');
  }
  return { image, dispose: () => URL.revokeObjectURL(src) };
}

export async function readImage(file, kind) {
  const { image, dispose } = await loadImage(file, kind);
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width < 60 || height < 20) throw new Error('图片尺寸过小，请上传清晰的乐谱。');
    const scale = imageScale(width, height, width < 1100 ? Math.min(2, 1100 / width) : 1);
    const canvas = canvasFor(width * scale, height * scale);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    dispose();
  }
}

export async function openPdf(file) {
  const pdfjs = await import('./vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const request = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    isEvalSupported: false,
    stopAtErrors: true,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
  });
  request.onPassword = () => { request.destroy().catch(() => {}); };
  try {
    return await request.promise;
  } catch {
    throw new Error('无法打开 PDF，请确认文件完好并已解除密码保护。');
  }
}

export async function readPdfPage(pdf, pageNumber, maxWidth = 2100) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: imageScale(base.width, base.height, maxWidth / base.width) });
  const canvas = canvasFor(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, background: '#fff' }).promise;
  page.cleanup();
  return canvas;
}

export function parsePages(text, total) {
  const pages = new Set();
  for (const chunk of text.trim().split(/[,，、\s]+/)) {
    const numbers = /^(\d+)(?:[-–—](\d+))?$/.exec(chunk);
    if (!numbers) throw new Error('请输入页码，例如 1–3 或 1,3。');
    const start = Number(numbers[1]);
    const end = Number(numbers[2] ?? start);
    if (start < 1 || end < start || end > total) throw new Error(`页码应在 1 至 ${total} 之间。`);
    if (end - start >= 8) throw new Error('每次最多处理 8 页，请分段选择。');
    for (let value = start; value <= end; value++) pages.add(value);
    if (pages.size > 8) throw new Error('每次最多处理 8 页，请分段选择。');
  }
  return [...pages].sort((a, b) => a - b);
}

const xmlText = (node, selector) => node?.querySelector(selector)?.textContent?.trim() ?? '';

export function openMusicXML(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'score-partwise') {
    throw new Error('请使用有效的 MusicXML 乐谱（score-partwise）。');
  }
  const parts = [...xml.documentElement.children].filter(child => child.localName === 'part');
  if (!parts.length) throw new Error('这份 MusicXML 没有可用的声部。');
  const names = new Map([...xml.querySelectorAll('score-part')].map(part => [part.id || part.getAttribute('id'), xmlText(part, 'part-name')]));
  return {
    title: xmlText(xml, 'work-title') || xmlText(xml, 'movement-title'),
    tempo: Number(xml.querySelector('sound[tempo]')?.getAttribute('tempo')) || 96,
    parts: parts.map((part, index) => ({ title: names.get(part.getAttribute('id')) || `声部 ${index + 1}`, part })),
  };
}

export function readMusicXML(source, index) {
  const { part } = source.parts[index] ?? source.parts[0];
  const measures = [...part.children].filter(child => child.localName === 'measure');
  const lanes = new Map();
  let divisions = 1;
  let offsets = 0;
  let transpose = 0;
  for (const [bar, measure] of measures.entries()) {
    let cursor = 0;
    let measureEnd = 0;
    let lastOnset = 0;
    for (const node of measure.children) {
      const tag = node.localName;
      if (tag === 'attributes') {
        divisions = Number(xmlText(node, 'divisions')) || divisions;
        if (node.querySelector('transpose')) {
          transpose = (Number(xmlText(node, 'transpose > chromatic')) || 0) +
            12 * (Number(xmlText(node, 'transpose > octave-change')) || 0);
        }
        continue;
      }
      const beats = Number(xmlText(node, 'duration')) / divisions;
      if (tag === 'backup' || tag === 'forward') {
        if (Number.isFinite(beats)) cursor = tag === 'backup' ? Math.max(0, cursor - beats) : cursor + beats;
        measureEnd = Math.max(measureEnd, cursor);
        continue;
      }
      if (tag !== 'note' || !Number.isFinite(beats) || beats <= 0) continue;
      const chord = Boolean(node.querySelector('chord'));
      const start = chord ? lastOnset : cursor;
      lastOnset = start;
      if (!chord) cursor += beats;
      measureEnd = Math.max(measureEnd, cursor, start + beats);
      const staff = Number(xmlText(node, 'staff')) || 1;
      const voice = xmlText(node, 'voice') || '1';
      const isRest = Boolean(node.querySelector('rest'));
      const step = xmlText(node, 'pitch > step');
      const octave = Number(xmlText(node, 'pitch > octave'));
      const alter = Number(xmlText(node, 'pitch > alter'));
      if (!isRest && (!/^[A-G]$/.test(step) || !Number.isInteger(octave) || !Number.isFinite(alter))) continue;
      const pitch = isRest ? null : Math.round(pitchNumber(step, octave, alter) + transpose);
      if (pitch !== null && (pitch < 0 || pitch > 127)) continue;
      const key = `${staff}:${voice}`;
      if (!lanes.has(key)) lanes.set(key, { staff, voice, notes: [], chords: false });
      const lane = lanes.get(key);
      const stops = node.querySelector('tie[type="stop"], tied[type="stop"]');
      const starts = node.querySelector('tie[type="start"], tied[type="start"]');
      const tie = stops && starts ? 'continue' : stops ? 'stop' : starts ? 'start' : null;
      const event = { pitch, beats, bar, start: offsets + start, tie };
      const previous = lane.notes.at(-1);
      if (chord && previous && previous.start === event.start) {
        lane.chords = true;
        if (pitch !== null && (previous.pitch == null || pitch > previous.pitch)) lane.notes[lane.notes.length - 1] = event;
      } else lane.notes.push(event);
    }
    offsets += measureEnd;
  }
  const sorted = [...lanes.values()].filter(lane => lane.notes.some(note => note.pitch != null))
    .sort((a, b) => a.staff - b.staff || a.voice.localeCompare(b.voice, undefined, { numeric: true }));
  const first = sorted[0];
  if (!first) throw new Error('所选声部里没有可演奏的音符。');
  const notes = [];
  let cursor = 0;
  for (const note of first.notes) {
    if (note.start > cursor + 0.005) notes.push({ pitch: null, beats: note.start - cursor, bar: note.bar });
    notes.push(note);
    cursor = Math.max(cursor, note.start + note.beats);
  }
  const notices = [];
  if (sorted.length > 1 || first.chords) notices.push('已读取所选乐器的首个旋律声部，和弦保留最高音。');
  return { notes: mergeTies(notes), notices };
}
