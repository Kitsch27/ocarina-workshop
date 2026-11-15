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
export const KINDS = { staff: '五线谱', numbered: '数字简谱', xml: 'MusicXML', audio: '音频', manual: '手动输入' };

const steps = [
  { pad: 0, stick: 0 }, { pad: 1, stick: 0 }, { pad: -1, stick: 0 },
  { pad: 0, stick: 2 }, { pad: 0, stick: -2 }, { pad: 1, stick: 2 }, { pad: -1, stick: -2 },
];
const fingerings = new Map();
for (const [difficulty, mod] of steps.entries()) {
  for (const [root, pitch] of ROOTS.entries()) {
    const target = pitch + mod.pad + mod.stick;
    if (!fingerings.has(target)) fingerings.set(target, []);
    fingerings.get(target).push({ target, root, difficulty: [0, 1, 1, 2, 2, 5, 5][difficulty], ...mod });
  }
}

const fingeringChoices = Object.fromEntries(Object.entries(FINGERING_MODES).map(([name, { allowCombined }]) => {
  const byPitch = new Map();
  const byPitchClass = Array.from({ length: 12 }, () => []);
  for (const [pitch, shapes] of fingerings) {
    const playable = allowCombined ? shapes : shapes.filter(shape => !shape.pad || !shape.stick);
    if (!playable.length) continue;
    byPitch.set(pitch, playable);
    byPitchClass[pitch % 12].push(...playable);
  }
  return [name, { byPitch, byPitchClass }];
}));

function describeFingering(shape, layout) {
  const controls = [];
  if (shape.pad) controls.push(shape.pad > 0 ? layout.up : layout.down);
  if (shape.stick) controls.push(shape.stick > 0 ? '左摇杆 ↑' : '左摇杆 ↓');
  const button = layout.buttons[shape.root];
  return { button, controls, text: [...controls, button].join(' + '), basePitch: ROOTS[shape.root] };
}

