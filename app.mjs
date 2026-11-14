import { arrange, baseFingers, chooseShift, controlSymbol, DEMO, FINGERING_MODES, formatMelody, KINDS, LAYOUTS, mergeTies, parseMelody, pitchName } from './music.mjs?v=8';
import { scoreExport, scoreImages, tablatureText } from './score-export.mjs?v=6';
import { fileKind, MAX_FILE_BYTES, openMusicXML, openPdf, parsePages, readImage, readMusicXML, readPdfPage } from './score-files.mjs?v=9';

const $ = id => document.getElementById(id);
const input = $('file-input');
const drop = $('droparea');
const recognitionType = $('score-type');
const partSelect = $('source-part');
const editor = $('edit-dialog');
const original = $('original-dialog');
const MAX_NOTES = 1200;

function setIcon(element, name) {
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--icon', `url("./assets/${name}.svg")`);
}
document.querySelectorAll('[data-icon]').forEach(element => setIcon(element, element.dataset.icon));

let selected = null;
let task = null;
let thumbnailUrl = null;
const panelUrls = new Map();
let score = DEMO;
let arranged = [];
let shift = 0;
let audio = null;
let playback = null;
let currentNote = null;
let noteButtons = [];
let startIndex = null;
let manual = false;

function feedback(element, message, error = false) {
  if (element.id === 'upload-feedback') $('offline-help').hidden = true;
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = !message;
}

function makeNoteButton(pitch, key, beats, octaveFold, confidence) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note';
  const chip = document.createElement('span');
  chip.className = 'note-key';
  const label = document.createElement('span');
  label.className = 'note-pitch';
  const name = pitchName(pitch);
  label.textContent = pitch == null ? `休 · ${prettyBeats(beats)}` : `${name} · ${prettyBeats(beats)}`;
  const description = [name, key?.text, `${prettyBeats(beats)} 拍`, octaveFold ? '已单独移八度' : '', confidence < 0.62 ? '请校对' : ''].filter(Boolean).join('，');
  button.title = description;
  button.setAttribute('aria-label', description);
  if (pitch == null) {
    chip.textContent = '—';
    chip.classList.add('rest');
  } else if (!key) {
    chip.textContent = '!';
    chip.classList.add('unplayable');
    button.title += '，超出当前指法音域';
    button.setAttribute('aria-label', button.title);
  } else {
    chip.classList.add(`button-${key.button}`);
    if (key.controls.length) {
      const mods = document.createElement('span');
      mods.className = 'note-mods';
      mods.textContent = `${key.controls.map(controlSymbol).join('+')}+`;
      chip.append(mods);
    }
    chip.append(key.button);
  }
  if (octaveFold || confidence < 0.62) {
    const mark = document.createElement('span');
    mark.className = 'adjusted';
    mark.textContent = '*';
    mark.setAttribute('aria-hidden', 'true');
    label.append(mark);
  }
  button.append(chip, label);
  return button;
}

function prettyBeats(beats) {
  return Number(beats.toFixed(3));
}

function collectBars(notes) {
  const bars = new Map();
  for (const [index, note] of notes.entries()) {
    if (!bars.has(note.bar)) bars.set(note.bar, []);
    bars.get(note.bar).push({ note, index });
  }
  return bars;
}

function setPlaybackStart(index) {
  noteButtons[startIndex]?.setAttribute('aria-pressed', 'false');
  startIndex = index;
  noteButtons[startIndex]?.setAttribute('aria-pressed', 'true');
  $('playback-start').textContent = index === null ? '点击谱上的音符选择试听起点' : `试听从第 ${index + 1} 格开始`;
  $('reset-playback-start').hidden = index === null;
}

