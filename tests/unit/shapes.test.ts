import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape } from '../../src/lib/ink/shapes';

type Pt = [number, number];

/** A hand-drawn polyline: points every few px along each leg, with a little wobble, as a pen samples them. */
function drawn(corners: Pt[], step = 3, wobble = 0.6): number[] {
  const out: number[] = [];
  let k = 0;
  for (let c = 0; c < corners.length - 1; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[c + 1];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = 0; i < n; i++, k++) {
      const t = i / n;
      out.push(x0 + (x1 - x0) * t + Math.sin(k * 1.3) * wobble, y0 + (y1 - y0) * t + Math.cos(k * 0.7) * wobble, 0.5);
    }
  }
  const [x, y] = corners[corners.length - 1];
  out.push(x, y, 0.5);
  return out;
}

const xy = (pts: number[]) => Array.from({ length: pts.length / 3 }, (_, i) => [pts[i * 3], pts[i * 3 + 1]] as Pt);

test('a line whose end bends back into a head becomes an arrow (tip, barb, tip, barb)', () => {
  const r = recognizeShape(drawn([[0, 0], [120, 2], [104, -8], [120, 2], [104, 12]]));
  assert.equal(r?.kind, 'arrow');
  assert.equal(r?.closed, false);
  const pts = xy(r!.pts);
  // The shaft starts where the pen did and is straightened onto the level.
  const [x0, y0] = pts[0];
  assert.ok(Math.hypot(x0, y0) < 1, 'the shaft starts where the pen did');
  assert.ok(pts.some(([x, y]) => Math.abs(x - 120) < 1.5 && y === y0), 'the tip sits at the end of a level shaft');
  // Both barbs point back, one on each side of the shaft.
  const barbs = pts.slice(-3);
  assert.ok(barbs[0][0] < 120 && barbs[2][0] < 120);
  assert.ok(Math.sign(barbs[0][1]) !== Math.sign(barbs[2][1]));
});

test('a single V at the end, or a closed head, makes an arrow too, in any direction', () => {
  // up and to the right, finishing with one barb only
  assert.equal(recognizeShape(drawn([[0, 100], [70, 30], [52, 36]]))?.kind, 'arrow');
  // pointing left, a closed triangular head
  assert.equal(recognizeShape(drawn([[150, 40], [20, 40], [36, 30], [36, 50], [20, 40]]))?.kind, 'arrow');
  // pointing down
  assert.equal(recognizeShape(drawn([[40, 0], [40, 110], [30, 94], [40, 110], [50, 94]]))?.kind, 'arrow');
});

test('a check mark, an L, a zig-zag and a plain line are not arrows', () => {
  // ✓: the short leg comes first
  assert.notEqual(recognizeShape(drawn([[0, 40], [20, 60], [70, 0]]))?.kind, 'arrow');
  // L: the bend is square, not back along the shaft
  assert.notEqual(recognizeShape(drawn([[0, 0], [0, 100], [30, 100]]))?.kind, 'arrow');
  // zig-zag: no leg dominates
  assert.notEqual(recognizeShape(drawn([[0, 0], [30, 40], [60, 0], [90, 40], [120, 0]]))?.kind, 'arrow');
  // a straight line is still a line
  assert.equal(recognizeShape(drawn([[0, 0], [140, 4]]))?.kind, 'line');
  // a box is still a box
  assert.equal(recognizeShape(drawn([[0, 0], [90, 0], [90, 60], [0, 60], [0, 0]]))?.kind, 'rect');
});

test('a head far bigger than the shaft, or a scribble at the tip, is left alone', () => {
  assert.notEqual(recognizeShape(drawn([[0, 0], [40, 0], [-10, 30]]))?.kind, 'arrow');
  const scribble = drawn([[0, 0], [100, 0], [92, -6], [98, 7], [90, -5], [99, 6], [91, -7], [100, 5]]);
  assert.notEqual(recognizeShape(scribble)?.kind, 'arrow');
});
