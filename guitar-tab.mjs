const STANDARD_TUNING = [64, 59, 55, 50, 45, 40];
const GLYPH_WIDTH = 10;
const GLYPH_HEIGHT = 14;
// Compact music-engraving numerals have a plain 1, a closed 4 and a narrow 3.
// Use these shapes alongside common system fonts.
const ENGRAVING_DIGITS = {
  0: ['011110','110001','110001','110001','110001','110001','110001','110001','011110'],
  1: ['0011','0111','1111','0001','0001','0001','0001','0001','0001'],
  2: ['011110','110011','110011','000011','000110','001100','011000','110000','111111'],
  3: ['011110','110011','110001','000001','001110','000001','000001','110001','110011','011110'],
  4: ['000110','001110','001110','010110','100110','111111','000110','000110','000110'],
  5: ['011111','110000','110000','111110','110011','000001','000001','110011','011110'],
  7: ['111111','000011','000011','000110','000110','001100','001100','011000','011000'],
  8: ['011110','110011','110011','110011','011110','110011','110011','110011','011110'],
};
const NARROW_DIGITS = {
  0: ['011110','110010','110001','100001','100001','100001','100001','110001','111010','011110'],
  1: ['0001','0111','1111','1101','0001','0001','0001','0001','0001','0001'],
  2: ['011110','110011','110011','100011','000010','000100','001100','011000','110000','111111'],
  3: ['011110','111111','110001','000001','000011','000111','000001','100001','110001','111111','001110'],
  4: ['000010','000110','001110','001110','011010','100011','111111','111111','000010','000010','000010'],
  5: ['011111','111000','110000','111110','111111','110001','000001','100001','110001','011111','001110'],
  7: ['111111','111111','000110','000110','000100','000100','001000','001000','011000','011000','011000'],
  8: ['011110','110011','100011','100011','011110','011110','100001','100011','110111','011110'],
};

function groups(items, distance = 1) {
  const runs = [];
  for (const item of items) {
    if (item - (runs.at(-1)?.at(-1) ?? -Infinity) > distance) runs.push([item]);
    else runs.at(-1).push(item);
  }
  return runs;
}

function pixels(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (3 * data[i * 4] + 6 * data[i * 4 + 1] + data[i * 4 + 2]) / 10;
  }
  return { width, height, at: (x, y) => x >= 0 && x < width ? (gray[y * width + x] ?? 255) : 255 };
}

function staffRows({ width, height, at }) {
  const ink = new Uint16Array(height);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 0; x < width; x++) {
      const shade = at(x, y);
      if (shade < 253 && shade + 3 < Math.max(at(x, y - 2), at(x, y + 2))) ink[y]++;
    }
  }
  const rows = [];
  for (let y = 0; y < height; y++) if (ink[y] > width * 0.25) rows.push(y);
  return groups(rows).map(run => run.reduce((best, y) => ink[y] > ink[best] ? y : best));
}

function barlines({ width, at }, top, gap) {
  top = Math.round(top);
  const bottom = Math.round(top + 5 * gap);
  const bars = [];
  for (let x = 1; x < width - 1; x++) {
    let length = 0;
    let upper = 0;
    let lower = 0;
    for (let y = top; y <= bottom; y++) {
      if (at(x, y) < 231) length++;
      if (y - top < gap * 0.5 && at(x, y) < 231) upper++;
    }
    if (length < gap * 4.2 || upper < gap * .30) continue;
    for (let y = Math.round(bottom + gap * .28); y < bottom + gap; y++) if (at(x, y) < 246) lower++;
    if (lower < gap * .35) bars.push(x);
  }
  return groups(bars, Math.max(1, Math.round(gap * 0.73)))
    .map(run => Math.round((run[0] + run.at(-1)) / 2));
}

