// Generates realistic handwriting strokes for the demo notes from the Hershey
// "Felix" single-line font, with natural variation (pressure, wobble, slant,
// per-word drift). Output: src/lib/vault/seedInk.json
//
//   node scripts/build-seed.mjs [--preview out.html]

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const hershey = require('hersheytext');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Deterministic PRNG so the seed is stable between builds.
let seed = 1337;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const rr = (a, b) => a + (b - a) * rand();

const FONT = 'ems_felix';
const CAP_UNITS = 665;
let sid = 0;
const nextId = () => `seed${(sid++).toString(36)}`;

function parsePath(d) {
  const tokens = d.trim().split(/[\s,]+/);
  const subpaths = [];
  let cur = null;
  let cmd = 'M';
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    if (/^[ML]$/i.test(t)) {
      cmd = t.toUpperCase();
      i++;
      continue;
    }
    const x = parseFloat(tokens[i]);
    const y = parseFloat(tokens[i + 1]);
    i += 2;
    if (cmd === 'M') {
      cur = [[x, y]];
      subpaths.push(cur);
      cmd = 'L';
    } else cur.push([x, y]);
  }
  return subpaths;
}

/** Catmull-Rom resampling for smooth, pen-like curves. */
function smooth(points, perSeg = 5) {
  if (points.length < 3) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.min(perSeg, Math.round(len / 1.6)));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function toStroke(points, { color = '#1c1c1e', brush = 'fountain', size = 2.1, wobble = 0.45 } = {}) {
  const ph3 = rr(0, 6.28);
  const ph1 = rr(0, 6.28);
  const ph2 = rr(0, 6.28);
  const pts = [];
  const n = points.length;
  points.forEach(([x, y], i) => {
    const t = n > 1 ? i / (n - 1) : 0.5;
    const wx = Math.sin(i * 0.21 + ph1) * wobble + rr(-0.08, 0.08);
    const wy = Math.cos(i * 0.17 + ph2) * wobble + rr(-0.08, 0.08);
    const p = Math.min(1, 0.36 + 0.46 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.5) + Math.sin(i * 0.09 + ph3) * 0.04);
    pts.push(+(x + wx).toFixed(2), +(y + wy).toFixed(2), +p.toFixed(2));
  });
  return { id: nextId(), brush, color, size, pts, pressure: true };
}

/**
 * Writes `text` with its baseline at (x, y). `cap` is the capital height in px.
 * Returns { strokes, width }.
 */
function write(text, x, y, { cap = 17, color, size, brush = 'ballpoint', tracking = 1, slant = 0 } = {}) {
  size = size ?? Math.max(1.05, Math.min(1.75, cap * 0.088));
  const s = cap / CAP_UNITS;
  const glyphs = hershey.renderTextArray(text, { font: FONT });
  const strokes = [];
  let cursor = x;
  let wordDy = rr(-0.8, 0.8);
  let wordScale = rr(0.96, 1.04);
  for (const g of glyphs) {
    if (g.type === ' ' || !g.d) {
      cursor += g.width * s * 0.85 * tracking;
      wordDy = rr(-1, 1);
      wordScale = rr(0.95, 1.05);
      continue;
    }
    for (const sub of parsePath(g.d)) {
      const pts = sub.map(([gx, gy]) => {
        const px = cursor + gx * s * wordScale + gy * s * slant;
        const py = y - gy * s * wordScale + wordDy;
        return [px, py];
      });
      strokes.push(toStroke(smooth(pts), { color, size, brush }));
    }
    cursor += (g.width * s + rr(-0.4, 0.6)) * tracking;
  }
  return { strokes, width: cursor - x };
}

/** Freehand-looking line between points (slightly curved, tapered). */
function line(points, opts = {}) {
  const dense = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.round(len / 3));
    const bow = rr(-1.2, 1.2);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const nx = -(by - ay) / (len || 1);
      const ny = (bx - ax) / (len || 1);
      const b = Math.sin(Math.PI * t) * bow;
      dense.push([ax + (bx - ax) * t + nx * b, ay + (by - ay) * t + ny * b]);
    }
  }
  dense.push(points[points.length - 1]);
  return toStroke(dense, { wobble: 0.3, ...opts });
}

