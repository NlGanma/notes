import type { Bounds, Stroke } from '../../lib/ink/types';
import { BRUSHES } from '../../lib/ink/brushes';
import { distToSegmentSq, pathLength } from '../../lib/ink/geometry';

/**
 * Geometry for picking handwriting up and putting it down again: which
 * strokes belong together (a "blob": a word, a symbol, a drawing), where a
 * dragged blob snaps to, and which block it lands in.
 *
 * Everything is in layer coordinates: CSS px at zoom 1, x from the left edge
 * of the text column, y from the top of the column. Pure functions only, so
 * the unit tests can run them without a browser.
 */

/** A stored stroke plus the top of the block that owns it. */
export interface PlacedStroke {
  stroke: Stroke;
  top: number;
}

/** The part of a measured block that drop decisions need. */
export interface ZoneBlock {
  id: string;
  type: string;
  top: number;
  zoneStart: number;
  zoneEnd: number;
}

// ------------------------------------------------------------------ ruled lines

/**
 * Ruled lines sit three quarters of the way down each line of the grid
 * (doc.css shifts the 1px rule up by a quarter line), which is where typed
 * text has its baseline.
 */
export function ruleY(k: number, line: number): number {
  return (k + 0.75) * line - 1;
}

export function nearestRule(y: number, line: number): number {
  return ruleY(Math.round((y + 1) / line - 0.75), line);
}

/** Handwriting may dip this far below its ruled line (descenders); 9px at 32px lines, like ops.ts. */
export const descenderAllowance = (line: number) => line * 0.28;

// ------------------------------------------------------------------ strokes

const rawCache = new WeakMap<Stroke, Bounds>();

/** Bounds of the pen positions (strokeBounds also adds the stroke's width). */
export function rawBounds(stroke: Stroke): Bounds {
  let b = rawCache.get(stroke);
  if (!b) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const p = stroke.pts;
    for (let i = 0; i + 1 < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
    b = { minX, minY, maxX, maxY };
    rawCache.set(stroke, b);
  }
  return b;
}

const shift = (b: Bounds, dy: number): Bounds => ({ minX: b.minX, minY: b.minY + dy, maxX: b.maxX, maxY: b.maxY + dy });

/** Half the painted width of a stroke. */
export function halfWidth(stroke: Stroke): number {
  if (stroke.brush === 'mono') return stroke.size / 2;
  return (stroke.size * (BRUSHES[stroke.brush]?.sizeScale ?? 1)) / 2;
}

/**
 * True when (x, y) is on the painted stroke, give or take `slop`. Tighter than
 * hitStroke: a wide highlighter must not swallow every press on its text line.
 */
export function touchesStroke(stroke: Stroke, top: number, x: number, y: number, slop: number): boolean {
  const r = halfWidth(stroke) + slop;
  const b = rawBounds(stroke);
  if (x < b.minX - r || x > b.maxX + r || y < b.minY + top - r || y > b.maxY + top + r) return false;
  const p = stroke.pts;
  const ly = y - top;
  const r2 = r * r;
  if (p.length < 6) return (p[0] - x) ** 2 + (p[1] - ly) ** 2 <= r2;
  for (let i = 0; i + 4 < p.length; i += 3) if (distToSegmentSq(x, ly, p[i], p[i + 1], p[i + 3], p[i + 4]) <= r2) return true;
  if (stroke.closed) {
    const n = p.length - 3;
    if (distToSegmentSq(x, ly, p[n], p[n + 1], p[0], p[1]) <= r2) return true;
  }
  return false;
}

/** Index of the stroke under the point: pen ink before highlighter, newest first. */
export function strokeAt(items: PlacedStroke[], x: number, y: number, slop: number): number {
  let hl = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const { stroke, top } = items[i];
    if (stroke.brush === 'highlighter') {
      if (hl < 0 && touchesStroke(stroke, top, x, y, slop)) hl = i;
    } else if (touchesStroke(stroke, top, x, y, slop)) return i;
  }
  return hl;
}

// ------------------------------------------------------------------ blobs

const SMALL = 0;
const ANCHOR = 1;
const TALL = 2;

const gapX = (a: Bounds, b: Bounds) => Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
const gapY = (a: Bounds, b: Bounds) => Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
const midY = (b: Bounds) => (b.minY + b.maxY) / 2;