function findSystems(image) {
  const rows = staffRows(image);
  const measured = new Set(rows);
  const candidates = new Map();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length && rows[j] - rows[i] <= image.width * 0.22; j++) {
      for (let steps = 3; steps <= 5; steps++) {
        const gap = (rows[j] - rows[i]) / steps;
        if (gap < 7 || gap > image.width * 0.043) continue;
        for (let leading = 0; leading + steps <= 5; leading++) {
          const top = rows[i] - leading * gap;
          if (top < 0 || top + 5 * gap >= image.height) continue;
          const radius = Math.floor(Math.max(1, gap * .13));
          const strings = Array.from({ length: 6 }, (_, string) => {
            const expected = Math.round(top + string * gap);
            if (measured.has(expected)) return { y: expected, detected: true };
            for (let offset = 1; offset <= radius; offset++) {
              if (measured.has(expected - offset)) return { y: expected - offset, detected: true };
              if (measured.has(expected + offset)) return { y: expected + offset, detected: true };
            }
            return { y: expected, detected: false };
          });
          const hits = strings.filter(line => line.detected).length;
          if (hits >= 4) {
            const key = `${Math.round(top)}:${Math.round(gap * 4)}`;
            if ((candidates.get(key)?.hits ?? 0) < hits) candidates.set(key, { top, gap, strings: strings.map(line => line.y), hits });
          }
        }
      }
    }
  }
  const systems = [];
  for (const system of [...candidates.values()].sort((a, b) => b.hits - a.hits || b.gap - a.gap)) {
    if (systems.some(row => Math.abs(row.top - system.top) < Math.max(row.gap, system.gap) * 5.5)) continue;
    const bars = barlines(image, system.top, system.gap);
    if (bars.length < 2 || bars.at(-1) - bars[0] < image.width * .35) continue;
    systems.push({ ...system, bars });
  }
  return systems.sort((a, b) => a.top - b.top);
}

function normalized(at, { x, y, w, h }) {
  const sample = new Float32Array(GLYPH_WIDTH * GLYPH_HEIGHT);
  for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
    for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
      let sum = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
        sum += at(x + Math.floor((gx + dx) * w / GLYPH_WIDTH), y + Math.floor((gy + dy) * h / GLYPH_HEIGHT));
      }
      sample[gy * GLYPH_WIDTH + gx] = sum / 4;
    }
  }
  return sample;
}

function boxFor(points) {
  if (!points.length) return null;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
}

let templates;
function digitTemplates() {
  if (templates) return templates;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  templates = [];
  for (const digits of [ENGRAVING_DIGITS, NARROW_DIGITS]) {
    for (const [digit, rows] of Object.entries(digits)) {
      const w = rows[0].length;
      const h = rows.length;
      templates.push({ digit: Number(digit), mask: normalized((x, y) => Number(rows[y][x]), { x: 0, y: 0, w, h }), ratio: w / h, engraving: true });
    }
  }
  for (const family of ['Arial', 'Arial Narrow', 'Tahoma', 'Times New Roman', 'Verdana']) {
    for (const size of [13, 24, 31]) {
      ctx.font = `${size}px "${family}"`;
      ctx.textBaseline = 'top';
      for (let digit = 0; digit < 10; digit++) {
        ctx.clearRect(0, 0, 40, 40);
        ctx.fillText(String(digit), 3, 1);
        const { data } = ctx.getImageData(0, 0, 40, 40);
        const at = (x, y) => data[(y * 40 + x) * 4 + 3] > 113 ? 1 : 0;
        const points = [];
        for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (at(x, y)) points.push([x, y]);
        const box = boxFor(points);
        if (box) templates.push({ digit, mask: normalized(at, box), ratio: box.w / box.h });
      }
    }
  }
  return templates;
}

function readDigit(at, box, bank) {
  const mask = normalized(at, box);
  const ratio = box.w / box.h;
  const costs = Array(10).fill(Infinity);
  for (const { digit, mask: reference, ratio: fontRatio, engraving } of bank) {
    let cost = 0;
    for (let y = 0; y < GLYPH_HEIGHT; y++) {
      let left = 0;
      let right = 0;
      for (let x = 0; x < GLYPH_WIDTH; x++) {
        const i = y * GLYPH_WIDTH + x;
        const difference = mask[i] - reference[i];
        cost += Math.abs(difference);
        if (x < GLYPH_WIDTH / 2) left += difference;
        else right += difference;
      }
      cost += 0.18 * (Math.abs(left) + Math.abs(right));
    }
    cost = cost / mask.length / 1.18 + Math.abs(ratio - fontRatio) * 0.24 - (engraving ? .009 : 0);
    costs[digit] = Math.min(costs[digit], cost);
  }
  let leftStroke = 0;
  let rightStroke = 0;
  for (let y = 3; y <= 10; y++) {
    const offset = y * GLYPH_WIDTH;
    leftStroke += Math.max(mask[offset], mask[offset + 1], mask[offset + 2]);
    rightStroke += Math.max(mask[offset + 7], mask[offset + 8], mask[offset + 9]);
  }
  if (leftStroke >= 6 && rightStroke >= 5) costs[3] += .11;
  if (leftStroke <= 3) costs[0] += .14;
  const [digit, runnerUp] = costs.map((_, digit) => digit).sort((a, b) => costs[a] - costs[b]);
  return { digit, cost: costs[digit], margin: costs[runnerUp] - costs[digit] };
}

