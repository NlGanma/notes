import type { ShapeKind } from './types';

/**
 * Shape recognition for "draw and hold to snap" (like Apple Notes / GoodNotes)
 * and geometry generation for the shape tool. Everything works on flat
 * [x, y, p, …] point lists.
 */

export interface RecognizedShape {
  kind: ShapeKind | 'polyline';
  pts: number[];
  closed: boolean;
}

type P = { x: number; y: number };

function toXY(pts: number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1] });
  return out;
}

function flat(points: P[], p = 0.5): number[] {
  const out: number[] = [];
  for (const q of points) out.push(Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100, p);
  return out;
}

function dist(a: P, b: P) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function perpDist(p: P, a: P, b: P) {
  const len = dist(a, b);
  if (len === 0) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(points: P[], eps: number): P[] {
  if (points.length < 3) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

/** Densely samples a polyline so erasing / lasso behave like freehand ink. */
function densify(points: P[], step = 4): P[] {
  const out: P[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  if (points.length) out.push(points[points.length - 1]);
  return out;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, rot = 0, n = 72): P[] {
  const out: P[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    out.push({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  }
  return out;
}

function angleAt(a: P, b: P, c: P) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

/** Merge vertices whose interior angle is almost straight. */
function dropFlatVertices(poly: P[], closed: boolean, minTurn = 28): P[] {
  let pts = poly.slice();
  let changed = true;
  while (changed && pts.length > (closed ? 3 : 2)) {
    changed = false;
    for (let i = closed ? 0 : 1; i < (closed ? pts.length : pts.length - 1); i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      if (180 - angleAt(a, b, c) < minTurn) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function recognizeShape(raw: number[]): RecognizedShape | null {
  const pts = toXY(raw);
  if (pts.length < 4) return null;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1], pts[i]);
  if (length < 14) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  const start = pts[0];
  const end = pts[pts.length - 1];
  const se = dist(start, end);

  // 1. Straight line
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, perpDist(p, start, end));
  if (se > 12 && maxDev / se < 0.09 && length / se < 1.18) {
    // Snap nearly horizontal / vertical lines.
    let a = start;
    let b = end;
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const m = ((ang % 180) + 180) % 180;
    if (m < 6 || m > 174) b = { x: b.x, y: a.y };
    else if (Math.abs(m - 90) < 6) b = { x: a.x, y: b.y };
    return { kind: 'line', pts: flat(densify([a, b])), closed: false };
  }

  const closed = se < Math.max(16, 0.22 * Math.max(w, h)) || se < 0.12 * length;

  if (closed && w > 10 && h > 10) {
    // 2. Polygon candidates (triangle / rectangle)
    const simplified = rdp(pts, Math.max(4, diag * 0.06));
    let poly = simplified.slice();
    if (poly.length > 2 && dist(poly[0], poly[poly.length - 1]) < Math.max(16, diag * 0.2)) poly.pop();
    poly = dropFlatVertices(poly, true);

    // Ellipse fit via principal axes (handles tilted ovals).
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.x - cx) ** 2;
      syy += (p.y - cy) ** 2;
      sxy += (p.x - cx) * (p.y - cy);
    }
    const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of pts) {
      const u = (p.x - cx) * c + (p.y - cy) * s;
      const v = -(p.x - cx) * s + (p.y - cy) * c;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const ecx = cx + ((minU + maxU) / 2) * c - ((minV + maxV) / 2) * s;
    const ecy = cy + ((minU + maxU) / 2) * s + ((minV + maxV) / 2) * c;
    const rx = (maxU - minU) / 2;
    const ry = (maxV - minV) / 2;
    let err = 0;
    for (const p of pts) {
      const u = (p.x - ecx) * c + (p.y - ecy) * s;
      const v = -(p.x - ecx) * s + (p.y - ecy) * c;
      err += Math.abs(Math.hypot(u / (rx || 1), v / (ry || 1)) - 1);
    }
    err /= pts.length;

    if (poly.length === 3) {
      return { kind: 'triangle', pts: flat(densify([...poly, poly[0]])), closed: true };
    }
    if (poly.length === 4) {
      const angles = poly.map((_, i) => angleAt(poly[(i + 3) % 4], poly[i], poly[(i + 1) % 4]));
      const rectangular = angles.every((a) => Math.abs(a - 90) < 26);
      if (rectangular) {
        // Axis-aligned when the edges are close to horizontal / vertical.
        const edgeAng = (Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x) * 180) / Math.PI;
        const m = ((edgeAng % 90) + 90) % 90;
        if (m < 14 || m > 76) {
          const xs = poly.map((p) => p.x).sort((a, b) => a - b);
          const ys = poly.map((p) => p.y).sort((a, b) => a - b);
          const x0 = (xs[0] + xs[1]) / 2;
          const x1 = (xs[2] + xs[3]) / 2;
          const y0 = (ys[0] + ys[1]) / 2;
          const y1 = (ys[2] + ys[3]) / 2;
          return { kind: 'rect', pts: flat(densify(rectPoints(x0, y0, x1, y1))), closed: true };
        }
        return { kind: 'rect', pts: flat(densify([...poly, poly[0]])), closed: true };
      }
      if (err > 0.1) return { kind: 'polyline', pts: flat(densify([...poly, poly[0]])), closed: true };
    }
    if (err < 0.13) {
      let erx = rx;
      let ery = ry;
      let erot = rot;
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) {
        erx = ery = (rx + ry) / 2;
        erot = 0;
      } else if (Math.abs(Math.sin(rot)) < 0.12 || Math.abs(Math.cos(rot)) < 0.12) {
        // Nearly axis-aligned oval: snap rotation.
        const horizontal = Math.abs(Math.cos(rot)) > 0.5;
        erot = 0;
        if (!horizontal) [erx, ery] = [ry, rx];
      }
      return { kind: 'ellipse', pts: flat(ellipsePoints(ecx, ecy, erx, ery, erot)), closed: true };
    }
    return null;
  }

  // 3. Open polyline with a few clean segments (e.g. an angle or a zig-zag).
  const simplified = dropFlatVertices(rdp(pts, Math.max(4, diag * 0.05)), false);
  if (simplified.length >= 3 && simplified.length <= 5) {
    let dev = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i < simplified.length - 1; i++) best = Math.min(best, perpDist(p, simplified[i], simplified[i + 1]));
      dev = Math.max(dev, best);
    }
    if (dev < Math.max(5, diag * 0.07)) return { kind: 'polyline', pts: flat(densify(simplified)), closed: false };
  }
  return null;
}