/** Entirely inside (a loop's own letters overlap their neighbours, a circle drawn around a word holds all of it). */
function inside(outer: Bounds, inner: Bounds): boolean {
  return inner.minX > outer.minX && inner.maxX < outer.maxX && inner.minY > outer.minY && inner.maxY < outer.maxY;
}

/** A stroke that comes back to where it started: a circle or box drawn around something. */
export function isLoop(stroke: Stroke): boolean {
  if (stroke.closed) return true;
  const p = stroke.pts;
  if (p.length < 12) return false;
  const b = rawBounds(stroke);
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  return Math.hypot(p[0] - p[p.length - 3], p[1] - p[p.length - 2]) <= size * 0.3 && pathLength(p) >= size * 2.2;
}

/** True when the stroke's path (not just its box) comes within `d` of a box. */
function pathNear(item: PlacedStroke, box: Bounds, d: number): boolean {
  const p = item.stroke.pts;
  const r = d + halfWidth(item.stroke);
  for (let i = 0; i + 1 < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1] + item.top;
    const dx = Math.max(0, box.minX - x, x - box.maxX);
    const dy = Math.max(0, box.minY - y, y - box.maxY);
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)];
};

/**
 * The blob a press on stroke `seed` picks up, as indices into `items`.
 *
 * Letters belong together when they are on the same ruled line and closer
 * than about half their own height; a stroke's line is read from its bottom,
 * since letters stand on the line and descenders may dip below it. The gap is
 * measured across the letters' bodies (between the baseline and the middle of
 * the small letters), so tails of f, g and y reaching sideways don't join two
 * words. Small marks floating above the letters (i-dots, crossbars, accents)
 * join the letter they sit over and never link two lines. A loop drawn around
 * something holds what is inside it, and tall strokes (drawings, brackets)
 * connect to whatever their line touches.
 */
export function clusterBlob(items: PlacedStroke[], seed: number, line: number): number[] {
  const n = items.length;
  if (seed < 0 || seed >= n) return [];
  const g = linkStrokes(items, line);
  // A tall loop picked up by its outline (a cell with its parts drawn inside,
  // a box around a diagram) brings what is inside it.
  if (g.kind[seed] === TALL && g.loop(seed)) {
    for (let o = 0; o < n; o++) if (o !== seed && g.hl[o] === g.hl[seed] && inside(g.raw[seed], g.raw[o])) g.union(seed, o);
  }
  const r = g.find(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (g.find(i) === r) out.push(i);
  return out;
}

/** Every blob on the page, as lists of indices into `items`. */
export function blobGroups(items: PlacedStroke[], line: number): number[][] {
  const g = linkStrokes(items, line);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const r = g.find(i);
    const list = groups.get(r);
    if (list) list.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()];
}