function fretAt(image, x, y, gap, bank) {
  const halfHeight = Math.ceil(gap * 0.47);
  const halfWidth = Math.ceil(gap * 0.72);
  const top = Math.round(y - halfHeight);
  const bottom = Math.round(y + halfHeight);
  const left = Math.round(x - halfWidth);
  const right = Math.round(x + halfWidth);
  const strongInk = 174;
  const stemColumns = new Set();
  for (let px = Math.round(x - gap * .24); px <= x + gap * .24; px++) {
    let count = 0;
    for (let py = top; py <= bottom; py++) count += image.at(px, py) < 236;
    if (count >= bottom - top - 1 && image.at(px, top) < 236 && image.at(px, bottom) < 236) stemColumns.add(px);
  }
  let dark = 255;
  for (let px = Math.round(x - gap * .36); px <= x + gap * .36; px++) {
    if (stemColumns.has(px)) continue;
    for (let py = top + 2; py <= bottom - 2; py++) {
      if (Math.abs(py - y) > gap * .15) dark = Math.min(dark, image.at(px, py));
    }
  }
  if (dark > 167) return null;
  const inkLimit = Math.max(strongInk, Math.min(217, dark + 100));
  const ink = (px, py) => {
    if (stemColumns.has(px) || image.at(px, py) >= inkLimit) return 0;
    // Ignore a printed string line when it crosses the window uninterrupted.
    if (Math.abs(py - y) <= gap * .15) {
      const lineShade = Math.max(image.at(left, py), image.at(right, py));
      if (lineShade < 248 && image.at(px, py) + 13 >= lineShade) {
        return Number(image.at(px, py - 2) < inkLimit || image.at(px, py + 2) < inkLimit);
      }
    }
    return 1;
  };
  const columns = [];
  for (let px = left; px <= right; px++) {
    let count = 0;
    for (let py = top; py <= bottom; py++) count += ink(px, py);
    if (count >= 2) columns.push(px);
  }
  const characters = groups(columns).flatMap(run => {
    const points = [];
    for (const px of run) for (let py = top; py <= bottom; py++) if (ink(px, py)) points.push([px, py]);
    const box = boxFor(points);
    if (!box || box.h < gap * 0.53 || box.h > gap * 1.02 || box.w < gap * 0.18 || box.w > gap * 0.85) return [];
    if (Math.abs(box.y + box.h / 2 - y) > gap * .21) return [];
    return [{ ...readDigit(ink, box, bank), box }];
  });
  if (!characters.length || characters.length > 2) return null;
  const box = boxFor(characters.flatMap(item => [[item.box.x, item.box.y], [item.box.x + item.box.w - 1, item.box.y + item.box.h - 1]]));
  if (Math.abs(box.x + box.w / 2 - x) > gap * .27 || characters.some(item => item.cost > .4)) return null;
  const fret = Number(characters.map(item => item.digit).join(''));
  if (fret > 24 || (characters.length > 1 && fret < 10)) return null;
  const uncertain = characters.some(item => item.margin < .055 || item.cost > .16) || dark > 95;
  return { fret, box, confidence: uncertain ? .55 : .87 };
}

function rhythm(image, x, bottom, gap) {
  const beam = [];
  const reach = Math.round(gap * .7);
  for (let y = Math.round(bottom + gap * .85); y <= bottom + gap * 3.35 && y < image.height; y++) {
    if (Math.min(image.at(x, y), image.at(x - 1, y), image.at(x + 1, y)) >= 183) continue;
    for (const direction of [-1, 1]) {
      let count = 0;
      for (let k = 1; k <= reach; k++) count += image.at(x + k * direction, y) < 192;
      if (count >= reach - 2) { beam.push(y); break; }
    }
  }
  return 2 ** -Math.min(3, groups(beam).length);
}

