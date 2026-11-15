const MIN_TEMPO = 48;
const MAX_TEMPO = 210;
const QUARTER_GRID = 4;
const TIMING_TOLERANCE = 0.19;

function onsetPoints(segments, origin, frameSeconds) {
  return segments.flatMap(segment => {
    const frames = segment.end - segment.start;
    const confidence = segment.confidence / frames;
    const seconds = frames * frameSeconds;
    if (segment.pitch == null || seconds < 0.105 || confidence < 0.69) return [];
    return [{ time: (segment.start - origin) * frameSeconds, pitch: segment.pitch, weight: Math.sqrt(Math.min(0.55, seconds)) * confidence }];
  });
}

// Consistent note attacks reinforce the candidate pulse and its subdivisions.
function pulse(points, bpm) {
  const step = bpm * 2 * Math.PI / 60;
  let total = 0;
  let wholeX = 0, wholeY = 0, halfX = 0, halfY = 0, quarterX = 0, quarterY = 0;
  for (const { time, weight } of points) {
    const angle = time * step;
    wholeX += Math.cos(angle) * weight;
    wholeY += Math.sin(angle) * weight;
    halfX += Math.cos(2 * angle) * weight;
    halfY += Math.sin(2 * angle) * weight;
    quarterX += Math.cos(4 * angle) * weight;
    quarterY += Math.sin(4 * angle) * weight;
    total += weight;
  }
  const strength = total ? (0.54 * Math.hypot(wholeX, wholeY) + 0.34 * Math.hypot(halfX, halfY) +
    0.12 * Math.hypot(quarterX, quarterY)) / total : 0;
  return strength;
}

function detectTempo(points) {
  if (points.length < 8 || points.at(-1).time < 3) return null;
  const stride = Math.ceil(points.length / 480);
  const sample = stride === 1 ? points : points.filter((_, index) => index % stride === 0);
  let best = { bpm: 120, strength: 0, score: 0 };
  let alternative = 0;
  const candidates = [];
  for (let bpm = MIN_TEMPO; bpm <= MAX_TEMPO; bpm += 0.25) {
    const strength = pulse(sample, bpm);
    // For octave-equivalent grids, prefer a conventional counting rate.
    const score = strength - 0.065 * Math.abs(Math.log2(bpm / 112));
    const candidate = { bpm, strength, score };
    candidates.push(candidate);
    if (score > best.score) best = candidate;
  }
  for (const { bpm, score } of candidates) {
    if (Math.abs(bpm - best.bpm) >= 5) alternative = Math.max(alternative, score);
  }
  return best.strength >= 0.235 && best.score - alternative >= 0.035 ? best.bpm : null;
}

function repeatStrength(points, bpm, lag) {
  const target = lag * 60 / bpm;
  const tolerance = TIMING_TOLERANCE * 60 / bpm;
  let matches = 0;
  let nearby = 0;
  let first = 0;
  for (const point of points) {
    while (first < points.length && points[first].time < point.time + target - tolerance) first++;
    for (let index = first; index < points.length && points[index].time <= point.time + target + tolerance; index++) {
      const next = points[index];
      const weight = point.weight * next.weight;
      nearby += weight;
      if (next.pitch === point.pitch) matches += weight;
    }
  }
  return { matches, nearby };
}

function detectMeasure(points, bpm) {
  const triple = repeatStrength(points, bpm, 6);
  const quadruple = repeatStrength(points, bpm, 8);
  const shortTriple = repeatStrength(points, bpm, 3);
  const shortQuadruple = repeatStrength(points, bpm, 4);
  // Repeated two-measure melodies are stronger evidence than uneven lone accents.
  const tripleScore = triple.matches + 0.5 * shortTriple.matches;
  const quadrupleScore = quadruple.matches + 0.5 * shortQuadruple.matches;
  return triple.matches >= 2 && triple.matches > triple.nearby * 0.22 && tripleScore > 1.8 * quadrupleScore
    ? { num: 3, den: 4 } : null;
}

function quantizeSegments(segments, bpm, frameSeconds) {
  const origin = segments[0].start;
  const scale = frameSeconds * bpm / 60 * QUARTER_GRID;
  const grid = [];
  let cut = 0;
  for (const segment of segments) {
    const gridEnd = Math.round((segment.end - origin) * scale);
    if (gridEnd <= cut) continue;
    const previous = grid.at(-1);
    // A brief interruption snapped out of the grid must not retrigger the same pitch.
    if (previous?.pitch === segment.pitch && previous.endFrame !== segment.start) {
      previous.end = gridEnd;
      previous.endFrame = segment.end;
    } else {
      grid.push({ pitch: segment.pitch, start: cut, end: gridEnd, endFrame: segment.end,
        confidence: segment.pitch == null ? 1 : segment.confidence / (segment.end - segment.start) });
    }
    cut = gridEnd;
  }
  return grid;
}

function scoredNotes(grid, meter) {
  const unitsPerBar = (meter?.num ?? 4) * 4 / (meter?.den ?? 4) * QUARTER_GRID;
  const notes = [];
  for (const event of grid) {
    for (let cursor = event.start; cursor < event.end; ) {
      const bar = Math.floor(cursor / unitsPerBar);
      const end = Math.min(event.end, (bar + 1) * unitsPerBar);
      const tie = event.pitch == null ? undefined : cursor > event.start ? (end < event.end ? 'continue' : 'stop')
        : end < event.end ? 'start' : undefined;
      notes.push({ pitch: event.pitch, beats: (end - cursor) / QUARTER_GRID, bar, confidence: event.confidence, tie });
      cursor = end;
    }
  }
  return notes;
}

export function readAudioRhythm(segments, frameSeconds, { tempo, meter } = {}) {
  const points = onsetPoints(segments, segments[0].start, frameSeconds);
  const bpm = tempo || detectTempo(points);
  if (!bpm) return null;
  const detectedMeter = meter ?? detectMeasure(points, bpm);
  const grid = quantizeSegments(segments, bpm, frameSeconds);
  const notes = scoredNotes(grid, detectedMeter);
  if (!notes.some(note => note.pitch != null)) return null;
  return { notes, tempo: Math.round(bpm), meter: detectedMeter, keepTies: true, rhythm: 'grid', tempoProvided: Boolean(tempo) };
}
