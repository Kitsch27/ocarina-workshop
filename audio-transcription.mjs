export const SAMPLE_RATE = 12000;
export const MAX_AUDIO_SECONDS = 180;
const HOP = 144;
const WINDOW = 336;
const MIN_PERIOD = 6;
const MAX_PERIOD = 150;
const REFERENCE_TEMPO = 120;

// YIN uses a normalized difference curve to look for the first convincing period.
function framePitch(samples, start, difference) {
  let sum = 0;
  difference[0] = 1;
  for (let period = 1; period <= MAX_PERIOD; period++) {
    let error = 0;
    for (let i = start; i < start + WINDOW; i++) {
      const delta = samples[i] - samples[i + period];
      error += delta * delta;
    }
    sum += error;
    difference[period] = sum ? error * period / sum : 1;
    const prior = period - 1;
    if (prior < MIN_PERIOD || difference[prior] >= 0.19 || difference[period] < difference[prior] ||
      difference[prior] > difference[prior - 1]) continue;
    const before = difference[prior - 1];
    const after = difference[period];
    const curvature = before + after - 2 * difference[prior];
    const refined = prior + (curvature > 0 ? (before - after) / (2 * curvature) : 0);
    const midi = 69 + 12 * Math.log2(SAMPLE_RATE / (440 * refined));
    return { pitch: Math.round(midi), midi, confidence: 1 - difference[prior] };
  }
  return null;
}

function segmentFrames(frames) {
  const segments = [];
  for (const [index, frame] of frames.entries()) {
    const pitch = frame?.pitch ?? null;
    const left = frames[index - 1]?.pitch;
    const right = frames[index + 1]?.pitch;
    const stablePitch = left !== undefined && left === right ? left : pitch;
    const prev = segments.at(-1);
    if (prev && prev.pitch === stablePitch) {
      prev.end = index + 1;
      prev.confidence += frame?.confidence ?? 0;
    } else segments.push({ start: index, end: index + 1, pitch: stablePitch, confidence: frame?.confidence ?? 0 });
  }

  const stable = [];
  for (const [index, segment] of segments.entries()) {
    const previous = stable.at(-1);
    const next = segments[index + 1];
    const short = segment.end - segment.start < 5;
    if (short && segment.pitch != null) {
      if (previous) previous.end = segment.end;
      continue;
    }
    // Changing pitch can leave a few ambiguous frames even when the signal never goes quiet.
    if (short && segment.pitch === null && previous && previous.pitch !== null && next?.pitch != null) {
      const boundary = Math.round((segment.start + segment.end) / 2);
      previous.end = boundary;
      next.start = boundary;
      continue;
    }
    if (previous && previous.pitch === segment.pitch) {
      previous.end = segment.end;
      previous.confidence += segment.confidence;
    } else stable.push(segment);
  }
  const first = stable.findIndex(segment => segment.pitch !== null);
  if (first === -1) return [];
  const last = stable.findLastIndex(segment => segment.pitch !== null);
  return stable.slice(first, last + 1);
}

function appendSegment(segments, segment, separate = false) {
  const previous = segments.at(-1);
  if (!separate && previous && previous.pitch === segment.pitch) {
    previous.end = segment.end;
    previous.confidence += segment.confidence;
  } else segments.push(segment);
}

function meanLevel(levels, start, end) {
  let sum = 0;
  for (let index = start; index < end; index++) sum += levels[index];
  return sum / (end - start);
}

function stablePitchIn(frames, segment) {
  let centered = 0;
  for (let index = segment.start; index < segment.end; index++) {
    const frame = frames[index];
    centered = frame && Math.abs(frame.midi - segment.pitch) < 0.21 && frame.confidence >= 0.86 ? centered + 1 : 0;
    if (centered === 3) return true;
  }
  return false;
}

function smoothVibrato(frames) {
  const held = new Uint8Array(frames.length);
  let from = 0;
  while (from < frames.length) {
    const frame = frames[from];
    if (!frame || Math.abs(frame.midi - frame.pitch) >= 0.18) {
      from++;
      continue;
    }
    let to = from + 1;
    while (frames[to]?.pitch === frame.pitch && Math.abs(frames[to].midi - frame.pitch) < 0.18) to++;
    if (to - from >= 4) held.fill(1, from, to);
    from = to;
  }
  const pitches = new Map();
  const span = 32;
  for (let start = 0; start + span <= frames.length; start += 4) {
    const end = start + span;
    const curve = frames.slice(start, end).map(frame => frame?.midi);
    const voiced = curve.filter(midi => midi !== undefined);
    if (voiced.length < span - 2) continue;
    const low = Math.min(...voiced);
    const high = Math.max(...voiced);
    const midpoint = (low + high) / 2;
    const pitch = Math.round(midpoint);
    if (high - low < 0.96 || high - low > 2.2 || Math.abs(midpoint - pitch) > 0.27) continue;
    let gradual = 0;
    let crossings = 0;
    let lastSide = 0;
    for (const [index, midi] of curve.entries()) {
      const step = Math.abs(midi - curve[index - 1]);
      if (step >= 0.08 && step <= 0.45) gradual++;
      if (midi == null || Math.abs(midi - midpoint) < 0.28) continue;
      const side = Math.sign(midi - midpoint);
      if (lastSide && side !== lastSide) crossings++;
      lastSide = side;
    }
    // Discrete trills mostly hold a pitch before jumping; a vibrato sweeps through it.
    if (crossings < 3 || gradual < 12) continue;
    for (let index = start; index < end; index++) {
      if (frames[index] && !held[index]) pitches.set(index, pitch);
    }
  }
  return frames.map((frame, index) => pitches.has(index) ? { ...frame, pitch: pitches.get(index) } : frame);
}