function readBar(image, system, start, end, bank, capo) {
  const { strings, gap } = system;
  const bottom = strings.at(-1);
  const stems = [];
  function stemStrength(x) {
    let strength = 0;
    const from = Math.round(bottom + gap * .27);
    for (let y = from; y <= bottom + gap * 1.92; y++) {
      const sides = Math.max(image.at(x - 2, y), image.at(x + 2, y));
      strength += Math.max(0, sides - image.at(x, y) - 4);
    }
    return strength;
  }
  for (let x = Math.round(start + gap * .38); x <= end - gap * .35; x++) {
    let count = 0;
    let lower = 0;
    for (let y = Math.round(bottom + gap * .28); y <= bottom + gap * 2.08; y++) count += image.at(x, y) < 249;
    for (let y = Math.round(bottom + gap * 1.02); y <= bottom + gap * 1.68; y++) lower += image.at(x, y) < 248;
    if (count >= gap * 0.72 && lower >= gap * .38 && stemStrength(x) > gap * 9) stems.push(x);
  }
  return groups(stems).map(run => {
    const x = run.reduce((best, col) => stemStrength(col) > stemStrength(best) ? col : best);
    const notes = strings.flatMap((y, string) => {
      const note = fretAt(image, x, y, gap, bank);
      return note ? [{ ...note, string, pitch: STANDARD_TUNING[string] + note.fret + capo }] : [];
    });
    const beats = rhythm(image, x, bottom, gap);
    let above = 0;
    for (let y = Math.round(bottom - gap * .25); y < bottom + gap * .4; y++) {
      if (image.at(x, y) + 9 < Math.max(image.at(x - 3, y), image.at(x + 3, y))) above++;
    }
    return { x, beats, notes, continuation: above < gap * .24 && beats < 1 };
  });
}

function leadingRest(image, system, start, end) {
  const { gap, strings } = system;
  for (let y = Math.round(strings[1] + gap * .18); y <= strings[3]; y++) {
    const dark = [];
    for (let x = Math.round(start + gap * 1.2); x < end - gap; x++) if (image.at(x, y) < 128) dark.push(x);
    for (const run of groups(dark)) {
      if (run.length < gap * .58 || run.length > gap * .98) continue;
      const middle = run[Math.floor(run.length / 2)];
      const depth = Math.round(gap * .19);
      if (image.at(middle, y + depth) < 128 && image.at(middle, y - depth) < 128) {
        return { x: run[0], y: y - depth, w: run.length, h: depth * 2 + 1 };
      }
    }
  }
  return null;
}

export function recognizeGuitarTab(canvas, { capo = 0, meter = { num: 4, den: 4 }, lead = true } = {}) {
  const image = pixels(canvas);
  const systems = findSystems(image);
  const bank = digitTemplates();
  const notes = [];
  const notices = new Set();
  const expected = meter.num * 4 / meter.den;
  let bar = 0;
  for (const system of systems) {
    for (let index = 1; index < system.bars.length; index++) {
      const start = system.bars[index - 1];
      const end = system.bars[index];
      const events = readBar(image, system, start, end, bank, capo);
      if (!events.some(event => event.notes.length)) continue;
      const missing = expected - events.reduce((beats, event) => beats + event.beats, 0);
      const rest = [0.5, 0.75, 1, 1.5, 2, 3, 4].includes(missing) && leadingRest(image, system, start, events[0].x);
      if (rest) notes.push({ pitch: null, beats: missing, bar, meter, sourceBox: rest });
      const hasLead = events.some(event => event.notes.some(note => note.string < 3));
      for (const event of events) {
        const highest = event.notes.sort((a, b) => b.pitch - a.pitch)[0];
        if (!highest && event.continuation && notes.at(-1)?.bar === bar && notes.at(-1).pitch != null) {
          notes.at(-1).beats += event.beats;
          continue;
        }
        if (!highest) notices.add('有部分符杆未能配对到清晰的品位数字，请对照原图。');
        const leading = highest && (!lead || !hasLead || highest.string < 3);
        if (highest && !leading && notes.at(-1)?.bar === bar && notes.at(-1).pitch != null) {
          notes.at(-1).beats += event.beats;
        } else {
          notes.push({
            pitch: leading ? highest.pitch : null, beats: event.beats, bar, meter,
            confidence: highest?.confidence ?? .5,
            sourceBox: highest?.box ?? { x: event.x - system.gap / 2, y: system.top, w: system.gap, h: 5 * system.gap },
          });
        }
      }
      bar++;
    }
  }
  return { notes, meter, notices: [...notices] };
}