function renderScore({ resetFold = false } = {}) {
  stopPlayback();
  const mode = $('control-layout').value;
  const fingeringMode = $('fingering-mode').value;
  const { name, range: [low, high] } = FINGERING_MODES[fingeringMode];
  const requested = $('transposition').value;
  shift = requested === 'auto' ? chooseShift(score.notes, fingeringMode) : Number(requested);
  if (resetFold) {
    $('fold').checked = score.notes.some(({ pitch }) => pitch != null && (pitch + shift < low || pitch + shift > high));
  }
  arranged = arrange(score.notes, { mode, shift, fingeringMode, fold: $('fold').checked });
  $('score-kind').textContent = score.kind === 'demo' ? '示例' : KINDS[score.kind];
  $('score-name').textContent = score.title;
  const bars = collectBars(arranged);
  const outOfRange = arranged.filter(note => note.pitch != null && !note.key).length;
  const folded = arranged.filter(note => note.octaveFold).length;
  const uncertain = arranged.some(note => note.confidence < 0.62);
  const offset = shift === 0 ? '原调' : `${shift > 0 ? '+' : '−'}${Math.abs(shift)} 半音`;
  $('score-meta').textContent = `${bars.size} 小节 · ${arranged.filter(note => note.pitch != null).length} 个音符 · ${offset} · ${LAYOUTS[mode].name}布局 · ${name}指法`;

  const rowElements = [];
  noteButtons = [];
  let position = 0;
  for (const group of bars.values()) {
    const row = document.createElement('div');
    row.className = 'bar';
    const barNumber = document.createElement('span');
    barNumber.className = 'bar-index';
    barNumber.textContent = String(++position).padStart(2, '0');
    barNumber.setAttribute('aria-label', `第 ${position} 小节`);
    const notes = document.createElement('div');
    notes.className = 'notes';
    for (const { note, index } of group) {
      const key = makeNoteButton(note.target, note.key, note.beats, note.octaveFold, note.confidence);
      key.setAttribute('aria-pressed', String(index === startIndex));
      key.addEventListener('click', () => {
        stopPlayback();
        setPlaybackStart(index);
        if (note.key) void playSingle(note.target, key);
      });
      noteButtons[index] = key;
      notes.append(key);
    }
    row.append(barNumber, notes);
    rowElements.push(row);
  }
  $('bars').replaceChildren(...rowElements);
  const messages = [...(score.notices ?? [])];
  if (outOfRange) messages.push(`${outOfRange} 个音超出当前指法音域，可在演奏设置中调整移调或八度。试听时这些音保留为停顿。`);
  if (folded || uncertain) messages.push(`* 标记${[folded ? `已移八度的 ${folded} 个音` : '', uncertain ? '需要校对的音' : ''].filter(Boolean).join('和')}。`);
  $('result-feedback').textContent = messages.join(' ');
  $('result-feedback').hidden = !messages.length;
  feedback($('export-feedback'), '');
}

function showScore(result, scroll = true, keepSettings = false) {
  score = result;
  setPlaybackStart(null);
  if (!keepSettings) {
    $('tempo').value = Math.min(240, Math.max(30, Math.round(result.tempo || 96)));
    $('transposition').value = 'auto';
  }
  renderScore({ resetFold: !keepSettings });
  $('bars').scrollTop = 0;
  if (scroll && matchMedia('(max-width: 770px)').matches) $('result').scrollIntoView({ block: 'start' });
}

function renderGuide() {
  const mode = $('control-layout').value;
  const { range: [low, high], allowCombined } = FINGERING_MODES[$('fingering-mode').value];
  const buttons = baseFingers(mode).map(key => {
    const button = makeNoteButton(key.pitch, key, 1, false);
    button.querySelector('.note-pitch').textContent = pitchName(key.pitch);
    button.addEventListener('click', () => {
      stopPlayback();
      void playSingle(key.pitch, button);
    });
    return button;
  });
  $('base-notes').replaceChildren(...buttons);
  $('pad-guide').textContent = mode === 'classic' ? 'L 升音 / ZL 降音' : '十字键 ↑ / ↓';
  $('combined-guide').hidden = $('combined-semitones').hidden = !allowCombined;
  $('range-low').textContent = pitchName(low);
  $('range-high').textContent = pitchName(high);
}

const shiftSelect = $('transposition');
for (let offset = -48; offset <= 48; offset++) {
  if (!offset) continue;
  shiftSelect.add(new Option(`${offset > 0 ? '+' : '−'}${Math.abs(offset)} 半音`, String(offset)));
}
for (const id of ['control-layout', 'fingering-mode', 'transposition', 'fold']) {
  $(id).addEventListener('change', () => {
    if (id === 'control-layout' || id === 'fingering-mode') renderGuide();
    renderScore();
  });
}
$('tempo').addEventListener('change', () => { $('tempo').value = getTempo(); stopPlayback(); });
const arrangeOptions = $('arrange-options');
document.addEventListener('pointerdown', event => {
  if (arrangeOptions.open && !arrangeOptions.contains(event.target)) arrangeOptions.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && arrangeOptions.open) arrangeOptions.open = false;
});