function ellipse(cx, cy, rx, ry, opts = {}, { start = rr(0, 6.28), sweep = 6.6, rot = 0 } = {}) {
  const pts = [];
  const n = Math.round((Math.max(rx, ry) * sweep) / 3);
  for (let i = 0; i <= n; i++) {
    const t = start + (i / n) * sweep;
    const r = 1 + Math.sin(t * 3 + start) * 0.025;
    const x = rx * Math.cos(t) * r;
    const y = ry * Math.sin(t) * r;
    pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return toStroke(pts, { wobble: 0.5, ...opts });
}

function arrow(x0, y0, x1, y1, opts = {}) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const head = 9;
  const a1 = ang + Math.PI - 0.5;
  const a2 = ang + Math.PI + 0.5;
  return [
    line(
      [
        [x0, y0],
        [x1, y1],
      ],
      opts,
    ),
    line(
      [
        [x1 + Math.cos(a1) * head, y1 + Math.sin(a1) * head],
        [x1, y1],
        [x1 + Math.cos(a2) * head, y1 + Math.sin(a2) * head],
      ],
      opts,
    ),
  ];
}

/** Hand-drawn θ (not in the Hershey font). Returns strokes and width. */
function theta(x, y, cap = 13, opts = {}) {
  const rx = cap * 0.3;
  const ry = cap * 0.5;
  return {
    strokes: [
      ellipse(x + rx, y - ry, rx, ry, { size: 1.3, ...opts }, { sweep: 6.5 }),
      line(
        [
          [x + 1, y - ry],
          [x + rx * 2 - 1, y - ry],
        ],
        { size: 1.2, ...opts },
      ),
    ],
    width: rx * 2 + 4,
  };
}

/** Writes pieces one after another: strings, {sub}/{sup} scripts or θ. */
function seq(x, y, parts, { cap = 14, color } = {}) {
  const strokes = [];
  let cx = x;
  for (const part of parts) {
    let r;
    if (typeof part === 'string') r = write(part, cx, y, { cap, color });
    else if (part.sub) r = write(part.sub, cx + 1, y + cap * 0.35, { cap: cap * 0.62, color });
    else if (part.sup) r = write(part.sup, cx + 1, y - cap * 0.75, { cap: cap * 0.62, color });
    else if (part.theta) r = theta(cx + 2, y, cap, { color });
    strokes.push(...r.strokes);
    cx += r.width + (part.sub || part.sup ? 3 : 1);
  }
  return { strokes, width: cx - x };
}

function highlight(x0, x1, y, color = '#ffe14d', size = 18) {
  const pts = [];
  const n = Math.round((x1 - x0) / 4);
  for (let i = 0; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y + Math.sin(i / 3) * 0.4]);
  return { id: nextId(), brush: 'highlighter', color, size, pts: pts.flatMap(([x, yy]) => [+x.toFixed(2), +yy.toFixed(2), 0.5]), pressure: false };
}

// Baselines sit on the ruled lines of a 32px grid.
const L = 32;
const base = (row) => row * L + 23;
const INK = '#1c1c1e';
const BLUE = '#2160e8';
const RED = '#dc2b2b';
const GREEN = '#1f9d4c';

const out = {};

// --- Welcome note -----------------------------------------------------------
{
  const s = [];
  s.push(...write('Hi! This line was written by hand.', 4, base(0), { cap: 17 }).strokes);
  const w2 = write('Type below it, or keep writing', 4, base(1), { cap: 17, color: BLUE });
  s.push(...w2.strokes);
  s.push(...arrow(w2.width + 16, base(1) - 6, w2.width + 52, base(1) - 6, { color: BLUE, size: 1.8 }));
  s.push(highlight(2, 150, base(0) - 6, '#ffe14d', 16));
  out.welcome = s;
}

