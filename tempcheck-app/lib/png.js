/**
 * png.js — the hourly chart as a PNG picture, drawn here with no library, for places that can't run the page's
 * Chart.js (a Google Doc). A white picture with grey grid lines, the counts on the left, the hours along the bottom
 * and one blue line: the same chart the page draws, plainer.
 *
 * `encode` writes any picture as a PNG file (8-bit colour, no transparency); `lineChart` draws the chart. The letters
 * are a small built-in set (digits and what an hour label and a count need), so no font file is read.
 */
'use strict';

const zlib = require('zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG file of a `w` x `h` picture; `rgb` holds its pixels row by row, three bytes each (red, green, blue). */
function encode(w, h, rgb) {
  if (!(w > 0 && h > 0) || rgb.length !== w * h * 3) throw new Error('the picture and its size do not agree');
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);  // each row starts with a 0: "no filter"
  for (let y = 0; y < h; y++) rgb.copy(raw, y * row + 1, y * w * 3, (y + 1) * w * 3);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;   // bits per colour
  head[9] = 2;   // red, green, blue
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The letters: 5 wide, 7 tall, '#' is ink
const GLYPHS = {
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
};
const GLYPH_W = 6;  // a letter and the gap after it, before scaling

/** A blank white picture to draw on: {w, h, px, dot, box, line, text}. Anything drawn off its edge is dropped. */
function canvas(w, h) {
  const px = Buffer.alloc(w * h * 3, 255);
  const dot = (x, y, c) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const i = (yi * w + xi) * 3;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  };
  const box = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = Math.round(x0); x <= Math.round(x1); x++) dot(x, y, c);
  };
  /** A straight line `thick` pixels wide. */
  const line = (x0, y0, x1, y1, c, thick) => {
    const t = Math.max(1, thick || 1);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const half = (t - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      if (t === 1) dot(x, y, c);
      else box(x - half, y - half, x + half, y + half, c);
    }
  };
  /** `str` with its top-left corner at (x, y); a character the set lacks is left as a gap. */
  const text = (x, y, str, c, scale) => {
    const k = Math.max(1, scale || 1);
    String(str).toUpperCase().split('').forEach((ch, n) => {
      const g = GLYPHS[ch];
      if (!g) return;
      g.forEach((bits, gy) => bits.split('').forEach((b, gx) => {
        if (b === '#') box(x + (n * GLYPH_W + gx) * k, y + gy * k, x + (n * GLYPH_W + gx + 1) * k - 1, y + (gy + 1) * k - 1, c);
      }));
    });
  };
  return { w, h, px, dot, box, line, text };
}

function textWidth(str, scale) { return String(str).length * GLYPH_W * Math.max(1, scale || 1); }

/** The top of the count axis and the step between its lines: round numbers, four to six lines, never below 1 a step. */
function axis(max) {
  const top = Math.max(1, Number(max) || 0);
  const rough = top / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map(m => m * pow).find(v => v >= rough) || 10 * pow);
  return { step, top: Math.ceil(top / step) * step };
}

const commas = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * The hourly chart of `points` ([{label, n}], oldest first) as {png (a Buffer), width, height}; the picture is drawn at
 * twice the size it is meant to be shown at (width x height), so it stays sharp. null with fewer than two points:
 * there is no line to draw.
 */
function lineChart(points) {
  const pts = (points || []).filter(p => p && Number.isFinite(Number(p.n)));
  if (pts.length < 2) return null;
  const W = 1360;
  const H = 560;
  const K = 3;  // the letters' size
  const left = 120;
  const right = 40;
  const top = 28;
  const bottom = 72;
  const c = canvas(W, H);
  const ink = [32, 33, 36];
  const grid = [208, 208, 208];
  const faint = [232, 232, 232];
  const blue = [66, 133, 244];
  const a = axis(Math.max.apply(null, pts.map(p => Number(p.n))));
  const x = i => left + ((W - left - right) * i) / (pts.length - 1);
  const y = n => H - bottom - ((H - top - bottom) * n) / a.top;
  for (let v = 0; v <= a.top + 1e-9; v += a.step) {
    c.line(left, y(v), W - right, y(v), v === 0 ? ink : grid, v === 0 ? 2 : 1);
    const label = commas(v);
    c.text(left - 14 - textWidth(label, K), y(v) - (7 * K) / 2, label, ink, K);
  }
  // The hours named along the bottom: as many as fit without touching (five at most), the first one always
  const room = Math.max(1, Math.floor((W - left - right) / (textWidth('(00/00) 00AM', K) + 30)));
  const every = Math.max(1, Math.ceil((pts.length - 1) / Math.min(5, room)));
  let taken = -Infinity;  // where the last label written ends: one that would touch it is left out
  pts.forEach((p, i) => {
    if (i % every !== 0) return;
    const wide = textWidth(p.label, K);
    const at = Math.max(4, Math.min(W - wide - 4, x(i) - wide / 2));
    if (at < taken + 30) return;
    c.line(x(i), top, x(i), H - bottom, faint, 1);
    c.text(at, H - bottom + 18, p.label, ink, K);
    taken = at + wide;
  });
  for (let i = 1; i < pts.length; i++) c.line(x(i - 1), y(Number(pts[i - 1].n)), x(i), y(Number(pts[i].n)), blue, 5);
  return { png: encode(W, H, c.px), width: W / 2, height: H / 2 };
}

module.exports = { encode, crc32, canvas, axis, lineChart, textWidth };