function getTempo() {
  return Math.min(240, Math.max(30, Number($('tempo').value) || score.tempo || 96));
}

async function audioContext() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('当前浏览器不支持试听。');
  audio ??= new Audio();
  if (audio.state !== 'running') await audio.resume();
  return audio;
}

function sound(context, pitch, when, seconds) {
  const fundamental = context.createOscillator();
  const overtone = context.createOscillator();
  const soft = context.createGain();
  const envelope = context.createGain();
  const pitchHz = 440 * 2 ** ((pitch - 69) / 12);
  const end = when + Math.max(0.05, seconds);
  fundamental.frequency.value = pitchHz;
  overtone.frequency.value = pitchHz * 2;
  soft.gain.value = 0.1;
  fundamental.connect(envelope);
  overtone.connect(soft).connect(envelope);
  envelope.connect(context.destination);
  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.exponentialRampToValueAtTime(0.185, when + 0.024);
  envelope.gain.setValueAtTime(0.17, Math.max(when + 0.028, end - 0.05));
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
  for (const oscillator of [fundamental, overtone]) {
    oscillator.start(when);
    oscillator.stop(end + 0.01);
  }
  fundamental.onended = () => envelope.disconnect();
  return { fundamental, overtone, envelope };
}

function active(button, scroll = false) {
  if (button === currentNote) return;
  currentNote?.classList.remove('active');
  button?.classList.add('active');
  currentNote = button;
  if (scroll && button) {
    const list = $('bars');
    const bounds = button.getBoundingClientRect();
    const section = list.getBoundingClientRect();
    if (bounds.bottom > section.bottom) list.scrollTop += bounds.bottom - section.bottom + 8;
    if (bounds.top < section.top) list.scrollTop -= section.top - bounds.top + 6;
  }
}

function setPlaying(playing) {
  const button = $('play');
  setIcon(button.querySelector('.icon'), playing ? 'square' : 'play');
  button.querySelector('span').textContent = playing ? '停止' : '试听';
  button.setAttribute('aria-pressed', String(playing));
}

function stopPlayback() {
  const previous = playback;
  playback = null;
  if (previous) {
    cancelAnimationFrame(previous.frame);
    clearTimeout(previous.timer);
    for (const nodes of previous.voices) {
      try { nodes.fundamental.stop(); nodes.overtone.stop(); } catch {}
      nodes.envelope.disconnect();
    }
  }
  active(null);
  setPlaying(false);
}

async function playSingle(pitch, button) {
  const state = { voices: [] };
  playback = state;
  try {
    const context = await audioContext();
    if (playback !== state) return;
    active(button);
    state.voices.push(sound(context, pitch, context.currentTime + 0.015, 0.42));
    state.timer = setTimeout(stopPlayback, 460);
  } catch (error) {
    if (playback === state) {
      stopPlayback();
      feedback($('export-feedback'), error.message, true);
    }
  }
}

$('reset-playback-start').addEventListener('click', () => {
  stopPlayback();
  setPlaybackStart(null);
  $('bars').scrollTop = 0;
  $('play').focus();
});

$('play').addEventListener('click', async () => {
  if (playback?.song) { stopPlayback(); return; }
  stopPlayback();
  const state = { voices: [], song: true };
  const first = startIndex ?? 0;
  playback = state;
  setPlaying(true);
  try {
    const context = await audioContext();
    if (playback !== state) return;
    const secondsPerBeat = 60 / getTempo();
    let time = context.currentTime + 0.065;
    const timeline = arranged.slice(first).map(note => {
      const start = time;
      time += note.beats * secondsPerBeat;
      return { start, end: time, note };
    });
    let nextAudio = 0;
    let activeIndex = -1;
    const schedule = () => {
      const now = context.currentTime;
      while (nextAudio < timeline.length && timeline[nextAudio].start <= now + 0.22) {
        const { start, end, note } = timeline[nextAudio++];
        if (note.key && end > now) {
          const begin = Math.max(now, start);
          const voice = sound(context, note.target, begin, (end - begin) * 0.9);
          state.voices.push(voice);
          const cleanup = voice.fundamental.onended;
          voice.fundamental.onended = () => {
            cleanup();
            state.voices = state.voices.filter(item => item !== voice);
          };
        }
      }
      state.timer = setTimeout(schedule, 42);
    };
    const highlight = () => {
      const now = context.currentTime;
      while (activeIndex + 1 < timeline.length && timeline[activeIndex + 1].start <= now) activeIndex++;
      if (now >= time + 0.12) { stopPlayback(); return; }
      if (activeIndex >= 0) active(noteButtons[first + activeIndex], true);
      state.frame = requestAnimationFrame(highlight);
    };
    schedule();
    highlight();
  } catch (error) {
    if (playback === state) {
      stopPlayback();
      feedback($('export-feedback'), error.message, true);
    }
  }
});

