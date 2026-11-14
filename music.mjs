const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const CHROMATIC = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const ROOTS = [62, 65, 69, 71, 74];

export const FINGERING_MODES = {
  simple: { name: '简易', range: [60, 76], allowCombined: false },
  full: { name: '完整', range: [59, 77], allowCombined: true },
};
export const LAYOUTS = {
  normal: { name: '标准', buttons: ['L', 'R', 'A', 'Y', 'X'], up: '十字键 ↑', down: '十字键 ↓' },
  classic: { name: '经典', buttons: ['R', 'B', 'A', 'X', 'Y'], up: 'L', down: 'ZL' },
};
export const KINDS = { staff: '五线谱', numbered: '数字简谱', xml: 'MusicXML', manual: '手动输入' };

const steps = [
  { pad: 0, stick: 0 }, { pad: 1, stick: 0 }, { pad: -1, stick: 0 },
  { pad: 0, stick: 2 }, { pad: 0, stick: -2 }, { pad: 1, stick: 2 }, { pad: -1, stick: -2 },
];
const fingerings = new Map();
for (const [difficulty, mod] of steps.entries()) {
  for (const [root, pitch] of ROOTS.entries()) {
    const target = pitch + mod.pad + mod.stick;
    if (!fingerings.has(target)) fingerings.set(target, { root, difficulty: [0, 1, 1, 2, 2, 5, 5][difficulty], ...mod });
  }
}

export function fingering(pitch, mode = 'normal', fingeringMode = 'simple') {
  const shape = fingerings.get(pitch);
  if (!shape || (!FINGERING_MODES[fingeringMode].allowCombined && shape.pad && shape.stick)) return null;
  const layout = LAYOUTS[mode] ?? LAYOUTS.normal;
  const controls = [];
  if (shape.pad) controls.push(shape.pad > 0 ? layout.up : layout.down);
  if (shape.stick) controls.push(shape.stick > 0 ? '左摇杆 ↑' : '左摇杆 ↓');
  const button = layout.buttons[shape.root];
  return { button, controls, text: [...controls, button].join(' + ') };
}

export function controlSymbol(control) {
  return control.replace('十字键 ', '').replace('左摇杆 ', '摇');
}