function splitRepeatedPitch(segment, levels, output) {
  let start = segment.start;
  const confidence = segment.confidence / (segment.end - segment.start);
  // A new attack following a pronounced dip can rearticulate a pitch without losing its periodicity.
  for (let index = start + 6; index <= segment.end - 5; index++) {
    const before = meanLevel(levels, index - 6, index - 3);
    const dip = meanLevel(levels, index - 2, index);
    const after = meanLevel(levels, index + 2, index + 5);
    const rise = Math.max(levels[index] - levels[index - 1], levels[index + 1] - levels[index]);
    if (dip * 3 > Math.min(before, after) || levels[index] < dip * 1.75 || rise < after * 0.48) continue;
    appendSegment(output, { ...segment, start, end: index, confidence: confidence * (index - start) }, true);
    start = index;
    index += 5;
  }
  appendSegment(output, { ...segment, start, confidence: confidence * (segment.end - start) }, true);
}

function segmentArticulatedFrames(frames, levels) {
  frames = smoothVibrato(frames);
  const runs = [];
  for (const [index, frame] of frames.entries()) {
    const before = frames[index - 1]?.pitch;
    const after = frames[index + 1]?.pitch;
    const pitch = before != null && before === after ? before : frame?.pitch ?? null;
    appendSegment(runs, { start: index, end: index + 1, pitch, confidence: frame?.confidence ?? 0 });
  }

  const stable = [];
  for (const [index, run] of runs.entries()) {
    const previous = stable.at(-1);
    const next = runs[index + 1];
    const length = run.end - run.start;
    if (run.pitch != null && length <= 6) {
      const steady = stablePitchIn(frames, run);
      const bounded = previous?.pitch != null && previous.pitch === next?.pitch;
      const wobble = bounded && Math.abs(previous.pitch - run.pitch) === 1 && !steady;
      if (length < 3 || wobble || (length < 5 && !steady)) {
        const pitch = previous?.pitch ?? next?.pitch ?? null;
        appendSegment(stable, { ...run, pitch });
        continue;
      }
    }
    appendSegment(stable, run);
  }

  const articulated = [];
  for (const [index, segment] of stable.entries()) {
    const previous = articulated.at(-1);
    const next = stable[index + 1];
    const length = segment.end - segment.start;
    if (segment.pitch === null && length < 8 && previous?.pitch != null && next?.pitch != null) {
      const before = meanLevel(levels, Math.max(previous.start, previous.end - 4), previous.end);
      const after = meanLevel(levels, next.start, Math.min(next.end, next.start + 4));
      const gap = meanLevel(levels, segment.start, segment.end);
      const interrupted = length >= 2 && gap < Math.min(before, after) * 0.3;
      if (!interrupted || length <= 4) {
        const boundary = Math.round((segment.start + segment.end) / 2);
        previous.end = boundary;
        next.start = boundary;
        if (!interrupted && previous.pitch === next.pitch) {
          next.start = previous.start;
          next.confidence += previous.confidence;
          articulated.pop();
        }
        continue;
      }
    }
    if (segment.pitch === null) appendSegment(articulated, segment);
    else splitRepeatedPitch(segment, levels, articulated);
  }
  const first = articulated.findIndex(segment => segment.pitch !== null);
  if (first < 0) return [];
  return articulated.slice(first, articulated.findLastIndex(segment => segment.pitch !== null) + 1);
}

export function transcribeMelody(samples, onProgress = () => {}, { enhanced = true } = {}) {
  const frames = [];
  const levels = [];
  let peak = 0;
  // Anchor each frame at its reported time and read equally far on both sides.
  const padding = (WINDOW + MAX_PERIOD) / 2;
  const padded = new Float32Array(samples.length + padding * 2);
  padded.set(samples, padding);
  for (let start = 0; start + HOP <= samples.length; start += HOP) {
    let sum = 0;
    for (let i = start + padding; i < start + padding + HOP; i++) sum += padded[i] * padded[i];
    const level = Math.sqrt(sum / HOP);
    peak = Math.max(peak, level);
    levels.push(level);
  }
  const difference = new Float32Array(MAX_PERIOD + 1);
  const gate = Math.max(0.00008, peak * 0.028);
  const quietGate = enhanced ? Math.max(0.00008, peak * 0.003) : gate;
  for (const [index, level] of levels.entries()) {
    const frame = level < quietGate ? null : framePitch(padded, index * HOP, difference);
    frames.push(enhanced && level < gate && frame?.confidence < 0.88 ? null : frame);
    if (index % 64 === 0) onProgress(index / levels.length);
  }

  const segments = enhanced ? segmentArticulatedFrames(frames, levels) : segmentFrames(frames);
  if (!segments.length) throw new Error('未读到清晰的旋律。请试用一段清晰的独唱、口哨或单件乐器录音。');
  const first = segments[0].start;
  const beatsPerFrame = HOP * REFERENCE_TEMPO / (60 * SAMPLE_RATE);
  const notes = [];
  for (const { pitch, start, end, confidence } of segments) {
    const from = Math.round((start - first) * beatsPerFrame * 100) / 100;
    const to = Math.round((end - first) * beatsPerFrame * 100) / 100;
    // The score editor accepts up to 128 beats per event.
    for (let beat = from; beat < to; beat += 128) {
      notes.push({
        pitch,
        beats: Math.min(128, Math.round((to - beat) * 100) / 100),
        bar: Math.floor(beat / 4),
        confidence: pitch == null ? 1 : confidence / (end - start),
      });
    }
  }
  return { notes, tempo: REFERENCE_TEMPO };
}
