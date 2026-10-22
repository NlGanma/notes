import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseFromStroke, pathLength, pointInPolygon, strokeBounds } from '../../src/lib/ink/geometry';
import { recognizeShape } from '../../src/lib/ink/shapes';
import type { Stroke } from '../../src/lib/ink/types';

const line = (x0: number, x1: number, y = 0): Stroke =>
  ({
    id: 's',
    brush: 'pen',
    color: '#000',
    size: 2,
    pts: Array.from({ length: 21 }, (_, i) => [x0 + ((x1 - x0) * i) / 20, y, 0.5]).flat(),
  }) as unknown as Stroke;

test('erasing the middle of a stroke splits it in two', () => {
  const parts = eraseFromStroke(line(0, 100), 50, 0, 6);
  assert.ok(parts);
  assert.equal(parts!.length, 2);
  assert.ok(strokeBounds(parts![0]).maxX < 50);
  assert.ok(strokeBounds(parts![1]).minX > 50);
  assert.equal(eraseFromStroke(line(0, 100), 50, 40, 6), null);
});

test('lasso hit testing', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(Math.round(pathLength([0, 0, 0.5, 3, 4, 0.5])), 5);
});

test('a roughly drawn circle snaps to an ellipse and a box to a rectangle', () => {
  const circle: number[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    circle.push(50 + 30 * Math.cos(a) + Math.sin(i) * 0.8, 50 + 30 * Math.sin(a) + Math.cos(i * 1.7) * 0.8, 0.5);
  }
  assert.equal(recognizeShape(circle)?.kind, 'ellipse');
  const box: number[] = [];
  const corners = [
    [0, 0],
    [80, 0],
    [80, 50],
    [0, 50],
    [0, 0],
  ];
  for (let c = 0; c < 4; c++)
    for (let i = 0; i < 12; i++) {
      const t = i / 12;
      box.push(corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t, corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t, 0.5);
    }
  box.push(0, 0, 0.5);
  assert.equal(recognizeShape(box)?.kind, 'rect');
});