function rectPoints(x0: number, y0: number, x1: number, y1: number): P[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ];
}

/** Geometry for the shape tool, from drag start (x0, y0) to (x1, y1). */
export function shapeFromDrag(
  kind: ShapeKind,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  constrain: boolean,
  size: number,
): { pts: number[]; closed: boolean } {
  let dx = x1 - x0;
  let dy = y1 - y0;
  if (constrain) {
    if (kind === 'line' || kind === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(ang) * len;
      dy = Math.sin(ang) * len;
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
  }
  const ex = x0 + dx;
  const ey = y0 + dy;
  switch (kind) {
    case 'line':
      return {
        pts: flat(
          densify([
            { x: x0, y: y0 },
            { x: ex, y: ey },
          ]),
        ),
        closed: false,
      };
    case 'arrow': {
      const len = Math.hypot(dx, dy) || 1;
      const head = Math.min(len * 0.45, 10 + size * 2.4);
      const ang = Math.atan2(dy, dx);
      const a1 = ang + Math.PI - 0.45;
      const a2 = ang + Math.PI + 0.45;
      const tip = { x: ex, y: ey };
      const w1 = { x: ex + Math.cos(a1) * head, y: ey + Math.sin(a1) * head };
      const w2 = { x: ex + Math.cos(a2) * head, y: ey + Math.sin(a2) * head };
      return { pts: flat([...densify([{ x: x0, y: y0 }, tip]), w1, tip, w2]), closed: false };
    }
    case 'rect':
      return { pts: flat(densify(rectPoints(x0, y0, ex, ey))), closed: true };
    case 'ellipse':
      return { pts: flat(ellipsePoints((x0 + ex) / 2, (y0 + ey) / 2, Math.abs(dx) / 2, Math.abs(dy) / 2)), closed: true };
    case 'triangle':
      return {
        pts: flat(
          densify([
            { x: (x0 + ex) / 2, y: y0 },
            { x: ex, y: ey },
            { x: x0, y: ey },
            { x: (x0 + ex) / 2, y: y0 },
          ]),
        ),
        closed: true,
      };
  }
}

/** Straightens a highlighter stroke that was meant to be a straight swipe. */
export function straightenIfLinear(raw: number[]): number[] | null {
  const pts = toXY(raw);
  if (pts.length < 3) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const se = dist(a, b);
  if (se < 24) return null;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, perpDist(p, a, b));
  if (maxDev > Math.max(7, se * 0.08)) return null;
  const ang = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
  const nearFlat = ang < 8 || ang > 172;
  const y = nearFlat ? (a.y + b.y) / 2 : 0;
  const s = nearFlat ? { x: a.x, y } : a;
  const e = nearFlat ? { x: b.x, y } : b;
  return flat(densify([s, e], 3));
}