function linkStrokes(items: PlacedStroke[], line: number) {
  const n = items.length;
  const gap = line * 0.2;
  const maxGap = line * 0.3;
  const allow = descenderAllowance(line);
  const raw: Bounds[] = [];
  const kind: number[] = [];
  const row: number[] = [];
  const hl: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const { stroke, top } = items[i];
    const r = shift(rawBounds(stroke), top);
    raw.push(r);
    kind.push(r.maxY - r.minY > line * 1.25 ? TALL : ANCHOR);
    row.push(Math.floor((r.maxY - allow) / line));
    hl.push(stroke.brush === 'highlighter');
  }
  // Small marks (dots, bars, accents) are small next to the letters around
  // them, not next to the ruled line: in small writing, or writing done
  // zoomed in, every letter is shorter than a quarter of a line.
  const heights = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const h = raw[i].maxY - raw[i].minY;
    if (kind[i] === TALL || h < line * 0.1) continue;
    const list = heights.get(row[i]);
    if (list) list.push(h);
    else heights.set(row[i], [h]);
  }
  for (let i = 0; i < n; i++) {
    if (kind[i] === TALL) continue;
    const list = heights.get(row[i]) ?? [];
    const cut = list.length >= 3 ? Math.min(line * 0.25, quantile(list, 0.5) * 0.6) : line * 0.25;
    if (raw[i].maxY - raw[i].minY < cut && raw[i].maxX - raw[i].minX <= line * 1.5) kind[i] = SMALL;
  }

  // Each written line: how far apart its letters may be, and where their bodies are.
  const rowKey = (i: number) => `${hl[i]}:${row[i]}`;
  const rows = new Map<string, { heights: number[]; bottoms: number[]; size: number; gap: number; top: number; bottom: number }>();
  for (let i = 0; i < n; i++) {
    if (kind[i] !== ANCHOR) continue;
    const key = rowKey(i);
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { heights: [], bottoms: [], size: line * 0.35, gap, top: 0, bottom: 0 }));
    r.heights.push(raw[i].maxY - raw[i].minY);
    r.bottoms.push(raw[i].maxY);
  }
  for (const r of rows.values()) {
    // The small letters set the size of the writing (capitals, ascenders and descenders vary).
    const h = quantile(r.heights, 0.3);
    const base = quantile(r.bottoms, 0.5);
    r.size = h;
    r.gap = Math.min(maxGap, Math.max(line * 0.12, h * 0.5));
    r.top = base - h;
    r.bottom = base + 0.5;
  }
  const rowGap = (i: number) => rows.get(rowKey(i))?.gap ?? gap;
  const body = new Map<number, [number, number]>();
  const bodyX = (i: number): [number, number] => {
    let b = body.get(i);
    if (!b) {
      const r = rows.get(rowKey(i));
      let lo = Infinity;
      let hi = -Infinity;
      if (r) {
        const p = items[i].stroke.pts;
        const top = items[i].top;
        for (let k = 0; k + 1 < p.length; k += 3) {
          const y = p[k + 1] + top;
          if (y >= r.top && y <= r.bottom) {
            lo = Math.min(lo, p[k]);
            hi = Math.max(hi, p[k]);
          }
        }
      }
      b = lo <= hi ? [lo, hi] : [raw[i].minX, raw[i].maxX];
      body.set(i, b);
    }
    return b;
  };

  const touching = (i: number, j: number) => gapX(raw[i], raw[j]) <= gap && gapY(raw[i], raw[j]) <= gap;
  // Dots and accents float a little higher above their letter than letters stand apart.
  const touchingMark = (i: number, j: number) => {
    const g = Math.max(rowGap(i), rowGap(j));
    return gapX(raw[i], raw[j]) <= g && gapY(raw[i], raw[j]) <= g * 1.5;
  };

  // Candidate pairs: sweep down the page; nothing more than a line apart is related.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => raw[a].minY - raw[b].minY);
  const pairs: [number, number][] = [];
  for (let a = 0; a < n; a++) {
    const i = order[a];
    for (let c = a + 1; c < n; c++) {
      const j = order[c];
      if (raw[j].minY > raw[i].maxY + line) break;
      if (hl[i] === hl[j] && gapX(raw[i], raw[j]) <= maxGap) pairs.push([i, j]);
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  // Loops that have something inside them.
  const loops = new Map<number, boolean>();
  const isLoopAt = (i: number) => {
    let v = loops.get(i);
    if (v === undefined) loops.set(i, (v = kind[i] !== SMALL && isLoop(items[i].stroke)));
    return v;
  };
  const encl = new Array<boolean>(n).fill(false);
  for (const [i, j] of pairs) {
    // (holding a whole letter, not just a neighbour's dot)
    if (kind[j] !== SMALL && isLoopAt(i) && inside(raw[i], raw[j])) encl[i] = true;
    if (kind[i] !== SMALL && isLoopAt(j) && inside(raw[j], raw[i])) encl[j] = true;
  }

  // 1. Letters on one line, loops with their contents, tall strokes with what they touch.
  const marks: number[][] = Array.from({ length: n }, () => []);
  for (const [i, j] of pairs) {
    if (encl[i] || encl[j]) {
      const e = encl[i] ? i : j;
      const o = e === i ? j : i;
      // A small loop takes what is inside it; a big box only what its line touches.
      const held = inside(raw[e], raw[o]);
      if (held ? kind[e] !== TALL || pathNear(items[e], raw[o], gap) : kind[e] === TALL && touching(e, o) && pathNear(items[e], raw[o], gap)) union(i, j);
      continue;
    }
    if (kind[i] === SMALL || kind[j] === SMALL) {
      if (touchingMark(i, j)) {
        marks[i].push(j);
        marks[j].push(i);
      }
      continue;
    }
    if (kind[i] === TALL || kind[j] === TALL) {
      if (touching(i, j) && (kind[i] !== TALL || pathNear(items[i], raw[j], gap)) && (kind[j] !== TALL || pathNear(items[j], raw[i], gap))) union(i, j);
      continue;
    }
    // Same line: only the gap between the letters' bodies matters.
    if (row[i] === row[j]) {
      const a = bodyX(i);
      const b = bodyX(j);
      if (Math.max(0, a[0] - b[1], b[0] - a[1]) <= rowGap(i)) union(i, j);
    }
  }

  // 2. A small mark joins the letter it sits over or crosses: letters above it
  // (a descender from the line above) count as further away, letters right
  // under it as closer, ties go to the line below. A mark above its letter
  // (a T's bar) also joins the letters it reaches over on that line; a mark
  // on the baseline (a comma) joins just one, so it can't link two words.
  const anchorsByRow = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (kind[i] !== ANCHOR || encl[i]) continue;
    const key = `${hl[i]}:${row[i]}`;
    const list = anchorsByRow.get(key);
    if (list) list.push(i);
    else anchorsByRow.set(key, [i]);
  }
  const attached = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== SMALL) continue;
    const mark = raw[i];
    const markCy = midY(mark);
    const markW = Math.max(1, mark.maxX - mark.minX);
    let best = -1;
    let bestD = Infinity;
    for (const j of marks[i]) {
      if (kind[j] === SMALL || encl[j]) continue;
      if (kind[j] === TALL ? !pathNear(items[j], mark, gap) : row[j] !== row[i] && row[j] !== row[i] + 1) continue;
      const b = raw[j];
      // (a stem has no width of its own, so "over it" allows a little either side)
      const overlap = Math.max(0, Math.min(mark.maxX, b.maxX + gap / 2) - Math.max(mark.minX, b.minX - gap / 2)) / markW;
      const d = Math.hypot(gapX(mark, b), gapY(mark, b)) + (midY(b) < markCy ? line * 0.15 : 0) - (overlap >= 0.5 ? line * 0.1 : 0);
      if (d < bestD - 0.01 || (best >= 0 && Math.abs(d - bestD) <= 0.01 && row[j] > row[best])) {
        best = j;
        bestD = d;
      }
    }
    if (best < 0) continue;
    union(i, best);
    attached[i] = true;
    if (kind[best] !== ANCHOR || markCy >= midY(raw[best])) continue;
    const reach = rowGap(best) / 2;
    // (a letter clearly below the bar, not one level with it like the n before a t)
    const under = mark.maxY + (rows.get(rowKey(best))?.size ?? 0) * 0.2;
    for (const j of anchorsByRow.get(`${hl[i]}:${row[best]}`) ?? []) {
      if (gapX(mark, raw[j]) <= reach && (gapY(mark, raw[j]) <= reach || raw[j].minY >= under)) union(i, j);
    }
  }

  // 3. Marks with no letter to join (an ellipsis, very small writing) group
  // along their line like letters do, then join at most one neighbour.
  for (const [i, j] of pairs) if (kind[i] === SMALL && kind[j] === SMALL && !attached[i] && !attached[j] && row[i] === row[j]) union(i, j);
  const joined = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (kind[i] !== SMALL || attached[i]) continue;
    const root = find(i);
    if (joined.has(root)) continue;
    joined.add(root);
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      if (kind[k] !== SMALL || attached[k] || find(k) !== root) continue;
      for (const j of marks[k]) {
        if (kind[j] !== SMALL || !attached[j] || row[j] !== row[k]) continue;
        const d = gapX(raw[k], raw[j]);
        if (d < bestD) {
          best = j;
          bestD = d;
        }
      }
    }
    if (best >= 0) union(root, best);
  }

  return { find, union, kind, raw, hl, loop: isLoopAt };
}