function exportSource() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  return scoreExport(score.title, collectBars(arranged), {
    mode: $('control-layout').value, fingeringMode: $('fingering-mode').value, tempo: getTempo(), url: url.href,
  });
}

function exportName(title) {
  return `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 90)}-时之笛按键谱`;
}

$('copy').addEventListener('click', async () => {
  const content = tablatureText(exportSource());
  try {
    if (!navigator.clipboard) throw new Error();
    await navigator.clipboard.writeText(content);
    feedback($('export-feedback'), '已复制按键谱。');
  } catch {
    const text = document.createElement('textarea');
    text.value = content;
    text.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(text);
    text.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    text.remove();
    $('copy').focus();
    feedback($('export-feedback'), copied ? '已复制按键谱。' : '浏览器无法访问剪贴板，请使用下载。', !copied);
  }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadText(withBeats) {
  const source = exportSource();
  const suffix = withBeats ? '-带拍数' : '';
  const content = tablatureText(source, { withBeats });
  downloadBlob(new Blob(['\uFEFF', content], { type: 'text/plain;charset=utf-8' }), `${exportName(source.title)}${suffix}.txt`);
}

$('download').addEventListener('click', () => downloadText(false));
$('download-with-beats').addEventListener('click', () => downloadText(true));

const imageDialog = $('image-export-dialog');
const imagePages = $('image-export-pages');
$('close-image-export').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('close', () => imagePages.replaceChildren());
$('export-image').addEventListener('click', async () => {
  const button = $('export-image');
  const source = exportSource();
  button.disabled = true;
  try {
    await document.fonts?.ready;
    const images = scoreImages(source);
    const name = exportName(source.title);
    if (images.count === 1) {
      downloadBlob(await images.render(0), `${name}.png`);
    } else {
      for (let page = 0; page < images.count; page++) {
        const pageButton = document.createElement('button');
        pageButton.className = 'button secondary';
        pageButton.type = 'button';
        pageButton.textContent = `第 ${page + 1} 页 PNG`;
        pageButton.addEventListener('click', async () => {
          const buttons = [...imagePages.children];
          buttons.forEach(item => { item.disabled = true; });
          feedback($('image-export-feedback'), '');
          try {
            downloadBlob(await images.render(page), `${name}-${page + 1}.png`);
          } catch {
            feedback($('image-export-feedback'), '无法生成此页图片，请重试。', true);
          } finally {
            buttons.forEach(item => { item.disabled = false; });
          }
        });
        imagePages.append(pageButton);
      }
      feedback($('image-export-feedback'), '');
      imageDialog.showModal();
    }
  } catch {
    feedback($('export-feedback'), '无法生成图片，请重试。', true);
  } finally {
    button.disabled = false;
  }
});

function freePanel(container) {
  for (const url of panelUrls.get(container) ?? []) URL.revokeObjectURL(url);
  panelUrls.delete(container);
  container.replaceChildren();
}

function showOriginal(container, pages) {
  freePanel(container);
  const urls = [];
  for (const page of pages) {
    const image = new Image();
    image.alt = page.number ? `原谱第 ${page.number} 页` : '上传的原谱';
    image.src = URL.createObjectURL(page.blob);
    urls.push(image.src);
    if (page.number) {
      const label = document.createElement('p');
      label.textContent = `第 ${page.number} 页`;
      container.append(label);
    }
    container.append(image);
  }
  panelUrls.set(container, urls);
}

function openEditor(empty) {
  stopPlayback();
  manual = empty;
  $('edit-heading').textContent = empty ? '手动输入乐谱' : '校对音符';
  $('edit-title').value = empty ? '' : score.title;
  $('edit-notes').value = empty ? '' : formatMelody(score.notes);
  $('editor-original').hidden = empty || !score.original?.length;
  $('editor-image').hidden = true;
  feedback($('edit-feedback'), '');
  editor.showModal();
  $('edit-notes').focus();
}
$('manual-button').addEventListener('click', () => openEditor(true));
$('edit-score').addEventListener('click', () => openEditor(false));
$('close-editor').addEventListener('click', () => editor.close());
$('close-original').addEventListener('click', () => original.close());
editor.addEventListener('close', () => freePanel($('editor-image')));
original.addEventListener('close', () => freePanel($('original-image')));
$('editor-original').addEventListener('click', () => {
  const container = $('editor-image');
  if (!container.hidden) { container.hidden = true; freePanel(container); return; }
  showOriginal(container, score.original);
  container.hidden = false;
});
$('editor').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const notes = parseMelody($('edit-notes').value);
    const title = $('edit-title').value.trim() || '未命名乐谱';
    const updated = { title, notes, kind: 'manual', tempo: manual ? 96 : getTempo(), original: manual ? [] : score.original };
    editor.close();
    showScore(updated, true, !manual);
  } catch (error) { feedback($('edit-feedback'), error.message, true); }
});