export function fingering(pitch, mode = 'normal', fingeringMode = 'simple') {
  const shape = fingeringChoices[fingeringMode].byPitch.get(pitch)?.[0];
  return shape ? describeFingering(shape, LAYOUTS[mode] ?? LAYOUTS.normal) : null;
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

export function chooseShift(notes, fingeringMode = 'simple', { preserveMelody = false, fold = false } = {}) {
  const live = notes.filter(note => note.pitch != null);
  if (!live.length) return 0;
  const pitches = live.map(note => note.pitch);
  const range = FINGERING_MODES[fingeringMode].range;
  const [low, high] = range;
  const start = low - Math.max(...pitches);
  const end = high - Math.min(...pitches);
  if (preserveMelody) {
    const firstFit = end - (high - low);
    const lastFit = start + (high - low);
    const fits = firstFit <= lastFit;
    // An exact fit preserves every interval by shifting the whole melody together.
    const first = fits ? firstFit : start;
    const last = fits ? lastFit : end;
    let best;
    for (let shift = first; shift <= last; shift++) {
      const score = planFingering(notes, shift, fingeringMode, fold && !fits);
      score.effort += live.length * (Math.abs(shift) * 0.016 + (shift % 12 === 0 ? 0 : 0.22));
      if (!best || score.missing < best.missing || (score.missing === best.missing && easierPlan(score, best))) {
        best = { ...score, shift };
      }
    }
    return best.shift;
  }
  let bestCost = Infinity;
  let bestShift = 0;
  for (let shift = start; shift <= end; shift++) {
    let cost = Math.abs(shift) * 0.016 + (shift % 12 === 0 ? 0 : 0.22);
    for (const pitch of pitches) {
      const target = pitch + shift;
      const fit = target >= low && target <= high ? fingerings.get(target)?.[0] : null;
      cost += fit ? fit.difficulty / pitches.length : 12 + Math.abs(foldPitch(target, range) - target) * 0.01;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  return bestShift;
}

function easierPlan(a, b) {
  return a.contour < b.contour || (a.contour === b.contour && a.effort < b.effort);
}

function contourPenalty(expected, actual) {
  if (expected === actual) return 0;
  const changesDirection = Math.sign(expected) !== Math.sign(actual);
  return Math.abs(expected - actual) + (changesDirection ? 12 + Math.abs(actual) : 0);
}

function controlChange(before, after) {
  if (before === after) return 0;
  return before * after < 0 ? 3 : 1;
}

function fingeringChange(before, after) {
  return (before.root === after.root ? 0 : 0.5) +
    controlChange(before.pad, after.pad) * 1.4 + controlChange(before.stick, after.stick) * 1.6;
}

function planFingering(notes, shift, fingeringMode, fold, selected) {
  const { byPitch, byPitchClass } = fingeringChoices[fingeringMode];
  let missing = 0;
  let contour = 0;
  let effort = 0;
  let previousPitch = null;
  let gap = 0;
  let previous = [];

  function finishPhrase() {
    if (!previous.length) return;
    let best = previous[0];
    for (const choice of previous) if (easierPlan(choice, best)) best = choice;
    contour += best.contour;
    effort += best.effort;
    if (selected) {
      for (let choice = best; choice; choice = choice.parent) selected[choice.index] = choice.shape;
    }
    previous = [];
    previousPitch = null;
    gap = 0;
  }

  for (const [index, note] of notes.entries()) {
    if (note.pitch == null) {
      gap += note.beats;
      if (gap >= 2) finishPhrase();
      continue;
    }
    const shifted = note.pitch + shift;
    const pinned = note.pinnedShift === shift ? byPitch.get(note.performancePitch) : undefined;
    const shapes = pinned ?? (fold ? byPitchClass[((shifted % 12) + 12) % 12] : byPitch.get(shifted));
    if (!shapes?.length) {
      finishPhrase();
      missing++;
      continue;
    }
    const interval = note.pitch - previousPitch;
    const previousNote = notes[index - 1];
    const tied = interval === 0 && gap === 0 && /^(start|continue)$/.test(previousNote?.tie) && /^(continue|stop)$/.test(note.tie);
    const ties = tied ? previous.filter(prior => shapes.includes(prior.shape)) : [];
    const candidates = ties.length ? ties.map(prior => prior.shape) : shapes;
    const boundaryWeight = gap ? 0.5 : note.bar !== previousNote?.bar ? 0.8 : 1;
    const current = [];
    for (const shape of candidates) {
      const change = Math.abs(shape.target - shifted) / 12;
      // Keep local octave changes small and prefer simple actions when the contour is equal.
      const baseEffort = shape.difficulty + change * 0.85;
      const best = { shape, index, contour: Infinity, effort: Infinity, parent: null };
      if (!previous.length) {
        best.contour = 0;
        best.effort = baseEffort;
      }
      for (const prior of previous) {
        if (ties.length && prior.shape !== shape) continue;
        const distortion = contourPenalty(interval, shape.target - prior.shape.target);
        const melody = prior.contour + boundaryWeight * distortion;
        const actions = prior.effort + baseEffort + (gap ? 0 : fingeringChange(prior.shape, shape));
        if (melody < best.contour || (melody === best.contour && actions < best.effort)) {
          best.contour = melody;
          best.effort = actions;
          if (selected) best.parent = prior;
        }
      }
      current.push(best);
    }
    previous = current;
    previousPitch = note.pitch;
    gap = 0;
  }
  finishPhrase();
  return { missing, contour, effort };
}

export function arrange(notes, { shift, mode, fold, fingeringMode = 'simple', preserveMelody = false }) {
  const range = FINGERING_MODES[fingeringMode].range;
  if (preserveMelody) {
    const [low, high] = range;
    const needsFold = fold && notes.some(note => note.pitch != null && (note.pitch + shift < low || note.pitch + shift > high));
    const selected = new Array(notes.length);
    planFingering(notes, shift, fingeringMode, needsFold, selected);
    const layout = LAYOUTS[mode] ?? LAYOUTS.normal;
    return notes.map((note, index) => {
      const shifted = note.pitch == null ? null : note.pitch + shift;
      const shape = selected[index];
      const target = shape?.target ?? shifted;
      return { ...note, target, key: shape ? describeFingering(shape, layout) : null, octaveFold: shifted !== target };
    });
  }
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
