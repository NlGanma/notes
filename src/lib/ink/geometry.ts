import type { Bounds, Stroke } from './types';
import { uid } from '../util';

const boundsCache = new WeakMap<Stroke, Bounds>();

export function strokeBounds(stroke: Stroke): Bounds {
  let b = boundsCache.get(stroke);
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
    const pad = stroke.size * (stroke.brush === 'brush' || stroke.brush === 'marker' ? 1 : 0.7);
    b = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    boundsCache.set(stroke, b);
  }
  return b;
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  const out = { ...list[0] };
  for (const b of list) {
    out.minX = Math.min(out.minX, b.minX);
    out.minY = Math.min(out.minY, b.minY);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.maxY = Math.max(out.maxY, b.maxY);
  }
  return out;
}

export function offsetBounds(b: Bounds, dx: number, dy: number): Bounds {
  return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** True when the point (x, y) — in the stroke's coordinate space — touches it. */
export function hitStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const b = strokeBounds(stroke);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  const r = radius + stroke.size * 0.6;
  const r2 = r * r;
  const p = stroke.pts;
  if (p.length < 6) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
  for (let i = 0; i + 4 < p.length; i += 3) {
    if (distToSegmentSq(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= r2) return true;
  }
  if (stroke.closed && p.length >= 6) {
    const n = p.length - 3;
    if (distToSegmentSq(x, y, p[n], p[n + 1], p[0], p[1]) <= r2) return true;
  }
  return false;
}

/** Even-odd point in polygon test. `poly` is a flat [x, y, x, y, …] list. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fraction of a stroke's points (offset by dx, dy) that fall inside a polygon. */
export function fractionInside(stroke: Stroke, poly: number[], dx = 0, dy = 0): number {
  const p = stroke.pts;
  let inside = 0;
  let total = 0;
  for (let i = 0; i + 1 < p.length; i += 3) {
    total++;
    if (pointInPolygon(p[i] + dx, p[i + 1] + dy, poly)) inside++;
  }
  return total ? inside / total : 0;
}

export function polygonBounds(poly: number[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Inserts intermediate points so no segment is longer than `maxSeg`. */
export function resample(pts: number[], maxSeg: number): number[] {
  if (pts.length < 6) return pts.slice();
  const out: number[] = [pts[0], pts[1], pts[2]];
  for (let i = 3; i + 2 < pts.length; i += 3) {
    const ax = pts[i - 3];
    const ay = pts[i - 2];
    const ap = pts[i - 1];
    const bx = pts[i];
    const by = pts[i + 1];
    const bp = pts[i + 2];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(len / maxSeg);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
    }
    out.push(bx, by, bp);
  }
  return out;
}

/**
 * Precise eraser: removes the parts of `stroke` within `radius` of (x, y).
 * Returns null when the stroke is untouched, otherwise the remaining pieces
 * (possibly none).
 */
export function eraseFromStroke(stroke: Stroke, x: number, y: number, radius: number): Stroke[] | null {
  if (!hitStroke(stroke, x, y, radius)) return null;
  const r = radius + stroke.size * 0.4;
  const r2 = r * r;
  let pts = stroke.pts;
  if (stroke.closed && pts.length >= 6) pts = [...pts, pts[0], pts[1], pts[2]];
  pts = resample(pts, Math.max(1.5, radius / 3));
  const pieces: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const inside = (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 <= r2;
    if (inside) {
      if (cur.length >= 6) pieces.push(cur);
      cur = [];
    } else {
      cur.push(pts[i], pts[i + 1], pts[i + 2]);
    }
  }
  if (cur.length >= 6) pieces.push(cur);
  return pieces.map((p) => ({ ...stroke, id: uid('s'), pts: p, closed: false }));
}

export function translateStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  const p = stroke.pts.slice();
  for (let i = 0; i + 1 < p.length; i += 3) {
    p[i] = Math.round((p[i] + dx) * 100) / 100;
    p[i + 1] = Math.round((p[i + 1] + dy) * 100) / 100;
  }
  return { ...stroke, pts: p };
}

export function scaleStroke(stroke: Stroke, ox: number, oy: number, sx: number, sy = sx): Stroke {
  const p = stroke.pts.slice();
  for (let i = 0; i + 1 < p.length; i += 3) {
    p[i] = Math.round((ox + (p[i] - ox) * sx) * 100) / 100;
    p[i + 1] = Math.round((oy + (p[i + 1] - oy) * sy) * 100) / 100;
  }
  const s = Math.sqrt(Math.abs(sx * sy));
  return { ...stroke, pts: p, size: Math.max(0.6, Math.round(stroke.size * s * 100) / 100) };
}

export function strokeCenter(stroke: Stroke): { x: number; y: number } {
  const b = strokeBounds(stroke);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Rounds coordinates to keep files small without visible loss. */
export function compactPoints(pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    out[i] = Math.round(pts[i] * 100) / 100;
    out[i + 1] = Math.round(pts[i + 1] * 100) / 100;
    out[i + 2] = Math.round((pts[i + 2] ?? 0.5) * 100) / 100;
  }
  return out;
}

/** Drops points closer than `minDist` to the previous kept point. */
export function simplifyPoints(pts: number[], minDist = 0.6): number[] {
  if (pts.length <= 6) return pts;
  const out = [pts[0], pts[1], pts[2]];
  const md2 = minDist * minDist;
  for (let i = 3; i + 2 < pts.length; i += 3) {
    const lx = out[out.length - 3];
    const ly = out[out.length - 2];
    if ((pts[i] - lx) ** 2 + (pts[i + 1] - ly) ** 2 >= md2 || i + 3 >= pts.length) {
      out.push(pts[i], pts[i + 1], pts[i + 2]);
    }
  }
  return out;
}

export function pathLength(pts: number[]): number {
  let len = 0;
  for (let i = 3; i + 1 < pts.length; i += 3) len += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
  return len;
}