// --- Calculus: worked example -------------------------------------------------
{
  const s = [];
  // Problem statement
  s.push(...write('Ex.  Find', 4, base(0), { cap: 16 }).strokes);
  // lim (x^2 - 9)/(x - 3) as x -> 3
  const lx = 110;
  s.push(...write('lim', lx, base(0) + 2, { cap: 16 }).strokes);
  s.push(...write('x', lx - 2, base(0) + 18, { cap: 10 }).strokes);
  s.push(...arrow(lx + 9, base(0) + 14, lx + 22, base(0) + 14, { size: 1.4 }));
  s.push(...write('3', lx + 25, base(0) + 18, { cap: 10 }).strokes);
  const fx = lx + 46;
  s.push(...write('x', fx + 6, base(0) - 13, { cap: 15 }).strokes);
  s.push(...write('2', fx + 18, base(0) - 22, { cap: 9 }).strokes);
  s.push(...write('- 9', fx + 29, base(0) - 13, { cap: 15 }).strokes);
  s.push(
    line(
      [
        [fx, base(0) - 5],
        [fx + 66, base(0) - 5],
      ],
      { size: 1.8 },
    ),
  );
  s.push(...write('x - 3', fx + 10, base(0) + 14, { cap: 15 }).strokes);
  // Step 1: factor
  s.push(...write('=', 96, base(2), { cap: 15 }).strokes);
  s.push(...write('lim', lx, base(2) + 2, { cap: 16 }).strokes);
  s.push(...write('(x - 3)(x + 3)', fx + 2, base(2) - 13, { cap: 14 }).strokes);
  s.push(
    line(
      [
        [fx - 2, base(2) - 5],
        [fx + 120, base(2) - 5],
      ],
      { size: 1.8 },
    ),
  );
  s.push(...write('x - 3', fx + 34, base(2) + 14, { cap: 14 }).strokes);
  // Step 2: cancel (student crossed out the factors)
  s.push(
    line(
      [
        [fx + 4, base(2) - 9],
        [fx + 50, base(2) - 26],
      ],
      { color: RED, size: 1.6 },
    ),
  );
  s.push(
    line(
      [
        [fx + 32, base(2) + 17],
        [fx + 82, base(2)],
      ],
      { color: RED, size: 1.6 },
    ),
  );
  s.push(...write('=', 96, base(4), { cap: 15 }).strokes);
  s.push(...write('lim  (x + 3)', lx, base(4), { cap: 16 }).strokes);
  s.push(...write('=', 96, base(5), { cap: 15 }).strokes);
  s.push(...write('?', lx + 4, base(5), { cap: 17, color: RED }).strokes);
  s.push(...write('<- stuck here, ask the tutor', lx + 40, base(5), { cap: 13, color: BLUE }).strokes);
  out.calcExample = s;

  // Margin note on the squeeze theorem paragraph (annotation)
  out.calcAnnotation = [
    ...write('on the exam!', 222, 22, { cap: 14, color: RED }).strokes,
    ellipse(266, 15, 54, 15, { color: RED, size: 1.5 }),
    ...arrow(206, 16, 184, 16, { color: RED, size: 1.3 }),
  ];
  // Highlighter over the definition sentence
  out.calcHighlight = [highlight(0, 340, 16, '#ffe14d', 17)];
}

// --- Biology: cell diagram ------------------------------------------------------
{
  const s = [];
  const cx = 250;
  const cy = 150;
  s.push(ellipse(cx, cy, 200, 118, { size: 2.4, color: GREEN }));
  s.push(ellipse(cx - 30, cy - 10, 58, 46, { size: 2, color: '#7346e6' }));
  s.push(ellipse(cx - 34, cy - 8, 16, 13, { size: 1.8, color: '#7346e6' }));
  // mitochondria
  s.push(ellipse(cx + 100, cy + 40, 36, 15, { size: 1.8, color: '#e35d14' }, { rot: -0.4 }));
  const zig = [];
  for (let i = 0; i < 9; i++) zig.push([cx + 74 + i * 6.5, cy + 52 - (i % 2) * 12 - i * 2.6]);
  s.push(line(zig, { size: 1.2, color: '#e35d14' }));
  // ribosomes (dots)
  for (const [dx, dy] of [
    [60, -70],
    [80, -55],
    [-120, 50],
    [-100, 70],
    [20, 80],
    [140, -20],
  ]) {
    s.push(ellipse(cx + dx, cy + dy, 2.6, 2.6, { size: 2, wobble: 0.05 }, { sweep: 6.5 }));
  }
  // labels
  const l1 = write('cell membrane', 478, 40, { cap: 13 });
  s.push(...l1.strokes, ...arrow(474, 38, cx + 158, cy - 66, { size: 1.3 }));
  const l2 = write('nucleus', -40, 28, { cap: 13 });
  s.push(...l2.strokes, ...arrow(-40 + l2.width + 4, 26, cx - 82, cy - 36, { size: 1.3 }));
  const l3 = write('mitochondrion (ATP)', 478, 298, { cap: 13 });
  s.push(...l3.strokes, ...arrow(474, 290, cx + 132, cy + 54, { size: 1.3 }));
  const l4 = write('nucleolus', 100, 304, { cap: 13 });
  s.push(...l4.strokes, ...arrow(100 + l4.width / 2, 288, cx - 36, cy + 8, { size: 1.3 }));
  out.cell = s;
}