function canvasPreview(canvas, number) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve({ blob, number }) : reject(new Error('无法生成原谱预览。')), 'image/webp', 0.91);
  });
}

function renderSourceOptions() {
  const audioFile = selected?.kind === 'audio';
  const visual = selected?.kind !== 'xml' && !audioFile;
  recognitionType.hidden = $('score-type-label').hidden = audioFile;
  recognitionType.disabled = !visual || Boolean(task);
  $('audio-hint').hidden = !audioFile;
  $('key-control').hidden = !visual || recognitionType.value === 'staff' ||
    (!selected && recognitionType.value !== 'numbered');
  $('pdf-control').hidden = selected?.kind !== 'pdf';
  const parts = selected?.parts ?? [];
  $('part-control').hidden = parts.length <= 1;
  const value = Math.min(Number(partSelect.value), parts.length - 1);
  partSelect.replaceChildren(...parts.map((name, index) => new Option(name, String(index))));
  partSelect.value = String(Math.max(0, value));
  $('part-label').textContent = selected?.kind === 'xml' ? '旋律声部' : '读取声部';
  $('pdf-page-count').textContent = selected?.pdf ? `共 ${selected.pdf.numPages} 页` : '';
  $('convert-button').hidden = !selected;
  $('convert-label').textContent = audioFile ? '提取旋律并转谱' : '识别并转谱';
  $('convert-button').disabled = !selected?.ready || Boolean(task);
  $('progress').hidden = !task;
  for (const id of ['jianpu-key', 'source-part', 'pdf-pages', 'demo-button']) $(id).disabled = Boolean(task);
}

function releaseSelected() {
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl = null;
  $('thumbnail').removeAttribute('src');
  $('thumbnail').hidden = true;
  $('open-original').querySelector('.icon').hidden = false;
  selected?.pdf?.destroy().catch(() => {});
  selected = null;
}

function clearFile() {
  cancelTask(false);
  releaseSelected();
  input.value = '';
  $('selected-file').hidden = true;
  drop.hidden = false;
  feedback($('upload-feedback'), '');
  renderSourceOptions();
}

function partNames(count) {
  return Array.from({ length: count }, (_, index) => index === 0 ? '最上方声部' : `从上数第 ${index + 1} 个声部`);
}