// ------------------------------------------------------------------ baseline

/** Lowest points of a stroke: where the pen stops going down (with a little hysteresis). */
function localBottoms(stroke: Stroke, top: number, hy: number, out: number[]) {
  const pts = stroke.pts;
  const { minY, maxY } = rawBounds(stroke);
  // A stroke may start or end on a bottom (an "l" drawn downwards), but a loop
  // that starts and ends halfway up does not.
  const endOk = (y: number) => y >= maxY - (maxY - minY) * 0.25;
  let state = 0; // 0 = not moving yet, 1 = going down the page, -1 = going up
  const y0 = pts[1];
  let low = y0; // lowest point of the current down-run (largest y)
  let high = y0; // highest point of the current up-run
  let startLow = y0;
  for (let i = 4; i < pts.length; i += 3) {
    const y = pts[i];
    if (state === 0) {
      startLow = Math.max(startLow, y);
      if (y - y0 > hy) {
        state = 1;
        low = y;
      } else if (startLow - y > hy) {
        // Started on its lowest point and went up (the second stroke of an "n").
        if (endOk(startLow)) out.push(startLow + top);
        state = -1;
        high = y;
      }
    } else if (state === 1) {
      if (y > low) low = y;
      else if (low - y > hy) {
        out.push(low + top);
        state = -1;
        high = y;
      }
    } else if (y < high) high = y;
    else if (y - high > hy) {
      state = 1;
      low = y;
    }
  }
  if (state === 1 && endOk(low)) out.push(low + top);
}

