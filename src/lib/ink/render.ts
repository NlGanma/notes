import { getStroke } from 'perfect-freehand';
import { BRUSHES } from './brushes';
import type { Stroke } from './types';

const pathCache = new WeakMap<Stroke, string>();

function avg(a: number, b: number) {
  return (a + b) / 2;
}

function f(n: number) {
  return Math.round(n * 10) / 10;
}

/** Converts a perfect-freehand outline polygon into a smooth SVG path. */
function outlineToPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) {
    if (len === 0) return '';
    const [x, y] = points[0];
    return `M${f(x)},${f(y)}Z`;
  }
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let d = `M${f(a[0])},${f(a[1])} Q${f(b[0])},${f(b[1])} ${f(avg(b[0], c[0]))},${f(avg(b[1], c[1]))} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${f(avg(a[0], b[0]))},${f(avg(a[1], b[1]))} `;
  }
  return d + 'Z';
}

export function toPointTriples(pts: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

/** Path for a mono (geometric) stroke — rendered with an SVG stroke, not a fill. */
export function monoPath(pts: number[], closed?: boolean): string {
  if (pts.length < 3) return '';
  let d = `M${f(pts[0])},${f(pts[1])}`;
  for (let i = 3; i + 1 < pts.length; i += 3) d += `L${f(pts[i])},${f(pts[i + 1])}`;
  if (pts.length === 3) d += `l0.01,0`;
  return closed ? d + 'Z' : d;
}

export function freehandOutline(stroke: Stroke, last = true): number[][] {
  const def = BRUSHES[stroke.brush];
  const size = stroke.size * def.sizeScale;
  return getStroke(toPointTriples(stroke.pts), {
    size,
    thinning: def.thinning,
    smoothing: def.smoothing,
    streamline: def.streamline,
    simulatePressure: !stroke.pressure && def.thinning > 0.05,
    last,
    start: { taper: def.taperStart, cap: true },
    end: { taper: def.taperEnd, cap: true },
  });
}

/** SVG path data for a stroke (cached per stroke object — strokes are immutable). */
export function strokePath(stroke: Stroke): string {
  let d = pathCache.get(stroke);
  if (d === undefined) {
    d = stroke.brush === 'mono' ? monoPath(stroke.pts, stroke.closed) : outlineToPath(freehandOutline(stroke));
    pathCache.set(stroke, d);
  }
  return d;
}

/** Path for an in-progress stroke (not cached, `last: false`). */
export function livePath(stroke: Stroke): string {
  if (stroke.brush === 'mono') return monoPath(stroke.pts, stroke.closed);
  return outlineToPath(freehandOutline(stroke, false));
}

export function strokeOpacity(stroke: Stroke): number {
  return stroke.opacity ?? BRUSHES[stroke.brush].opacity;
}

/** Attributes for rendering a stroke as an SVG <path>. */
export function strokeSvgAttrs(stroke: Stroke) {
  const opacity = strokeOpacity(stroke);
  if (stroke.brush === 'mono') {
    return {
      fill: 'none',
      stroke: stroke.color,
      strokeWidth: stroke.size,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      opacity,
    };
  }
  return { fill: stroke.color, opacity };
}

function escAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Static SVG markup for a list of strokes (exports, thumbnails, print). */
export function strokesToSvgMarkup(strokes: Stroke[], dx = 0, dy = 0): string {
  let out = '';
  const highlight = strokes.filter((s) => s.brush === 'highlighter');
  const rest = strokes.filter((s) => s.brush !== 'highlighter');
  const one = (s: Stroke) => {
    const d = strokePath(s);
    if (!d) return '';
    const op = strokeOpacity(s);
    const col = escAttr(s.color);
    if (s.brush === 'mono') {
      return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"${op < 1 ? ` opacity="${op}"` : ''}/>`;
    }
    return `<path d="${d}" fill="${col}"${op < 1 ? ` opacity="${op}"` : ''}/>`;
  };
  if (highlight.length) out += `<g style="mix-blend-mode:multiply">${highlight.map(one).join('')}</g>`;
  out += rest.map(one).join('');
  if (dx || dy) out = `<g transform="translate(${f(dx)} ${f(dy)})">${out}</g>`;
  return out;
}

/** Draws strokes on a 2D canvas context (used for rasterising for vision models). */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], textColor = '#1c1c1e') {
  const sorted = [...strokes].sort((a, b) => Number(b.brush === 'highlighter') - Number(a.brush === 'highlighter'));
  for (const s of sorted) {
    const d = strokePath(s);
    if (!d) continue;
    const p = new Path2D(d);
    const color = s.color === 'currentColor' ? textColor : s.color;
    ctx.save();
    ctx.globalAlpha = strokeOpacity(s);
    if (s.brush === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    if (s.brush === 'mono') {
      ctx.strokeStyle = color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(p);
    } else {
      ctx.fillStyle = color;
      ctx.fill(p);
    }
    ctx.restore();
  }
}