async function stageFile(file) {
  if (!file) return;
  const kind = fileKind(file);
  if (!kind || file.size === 0 || file.size > MAX_FILE_BYTES) {
    feedback($('upload-feedback'), !kind ? '请选择常见图片、PDF、MusicXML 或音频文件。' :
      file.size === 0 ? '文件为空，请重新选择。' : '单个文件最大 25 MB，请压缩或分段后重试。', true);
    return;
  }
  cancelTask(false);
  releaseSelected();
  const source = { file, kind, ready: false, preview: [], parts: [] };
  selected = source;
  $('file-name').textContent = file.name;
  const kindName = { pdf: 'PDF', xml: 'MusicXML', heic: 'HEIC', image: '图片', audio: '音频' }[kind];
  $('file-meta').textContent = `${kindName} · ${file.size >= 1024 * 1024 ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : Math.ceil(file.size / 1024) + ' KB'}`;
  $('open-original').disabled = true;
  const originalIcon = $('open-original').querySelector('.icon');
  setIcon(originalIcon, kind === 'audio' ? 'music-2' : 'image');
  $('pdf-pages').value = '1';
  $('selected-file').hidden = false;
  drop.hidden = true;
  feedback($('upload-feedback'), kind === 'audio' ? '' : '正在打开原谱…');
  renderSourceOptions();
  try {
    if (kind === 'xml') {
      source.xml = openMusicXML(await file.text());
      source.parts = source.xml.parts.map(part => part.title);
    } else if (kind === 'pdf') {
      source.pdf = await openPdf(file);
      if (selected !== source) { await source.pdf.destroy(); return; }
      source.preview = [await canvasPreview(await readPdfPage(source.pdf, 1, 950), 1)];
    } else if (kind !== 'audio') {
      source.canvas = await readImage(file, kind);
      source.preview = [await canvasPreview(source.canvas)];
    }
    if (selected !== source) return;
    if (source.preview.length) {
      thumbnailUrl = URL.createObjectURL(source.preview[0].blob);
      $('thumbnail').src = thumbnailUrl;
      $('thumbnail').hidden = false;
      $('open-original').querySelector('.icon').hidden = true;
      $('open-original').disabled = false;
    }
    source.ready = true;
    feedback($('upload-feedback'), '');
    renderSourceOptions();
  } catch (error) {
    if (selected === source) feedback($('upload-feedback'), error.message || '文件打开失败。', true);
  }
}

$('choose-file').addEventListener('click', () => input.click());
$('replace-file').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const [file] = input.files;
  input.value = '';
  void stageFile(file);
});
$('clear-file').addEventListener('click', clearFile);
for (const area of [drop, $('selected-file')]) {
  area.addEventListener('dragover', event => { event.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', event => {
    event.preventDefault();
    area.classList.remove('drag-over');
    const files = event.dataTransfer.files;
    if (files.length > 1) {
      feedback($('upload-feedback'), '每次可处理一份文件。多页乐谱可合并为 PDF。', true);
      return;
    }
    void stageFile(files[0]);
  });
}
$('open-original').addEventListener('click', () => {
  if (!selected?.preview.length) return;
  showOriginal($('original-image'), selected.preview);
  original.showModal();
});
recognitionType.addEventListener('change', () => {
  if (selected) selected.parts = [];
  renderSourceOptions();
});

function progress(run, label, ratio) {
  if (task !== run) return;
  clearTimeout(run.deadline);
  run.deadline = setTimeout(() => {
    if (task !== run) return;
    cancelTask(false);
    feedback($('upload-feedback'), '识谱超时，请检查网络后重试。也可手动输入乐谱。', true);
  }, 100000);
  $('progress-text').textContent = label;
  if (ratio == null) $('progress-bar').removeAttribute('value');
  else $('progress-bar').value = Math.min(1, Math.max(run.progress ?? 0, ratio));
  run.progress = $('progress-bar').value;
}