export function pitchName(midi) {
  if (midi == null) return '休止';
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function pitchNumber(step, octave = 4, alter = 0) {
  return 12 * (octave + 1) + NATURAL[step.toUpperCase()] + alter;
}

function accidental(value = '') {
  return [...value].reduce((count, sign) => count + (sign === '#' || sign === '♯' ? 1 : -1), 0);
}

export function rootPitch(key) {
  const [, step, alter, octave] = /([A-Ga-g])([#♯b♭]?)(-?\d)?/.exec(key) ?? [];
  return step ? pitchNumber(step, octave == null ? 4 : Number(octave), accidental(alter)) : 60;
}

export function degreePitch(degree, root, octave = 0, alter = 0) {
  return degree === 0 ? null : root + MAJOR[degree - 1] + octave * 12 + alter;
}

export function parseMelody(input, defaultKey = 'C4') {
  const text = input.normalize('NFKC').replaceAll('。', '.').replaceAll('｜', '|')
    .replaceAll('−', '-').replaceAll('’', "'").replaceAll('，', ',');
  const key = /(?:^|\s)1\s*=\s*([A-Ga-g][#♯b♭]?-?\d?)/.exec(text);
  const root = rootPitch(key?.[1] || defaultKey);
  const content = text.replace(/(?:^|\s)1\s*=\s*[A-Ga-g][#♯b♭]?-?\d?(?=\s|\||$)/g, ' ');
  const tokens = content.replace(/\|+/g, ' | ').trim().split(/\s+/u).filter(Boolean);
  const notes = [];
  let bar = 0;
  for (const token of tokens) {
    if (token === '|') {
      if (notes.at(-1)?.bar === bar) bar++;
      continue;
    }
    const [name, length, ...extra] = token.split(':');
    const beats = length === undefined ? 1 : Number(length);
    if (extra.length || !Number.isFinite(beats) || beats < 0.01 || beats > 128) {
      throw new Error(`「${token}」的拍数应在 0.01 至 128 之间。`);
    }
    if (/^[-—–]$/.test(name) && notes.length) {
      notes.at(-1).beats += beats;
      continue;
    }
    const letter = /^([a-g])([#♯b♭]{0,2})(-?\d)$/i.exec(name);
    const digit = /^([#♯b♭]?)([0-7])([',]*)$/.exec(name);
    let pitch = null;
    if (letter) pitch = pitchNumber(letter[1], Number(letter[3]), accidental(letter[2]));
    else if (digit) {
      const octaves = [...digit[3]].reduce((sum, mark) => sum + (mark === "'" ? 1 : -1), 0);
      pitch = degreePitch(Number(digit[2]), root, octaves, accidental(digit[1]));
    } else if (!/^[zrR]$/i.test(name)) {
      throw new Error(`无法读取「${token}」。请用 C4、F♯4、1、0 或 | 等格式输入，以空格分隔。`);
    }
    if (pitch !== null && (pitch < 0 || pitch > 127)) throw new Error(`「${token}」超出可编辑的音域。`);
    notes.push({ pitch, beats, bar });
    if (notes.length > 1200) throw new Error('一份按键谱最多 1200 个音符，请分段转换。');
  }
  if (!notes.some(note => note.pitch != null)) throw new Error('请至少输入一个音符。');
  return notes;
}

export function formatMelody(notes) {
  return notes.map((note, index) => {
    const label = note.pitch == null ? '0' : pitchName(note.pitch);
    const duration = Number(note.beats.toFixed(3));
    const value = duration === 1 ? label : `${label}:${duration}`;
    return index > 0 && notes[index - 1].bar !== note.bar ? `| ${value}` : value;
  }).join(' ');
}

export function mergeTies(notes) {
  const merged = [];
  let pending = false;
  for (const note of notes) {
    const last = merged.at(-1);
    if (pending && last?.pitch != null && last.pitch === note.pitch && /^(continue|stop)$/.test(note.tie)) {
      last.beats += note.beats;
      last.confidence = Math.min(last.confidence ?? 1, note.confidence ?? 1);
    } else {
      merged.push({ ...note });
    }
    pending = /^(continue|start)$/.test(note.tie);
  }
  return merged;
}

function foldPitch(pitch, [low, high]) {
  if (pitch < low) return pitch + 12 * Math.ceil((low - pitch) / 12);
  if (pitch > high) return pitch - 12 * Math.ceil((pitch - high) / 12);
  return pitch;
}

export function chooseShift(notes, fingeringMode = 'simple') {
  const live = notes.filter(note => note.pitch != null);
  if (!live.length) return 0;
  const pitches = live.map(note => note.pitch);
  const range = FINGERING_MODES[fingeringMode].range;
  const [low, high] = range;
  const start = low - Math.max(...pitches);
  const end = high - Math.min(...pitches);
  let bestCost = Infinity;
  let bestShift = 0;
  for (let shift = start; shift <= end; shift++) {
    let cost = Math.abs(shift) * 0.016 + (shift % 12 === 0 ? 0 : 0.22);
    for (const pitch of pitches) {
      const target = pitch + shift;
      const fit = target >= low && target <= high ? fingerings.get(target) : null;
      cost += fit ? fit.difficulty / pitches.length : 12 + Math.abs(foldPitch(target, range) - target) * 0.01;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  return bestShift;
}

export function arrange(notes, { shift, mode, fold, fingeringMode = 'simple' }) {
  const range = FINGERING_MODES[fingeringMode].range;
  return notes.map(note => {
    if (note.pitch == null) return { ...note, target: null, key: null, octaveFold: false };
    const shifted = note.pitch + shift;
    const target = fold ? foldPitch(shifted, range) : shifted;
    return { ...note, target, key: fingering(target, mode, fingeringMode), octaveFold: shifted !== target };
  });
}

export function baseFingers(mode) {
  return ROOTS.map(pitch => ({ pitch, ...fingering(pitch, mode) }));
}

export const DEMO = {
  title: '塞尔达摇篮曲',
  notes: parseMelody('B4 D5 A4:2 | B4 D5 A4:2'),
  tempo: 76,
  kind: 'demo',
  notices: [],
};