// --- Physics: projectile sketch ---------------------------------------------------
{
  const s = [];
  const ox = 30;
  const oy = 230;
  s.push(
    line(
      [
        [ox, oy],
        [ox + 560, oy],
      ],
      { size: 1.6 },
    ),
  );
  s.push(
    line(
      [
        [ox, oy],
        [ox, oy - 210],
      ],
      { size: 1.6 },
    ),
  );
  const para = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    para.push([ox + t * 500, oy - 4 * 160 * t * (1 - t)]);
  }
  s.push(toStroke(smooth(para, 2), { color: BLUE, size: 2.2, wobble: 0.6 }));
  s.push(...arrow(ox, oy, ox + 70, oy - 90, { color: RED, size: 1.8 }));
  s.push(...seq(ox + 74, oy - 92, ['v', { sub: '0' }], { cap: 15, color: RED }).strokes);
  s.push(ellipse(ox, oy, 34, 34, { size: 1.3 }, { start: -0.95, sweep: 0.9 }));
  s.push(...theta(ox + 40, oy - 8, 13).strokes);
  s.push(...arrow(ox + 250, oy - 160, ox + 320, oy - 160, { color: RED, size: 1.6 }));
  s.push(...seq(ox + 222, oy - 176, ['v', { sub: 'x' }, ' = v', { sub: '0' }, ' cos ', { theta: true }], { cap: 13, color: RED }).strokes);
  s.push(...arrow(ox + 250, oy - 160, ox + 250, oy - 110, { color: GREEN, size: 1.6 }));
  s.push(...write('g', ox + 256, oy - 116, { cap: 13, color: GREEN }).strokes);
  s.push(...write('range R', ox + 470, oy + 24, { cap: 13 }).strokes);
  out.projectile = s;
}

// --- Inline sketch glyph (for the welcome checklist) ------------------------------
{
  // A hand-drawn "⇒" in inline-ink capture units (em = 80, baseline at y = 74).
  const opts = { size: 5.5, color: 'currentColor' };
  out.inlineImplies = [
    line(
      [
        [4, 44],
        [50, 43],
      ],
      opts,
    ),
    line(
      [
        [4, 58],
        [50, 57.5],
      ],
      opts,
    ),
    line(
      [
        [38, 33],
        [58, 50.5],
        [37, 68],
      ],
      opts,
    ),
  ];
}

// The felt marker is the only pen: each stroke becomes a marker stroke drawn as wide as before
// (BRUSHES sizeScale: fountain 1.25, ballpoint 1, marker 1.6). Highlighter and clean shapes stay.
const SIZE_SCALE = { fountain: 1.25, ballpoint: 1 };
for (const strokes of Object.values(out))
  for (const st of strokes)
    if (SIZE_SCALE[st.brush]) {
      st.size = +((st.size * SIZE_SCALE[st.brush]) / 1.6).toFixed(3);
      st.brush = 'marker';
    }

const file = path.join(root, 'src/lib/vault/seedInk.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log('wrote', file, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));

const previewIdx = process.argv.indexOf('--preview');
if (previewIdx > 0) {
  const outPath = process.argv[previewIdx + 1];
  const { getStroke } = await import('perfect-freehand');
  const toD = (st) => {
    const pts = [];
    for (let i = 0; i < st.pts.length; i += 3) pts.push([st.pts[i], st.pts[i + 1], st.pts[i + 2]]);
    const o = getStroke(pts, {
      size: st.size * (st.brush === 'highlighter' ? 1 : 1.6),
      thinning: 0,
      smoothing: 0.62,
      streamline: 0.42,
      last: true,
    });
    if (!o.length) return '';
    return 'M' + o.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L') + 'Z';
  };
  let y = 20;
  let body = '';
  for (const [k, strokes] of Object.entries(out)) {
    body += `<text x="10" y="${y}" font-size="12" fill="#999">${k}</text><g transform="translate(90 ${y + 10})">`;
    for (const st of strokes)
      body += `<path d="${toD(st)}" fill="${st.color === 'currentColor' ? '#000' : st.color}" ${st.brush === 'highlighter' ? 'opacity=".4"' : ''}/>`;
    body += '</g>';
    y += 360;
  }
  fs.writeFileSync(outPath, `<html><body style="margin:0"><svg width="900" height="${y}">${body}</svg></body></html>`);
}