function openStaffWorker(run) {
  return new Promise(resolve => {
    let worker;
    try {
      worker = new Worker(new URL('./staff-worker.mjs?v=12', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const fallback = () => {
      cleanup();
      worker.terminate();
      resolve(null);
    };
    const ready = ({ data }) => {
      if (!data.ready) return;
      cleanup();
      run.staff = worker;
      resolve(worker);
    };
    const timer = setTimeout(fallback, 3500);
    const cleanup = () => {
      clearTimeout(timer);
      run.controller.signal.removeEventListener('abort', fallback);
      worker.removeEventListener('error', fallback);
      worker.removeEventListener('message', ready);
    };
    run.controller.signal.addEventListener('abort', fallback, { once: true });
    worker.addEventListener('error', fallback, { once: true });
    worker.addEventListener('message', ready);
  });
}

function processStaffWorker(worker, page, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.removeEventListener('message', message);
      worker.removeEventListener('error', error);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const error = () => { cleanup(); reject(new Error('识谱线程连接中断。')); };
    const message = ({ data: response }) => {
      if (response.progress) { onProgress(response.progress, response.ratio); return; }
      cleanup();
      if (response.error) reject(new Error(response.error));
      else resolve(response.result);
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', message);
    worker.addEventListener('error', error);
    worker.postMessage(page);
  });
}

async function staffPage(run, canvas, part, fifths, label, base, weight) {
  const signal = run.controller.signal;
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const page = { data, width, height, part, fifths };
  const onProgress = (message, ratio) => progress(run, label + message, base + weight * ratio);
  if (!run.staffReady) onProgress('正在载入五线谱识别程序…', 0.08);
  run.staffReady ??= openStaffWorker(run);
  const worker = await run.staffReady;
  signal.throwIfAborted();
  if (worker) {
    try {
      return await processStaffWorker(worker, page, signal, onProgress);
    } catch (error) {
      signal.throwIfAborted();
      worker.terminate();
      run.staff = null;
      run.staffReady = Promise.resolve(null);
      console.warn('Staff recognition worker:', error.message);
    }
  }
  onProgress('正在载入五线谱识别程序…', 0.08);
  try {
    const { recognizeStaff } = await raceAbort(import('./staff-engine.mjs?v=12'), signal);
    return await raceAbort(recognizeStaff(page, onProgress, signal), signal);
  } catch (error) {
    signal.throwIfAborted();
    console.warn('Staff recognition:', error.message);
    throw new Error('五线谱识别组件加载失败。请刷新网页，或检查网络后再试。');
  }
}

function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function recognizeImages(run, source, part, type, key, pages) {
  const signal = run.controller.signal;
  const previews = [];
  const notices = new Set();
  const notes = [];
  let partCount = 0;
  let unreadPages = 0;
  const kinds = new Set();
  let jianpu;
  let currentPageLabel = '';
  let currentBase = 0;
  const weight = 0.95 / pages.length;
  let knownKey = key;
  let fifths = 0;
  for (const [index, page] of pages.entries()) {
    signal.throwIfAborted();
    const label = page ? `第 ${page} 页 · ` : '';
    const base = index * weight;
    currentPageLabel = label;
    currentBase = base;
    progress(run, label + (page ? '正在渲染 PDF 谱面…' : '正在分析谱面…'), base + weight * 0.035);
    const canvas = page ? await readPdfPage(source.pdf, page) : source.canvas;
    signal.throwIfAborted();
    previews.push(page ? await canvasPreview(canvas, page) : source.preview[0]);
    let recognized;
    let staffDetected = false;
    if (type !== 'numbered') {
      const result = await staffPage(run, canvas, part, fifths, label, base, weight);
      staffDetected = result.parts > 0;
      partCount = Math.max(partCount, result.parts);
      if (result.notes.some(note => note.pitch != null)) {
        fifths = result.fifths;
        recognized = result;
        kinds.add('staff');
        if (result.parts > 1) notices.add('已按所选声部读取，请校对旋律。');
        if (result.unread || result.missing || result.wide) notices.add('有部分符号或谱行需校对。');
      } else if (result.parts) {
        if (result.parts > 1) source.parts = partNames(partCount);
        if (part >= result.parts) notices.add('部分页面没有所选声部。');
      }
    }
    if (!recognized && (type === 'numbered' || (type === 'auto' && !staffDetected))) {
      jianpu ??= await import('./jianpu.mjs?v=10');
      run.tesseract ??= await jianpu.makeTextRecognizer(signal, (message, ratio) => {
        progress(run, currentPageLabel + message, currentBase + weight * ratio);
      });
      recognized = await raceAbort(jianpu.recognizeJianpu(canvas, run.tesseract, signal, knownKey, part), signal);
      partCount = Math.max(partCount, recognized.parts);
      if (recognized.key) knownKey = recognized.key;
      if (recognized.notes.some(note => note.pitch != null)) kinds.add('numbered');
    }
    if (!recognized?.notes.some(note => note.pitch != null)) {
      unreadPages++;
      continue;
    }
    const offset = (notes.at(-1)?.bar ?? -1) + 1;
    notes.push(...recognized.notes.map(note => ({ ...note, bar: note.bar + offset })));
    for (const notice of recognized.notices ?? []) notices.add(notice);
    if (notes.length > MAX_NOTES) throw new Error('识别结果超过 1200 个音符，请分段转换。');
  }
  source.parts = partNames(partCount);
  if (!notes.length) throw new Error(type === 'numbered' ? '未读到连续的简谱数字。请裁剪出清晰的主旋律，或改用手动输入。' :
    '未能读出可用旋律。请检查识谱方式与声部，或裁剪出清晰的单行主旋律。');
  if (unreadPages) notices.add(`所选页面中有 ${unreadPages} 页没有读到旋律。`);
  if (kinds.has('staff')) notices.add('五线谱识别适用于清晰的印刷谱，请检查音高与节奏。');
  return { notes: mergeTies(notes), original: previews, kind: kinds.has('staff') ? 'staff' : 'numbered', notices: [...notices] };
}

function disposeTask(run) {
  clearTimeout(run.deadline);
  run.staff?.terminate();
  run.audioWorker?.terminate();
  run.tesseract?.terminate().catch(() => {});
}

async function recognizeAudio(run, file) {
  const { signal } = run.controller;
  const { readAudio } = await import('./audio-files.mjs?v=8');
  signal.throwIfAborted();
  progress(run, '正在解码音频…', 0.08);
  const samples = await raceAbort(readAudio(file, signal), signal);
  progress(run, '正在提取旋律…', 0.18);
  const worker = new Worker(new URL('./audio-worker.mjs?v=8', import.meta.url), { type: 'module' });
  run.audioWorker = worker;
  return raceAbort(new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      else if (data.result) resolve(data.result);
      else progress(run, '正在提取旋律…', 0.18 + 0.8 * data.progress);
    };
    worker.onerror = () => reject(new Error('音频识别组件加载失败，请刷新页面后重试。'));
    worker.postMessage(samples, [samples.buffer]);
  }), signal);
}