/**
 * Where handwriting sits: the height most of its strokes come down to. Dots
 * and crossbars are ignored, and descenders lose to the letters around them.
 * Returns null for highlighter-only blobs (they follow the text, not a line).
 */
export function estimateBaseline(items: PlacedStroke[], line: number): number | null {
  const ink = items.filter((it) => it.stroke.brush !== 'highlighter');
  if (!ink.length) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const it of ink) {
    const b = rawBounds(it.stroke);
    minY = Math.min(minY, b.minY + it.top);
    maxY = Math.max(maxY, b.maxY + it.top);
  }
  const tallEnough = Math.max(line * 0.15, (maxY - minY) * 0.2);
  const hy = Math.max(1, line * 0.04);
  const bottoms: number[] = [];
  for (const it of ink) {
    const b = rawBounds(it.stroke);
    if (b.maxY - b.minY < tallEnough) continue;
    localBottoms(it.stroke, it.top, hy, bottoms);
  }
  if (!bottoms.length) return maxY;
  bottoms.sort((a, b) => a - b);
  const win = Math.max(2.5, line * 0.1);
  let best = 0;
  let bestCount = 0;
  for (let i = 0, j = 0; i < bottoms.length; i++) {
    while (bottoms[j] < bottoms[i] - win) j++;
    // Ties keep the higher cluster: descenders hang below the baseline, not above it.
    if (i - j + 1 > bestCount) {
      bestCount = i - j + 1;
      best = i;
    }
  }
  let sum = 0;
  let count = 0;
  for (let k = best; k >= 0 && bottoms[k] >= bottoms[best] - win; k--) {
    sum += bottoms[k];
    count++;
  }
  return sum / count;
}

// ------------------------------------------------------------------ snapping

export interface SnapTarget {
  x: number;
  /** The text column's edge, the end of a line of text, or handwriting on the line above or below. */
  kind: 'margin' | 'text' | 'ink';
  /** For handwriting: how far up and down it reaches (so the guide can join the two). */
  top?: number;
  bottom?: number;
}

export interface SnapInput {
  /** The blob's box when the drag started. */
  box: Bounds;
  /** Its baseline when the drag started (null: keep its position relative to the lines). */
  baseline: number | null;
  dx: number;
  dy: number;
  line: number;
  /** How close (layer px) the blob's baseline must come to a ruled line to snap (half a line: always). */
  tol: number;
  /** How close its left edge must come to an edge to snap (defaults to `tol`). */
  xTol?: number;
  /** Where the blob's left edge may snap to. */
  xTargets?: SnapTarget[];
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** The ruled line the baseline snapped to. */
  rule: number | null;
  /** The x the left edge snapped to. */
  x: SnapTarget | null;
}

export function snapMove(s: SnapInput): SnapResult {
  let { dx, dy } = s;
  let rule: number | null = null;
  if (s.baseline !== null) {
    const b = s.baseline + dy;
    const r = nearestRule(b, s.line);
    if (Math.abs(r - b) <= s.tol) {
      dy += r - b;
      rule = r;
    }
  } else {
    // Highlights keep their place relative to the lines (and so to the text).
    const q = Math.round(dy / s.line) * s.line;
    if (Math.abs(q - dy) <= s.tol) {
      dy = q;
      rule = nearestRule(s.box.maxY + dy, s.line);
    }
  }
  let x: SnapTarget | null = null;
  const left = s.box.minX + dx;
  let bestD = s.xTol ?? s.tol;
  for (const t of s.xTargets ?? []) {
    const d = Math.abs(t.x - left);
    if (d <= bestD) {
      bestD = d;
      x = t;
    }
  }
  if (x) dx += x.x - left;
  return { dx, dy, rule, x };
}

// ------------------------------------------------------------------ dropping

