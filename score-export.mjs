import { controlSymbol, FINGERING_MODES, LAYOUTS } from './music.mjs?v=5';

const REST = '—';
const CONTINUE = '～';
const UNPLAYABLE = '!';
const BEAT_LEGEND = '×n 表示 n 拍，省略时为 1 拍';

export function scoreExport(title, bars, { mode, fingeringMode, tempo, url }) {
  const measures = [...bars.values()].map(group => group.map(({ note }) => {
    const label = note.pitch == null ? REST : note.tiedFromPrevious ? CONTINUE : note.key
      ? [...note.key.controls.map(controlSymbol), note.key.button].join('+') : UNPLAYABLE;
    const beats = Number(note.beats.toFixed(3));
    return { label, duration: beats === 1 ? '' : `×${beats}` };
  }));
  const directions = mode === 'classic' ? 'L / ZL 升 / 降半音' : '↑ / ↓ 十字键';
  const legend = [
    `${directions} · 摇↑ / 摇↓ 左摇杆 · 先按住升降音控制，再按发音键`,
    '— 休止',
  ];
  if (measures.some(measure => measure.some(note => note.label === CONTINUE))) legend[1] += ' · ～ 继续按住上一音';
  if (measures.some(measure => measure.some(note => note.label === UNPLAYABLE))) legend[1] += ' · ! 超出音域';
  return {
    title, measures, legend, tempo, url,
    meta: `Nintendo Switch 2《时之笛》 · ${LAYOUTS[mode].name}布局 · ${FINGERING_MODES[fingeringMode].name}指法`,
  };
}

function barNumber(index) {
  return String(index + 1).padStart(2, '0');
}

export function tablatureText({ title, meta, legend, measures, tempo, url }, { withBeats = false } = {}) {
  const rows = [];
  const numberWidth = Math.max(2, String(measures.length).length);
  for (const [index, notes] of measures.entries()) {
    const prefix = `${barNumber(index).padStart(numberWidth)} │ `;
    let row = prefix;
    for (const { label, duration } of notes) {
      const token = withBeats ? label + duration : label;
      if (row.length + token.length + 2 > 38) {
        rows.push(row.trimEnd());
        row = ' '.repeat(prefix.length);
      }
      row += `${token}  `;
    }
    rows.push(row.trimEnd());
  }
  const header = withBeats ? `${meta} · ${tempo} BPM` : meta;
  const [controls, symbols] = legend;
  const notation = withBeats ? `${symbols} · ${BEAT_LEGEND}` : symbols;
  return [title, header, controls, notation, '', ...rows, '', '时之笛谱工坊', url].join('\n');
}

const WIDTH = 960;
const MARGIN = 44;
const ROW_HEIGHT = 62;
const ROWS_PER_PAGE = 18;
const FONT = '"DM Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

function wrapText(context, text, width) {
  const lines = [''];
  for (const character of text) {
    const last = lines.length - 1;
    if (character === '\n') lines.push('');
    else if (context.measureText(lines[last] + character).width > width) lines.push(character);
    else lines[last] += character;
  }
  return lines;
}

export function scoreImages({ title, meta, legend, measures, tempo, url }) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成图片。');
  const bodyWidth = WIDTH - 2 * MARGIN;
  const rows = [];
  let row = { start: MARGIN, marks: [] };
  for (const [index, notes] of measures.entries()) {
    const widths = notes.map(({ label, duration }) => {
      context.font = `700 23px ${FONT}`;
      const keyWidth = context.measureText(label).width;
      context.font = `500 15px ${FONT}`;
      return Math.max(43, Math.ceil(Math.max(keyWidth, context.measureText(duration).width)) + 22);
    });
    const barWidth = 46 + widths.reduce((sum, width) => sum + width + 8, 0);
    if (row.marks.length && row.start + barWidth > WIDTH - MARGIN) {
      rows.push(row.marks);
      row = { start: MARGIN, marks: [] };
    }
    row.marks.push({ x: row.start, bar: barNumber(index) });
    row.start += 46;
    for (const [i, note] of notes.entries()) {
      const width = widths[i];
      if (row.start + width > WIDTH - MARGIN) {
        rows.push(row.marks);
        row = { start: MARGIN + 46, marks: [{ x: MARGIN, bar: '↳' }] };
      }
      row.marks.push({ x: row.start, ...note, width });
      row.start += width + 8;
    }
    row.start += 15;
  }
  if (row.marks.length) rows.push(row.marks);
  const count = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));

  context.font = `700 38px ${FONT}`;
  const titleLines = wrapText(context, title, bodyWidth);
  context.font = `500 18px ${FONT}`;
  const urlLines = wrapText(context, url, bodyWidth);
  const headerHeight = 56 + titleLines.length * 46;

  return {
    count,
    async render(page) {
      const pageRows = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
      const endOfRows = headerHeight + 98 + pageRows.length * ROW_HEIGHT;
      const height = endOfRows + 67 + 23 * urlLines.length;
      const scale = 1.5;
      canvas.width = WIDTH * scale;
      canvas.height = Math.ceil(height * scale);
      context.scale(scale, scale);
      function write(value, x, y, font, color, align = 'left') {
        context.font = `${font} ${FONT}`;
        context.fillStyle = color;
        context.textAlign = align;
        context.textBaseline = 'middle';
        context.fillText(value, x, y);
      }
      context.fillStyle = '#f4e9c4';
      context.fillRect(0, 0, WIDTH, height);
      context.fillStyle = '#1a3025';
      context.fillRect(0, 0, WIDTH, headerHeight);
      context.fillRect(0, endOfRows, WIDTH, height - endOfRows);
      context.strokeStyle = '#a58d52';
      context.strokeRect(14, 14, WIDTH - 28, height - 28);
      titleLines.forEach((line, index) => write(line, MARGIN, 47 + 46 * index, '700 38px', '#ffe7ac'));
      write(`${meta} · ${tempo} BPM`, MARGIN, headerHeight - 24, '500 18px', '#e6e9d6');
      write(legend[0], MARGIN, headerHeight + 28, '500 18px', '#433b26');
      write(`${legend[1]} · ${BEAT_LEGEND}`, MARGIN, headerHeight + 54, '500 18px', '#433b26');

      for (const [index, marks] of pageRows.entries()) {
        const y = headerHeight + 84 + index * ROW_HEIGHT;
        for (const mark of marks) {
          if (mark.bar) {
            write(mark.bar, mark.x, y + 17, '700 17px', '#665632');
            continue;
          }
          const rest = mark.label === REST || mark.label === CONTINUE;
          const outOfRange = mark.label === UNPLAYABLE;
          context.fillStyle = rest ? '#e6d8ad' : outOfRange ? '#eed0a6' : '#244739';
          context.fillRect(mark.x, y, mark.width, 34);
          const center = mark.x + mark.width / 2;
          write(mark.label, center, y + 17, '700 23px', rest || outOfRange ? '#584022' : '#fff1cb', 'center');
          if (mark.duration) write(mark.duration, center, y + 46, '500 15px', '#584527', 'center');
        }
      }
      write('时之笛谱工坊', MARGIN, endOfRows + 28, '700 17px', '#ffe7ac');
      if (count > 1) write(`${page + 1} / ${count}`, WIDTH - MARGIN, endOfRows + 28, '700 17px', '#ffe7ac', 'right');
      urlLines.forEach((line, index) => write(line, MARGIN, endOfRows + 53 + 23 * index, '500 18px', '#e6e9d6'));
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成 PNG 图片。')), 'image/png');
      });
    },
  };
}