function cancelTask(notice = true) {
  if (!task) return;
  const run = task;
  task = null;
  run.controller.abort();
  disposeTask(run);
  if (notice) feedback($('upload-feedback'), '已取消识别。');
  renderSourceOptions();
}

$('cancel-recognition').addEventListener('click', () => cancelTask());
$('convert-button').addEventListener('click', async () => {
  if (!selected?.ready || task) return;
  const source = selected;
  const part = Number(partSelect.value || 0);
  const type = recognitionType.value;
  const key = $('jianpu-key').value;
  const run = { controller: new AbortController() };
  task = run;
  try {
    feedback($('upload-feedback'), '');
    renderSourceOptions();
    progress(run, source.kind === 'audio' ? '准备读取音频…' : '准备识别乐谱…');
    const title = source.file.name.replace(/\.[^.]+$/, '').slice(0, 100) || '未命名乐谱';
    let result;
    if (source.kind === 'audio') {
      const parsed = await recognizeAudio(run, source.file);
      result = { ...parsed, kind: 'audio', title, notices: ['时值按录音估算，小节按时间分组。可试听并校对音高和拍数。'] };
    } else if (source.kind === 'xml') {
      const parsed = readMusicXML(source.xml, part);
      result = { ...parsed, kind: 'xml', title: source.xml.title || title, tempo: source.xml.tempo };
    } else {
      const pages = source.pdf ? parsePages($('pdf-pages').value, source.pdf.numPages) : [0];
      result = { ...await recognizeImages(run, source, part, type, key, pages), title, tempo: 96 };
    }
    if (task !== run || run.controller.signal.aborted) return;
    if (result.notes.length > MAX_NOTES) throw new Error('识别结果超过 1200 个音符，请分段转换。');
    if (result.original?.length) source.preview = result.original;
    showScore(result);
    feedback($('upload-feedback'), '转换完成，可在按键谱中校对。');
  } catch (error) {
    if (task === run) {
      feedback($('upload-feedback'), error.message || '识谱失败，请重试。', true);
      $('offline-help').hidden = error.name !== 'OcrLoadError';
    }
  } finally {
    disposeTask(run);
    if (task === run) {
      task = null;
      renderSourceOptions();
    }
  }
});

$('demo-button').addEventListener('click', () => showScore(DEMO));
renderSourceOptions();
renderGuide();
showScore(DEMO, false);
