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
    return { pitch: Math.round(midi), confidence: 1 - difference[prior] };
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

export function transcribeMelody(samples, onProgress = () => {}) {
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
  for (const [index, level] of levels.entries()) {
    frames.push(level < gate ? null : framePitch(padded, index * HOP, difference));
    if (index % 64 === 0) onProgress(index / levels.length);
  }

  const segments = segmentFrames(frames);
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