/**
 * The one block a moved blob belongs to, chosen from its centre so a blob is
 * never split. Above the first block means the first block; below everything
 * means the last handwriting area if it is close, otherwise a new one (null).
 */
export function resolveDropTarget<B extends ZoneBlock>(blocks: B[], y: number, line: number): B | null {
  if (!blocks.length) return null;
  if (y < blocks[0].zoneStart) return blocks[0];
  for (const b of blocks) if (y >= b.zoneStart && y < b.zoneEnd) return b;
  const last = blocks[blocks.length - 1];
  if (last.type === 'inkBlock' && y - last.zoneEnd < line * 6) return last;
  return null;
}

// ------------------------------------------------------------------ selection box

/** The selection frame: never smaller than `min`, so small symbols stay easy to grab and resize. */
export function selectionFrame(b: Bounds, inv: number, min = 26): { core: Bounds; frame: Bounds } {
  const m = min * inv;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = Math.max(m, b.maxX - b.minX) / 2;
  const hh = Math.max(m, b.maxY - b.minY) / 2;
  const core = { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
  const pad = 6 * inv;
  return { core, frame: { minX: core.minX - pad, minY: core.minY - pad, maxX: core.maxX + pad, maxY: core.maxY + pad } };
}

/** Frame corners in handle order: top-left, top-right, bottom-left, bottom-right. */
export function frameCorners(f: Bounds): [number, number][] {
  return [
    [f.minX, f.minY],
    [f.maxX, f.minY],
    [f.minX, f.maxY],
    [f.maxX, f.maxY],
  ];
}

export type SelectionHit = { kind: 'inside' } | { kind: 'handle'; corner: number } | { kind: 'edge' } | null;

/**
 * What a press at `p` hits: inside the box (move), a corner handle where it is
 * drawn (resize), or the frame's margin (move). Inside wins over the handles.
 */
export function hitSelection(b: Bounds, p: { x: number; y: number }, inv: number): SelectionHit {
  const { core, frame } = selectionFrame(b, inv);
  if (p.x >= core.minX && p.x <= core.maxX && p.y >= core.minY && p.y <= core.maxY) return { kind: 'inside' };
  const r = 11 * inv;
  const corners = frameCorners(frame);
  for (let i = 0; i < 4; i++) if (Math.hypot(p.x - corners[i][0], p.y - corners[i][1]) <= r) return { kind: 'handle', corner: i };
  const m = 4 * inv;
  if (p.x >= frame.minX - m && p.x <= frame.maxX + m && p.y >= frame.minY - m && p.y <= frame.maxY + m) return { kind: 'edge' };
  return null;
}

// ------------------------------------------------------------------ autoscroll

/** Scroll speed (px per frame) for a pointer near the top or bottom edge of the visible page. */
export function autoscrollSpeed(y: number, top: number, bottom: number, zone = 44, max = 22): number {
  if (y < top + zone) return -max * Math.min(1, (top + zone - y) / zone) ** 2;
  if (y > bottom - zone) return max * Math.min(1, (y - (bottom - zone)) / zone) ** 2;
  return 0;
}

// ------------------------------------------------------------------ dropping into text

const WORD = /[\p{L}\p{N}_]/u;

/** Moves an offset that falls inside a word to the nearer end of that word. */
export function wordBoundary(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  if (!WORD.test(text[offset - 1]) || !WORD.test(text[offset])) return offset;
  let l = offset;
  while (l > 0 && WORD.test(text[l - 1])) l--;
  let r = offset;
  while (r < text.length && WORD.test(text[r])) r++;
  return offset - l <= r - offset ? l : r;
}

/** Spaces needed around a sketch dropped between `before` and `after`. */
export function inlineSpacing(before: string, after: string): { lead: boolean; trail: boolean } {
  return {
    lead: before.length > 0 && !/\s$/.test(before),
    trail: after.length > 0 && /^[\p{L}\p{N}([{]/u.test(after),
  };
}

/**
 * Scale (≤ 1) that fits a sketch into a line of text without making the line
 * taller: `above` / `below` are its extent around the baseline, `room*` the
 * space the line has, and `pad` the sketch box's own padding.
 */
export function fitInline(above: number, below: number, roomAbove: number, roomBelow: number, pad = 2): number {
  let k = 1;
  if (above > 0) k = Math.min(k, roomAbove / (above + pad));
  if (below > 0) k = Math.min(k, roomBelow / (below + pad));
  return Math.max(0.2, k);
}
