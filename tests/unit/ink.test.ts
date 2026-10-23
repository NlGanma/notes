import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseFromStroke, pathLength, pointInPolygon, strokeBounds } from '../../src/lib/ink/geometry';
import { recognizeShape } from '../../src/lib/ink/shapes';
import type { Stroke } from '../../src/lib/ink/types';
import seedInk from '../../src/lib/vault/seedInk.json';
import { displayTitle } from '../../src/lib/displayTitle';
import {
  autoscrollSpeed,
  blobGroups,
  clusterBlob,
  estimateBaseline,
  fitInline,
  hitSelection,
  inlineSpacing,
  nearestRule,
  resolveDropTarget,
  ruleY,
  snapMove,
  strokeAt,
  wordBoundary,
  type PlacedStroke,
} from '../../src/editor/ink/snap';

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

// ---------------------------------------------------------------- picking up and placing handwriting

let sid = 0;
const pen = (pts: [number, number][], brush: Stroke['brush'] = 'ballpoint', size = 2): Stroke => ({
  id: `t${sid++}`,
  brush,
  color: '#000',
  size,
  pts: pts.flatMap(([x, y]) => [x, y, 0.5]),
});
const seg = (x0: number, y0: number, x1: number, y1: number, n = 10): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n] as [number, number]);

/**
 * Block-letter handwriting: every letter is a stem standing on the baseline,
 * some with a dot, crossbar or descender as a separate stroke, the way people
 * print. Returns the strokes and where the next word starts.
 */
function word(text: string, x: number, base: number, cap: number) {
  const xh = cap * 0.55;
  const w = cap * 0.45;
  const strokes: Stroke[] = [];
  for (const ch of text) {
    const wide = 'nTg'.includes(ch);
    if (ch === 'l') strokes.push(pen(seg(x, base - cap, x, base)));
    else if (ch === 'i') {
      strokes.push(pen(seg(x, base - xh, x, base)));
      strokes.push(pen(seg(x, base - xh - cap * 0.25, x + 1, base - xh - cap * 0.25, 1)));
    } else if (ch === 't') {
      strokes.push(pen(seg(x, base - cap * 0.8, x, base)));
      strokes.push(pen(seg(x - cap * 0.2, base - cap * 0.6, x + cap * 0.2, base - cap * 0.6)));
    } else if (ch === 'T') {
      strokes.push(pen(seg(x + w / 2, base - cap, x + w / 2, base)));
      strokes.push(pen(seg(x, base - cap, x + w, base - cap)));
    } else if (ch === 'n') {
      strokes.push(pen([...seg(x, base - xh, x, base), ...seg(x, base, x, base - xh), ...seg(x, base - xh, x + w, base - xh), ...seg(x + w, base - xh, x + w, base)]));
    } else if (ch === 'g') {
      const r = xh / 2;
      strokes.push(pen(Array.from({ length: 25 }, (_, i) => [x + r + r * Math.cos((i / 24) * Math.PI * 2), base - r + r * Math.sin((i / 24) * Math.PI * 2)] as [number, number])));
      strokes.push(pen([...seg(x + 2 * r, base - xh, x + 2 * r, base + cap * 0.35), ...seg(x + 2 * r, base + cap * 0.35, x, base + cap * 0.25)]));
    }
    // letters about a fifth of the cap height apart (tucked under a T's bar), words most of a cap height apart
    x += ch === 'T' ? w * 0.75 + cap * 0.2 : (wide ? w : 0) + cap * 0.22;
  }
  return { strokes, next: x + cap * 0.6 };
}

const place = (strokes: Stroke[], top = 0): PlacedStroke[] => strokes.map((stroke) => ({ stroke, top }));
const ids = (items: PlacedStroke[], idx: number[]) => idx.map((i) => items[i].stroke.id).sort();

test('ruled lines sit on the text baseline grid', () => {
  assert.equal(ruleY(0, 32), 23);
  assert.equal(ruleY(2, 32), 87);
  assert.equal(nearestRule(80, 32), 87);
  assert.equal(nearestRule(60, 32), 55);
  assert.equal(nearestRule(20, 28), 20);
});

for (const line of [28, 32]) {
  for (const cap of [line * 0.55, line * 0.8]) {
    test(`a press picks up one whole word (line ${line}, cap ${Math.round(cap)})`, () => {
      const base = ruleY(3, line);
      const a = word('tint', 0, base, cap);
      const b = word('lit', a.next, base, cap);
      const items = place([...a.strokes, ...b.strokes]);
      const wordA = a.strokes.map((s) => s.id).sort();
      const wordB = b.strokes.map((s) => s.id).sort();
      // from a stem, from an i-dot and from a crossbar: always the same word, dots and bars included
      for (const seed of [0, 2, 1]) assert.deepEqual(ids(items, clusterBlob(items, seed, line)), wordA);
      assert.deepEqual(ids(items, clusterBlob(items, items.length - 1, line)), wordB);
    });

    test(`words on neighbouring lines stay apart (line ${line}, cap ${Math.round(cap)})`, () => {
      // "g" hangs into the next line right where the next line's "T" has its crossbar
      const top = word('gin', 0, ruleY(2, line), cap);
      const below = word('Tint', 0, ruleY(3, line), cap);
      const items = place([...top.strokes, ...below.strokes]);
      const n = top.strokes.length;
      assert.deepEqual(ids(items, clusterBlob(items, 0, line)), top.strokes.map((s) => s.id).sort());
      // the crossbar of the T belongs to the line below, not to the g it touches
      assert.deepEqual(ids(items, clusterBlob(items, n + 1, line)), below.strokes.map((s) => s.id).sort());
      assert.deepEqual(ids(items, clusterBlob(items, n, line)), below.strokes.map((s) => s.id).sort());
    });
  }
}

test('blobs ignore block boundaries, highlights, and boxes drawn around them', () => {
  const line = 32;
  const base = ruleY(4, line);
  const w = word('lint', 0, base, 18);
  // half the word is stored in the block below (its local y is relative to that block's top)
  const items: PlacedStroke[] = w.strokes.map((stroke, i) =>
    i < 2 ? { stroke: { ...stroke, pts: stroke.pts.map((v, k) => (k % 3 === 1 ? v - 64 : v)) }, top: 64 } : { stroke, top: 0 },
  );
  const hl = pen(seg(-4, base - 6, 60, base - 6), 'highlighter', 16);
  const box = pen(
    [...seg(-12, base - 40, 80, base - 40), ...seg(80, base - 40, 80, base + 14), ...seg(80, base + 14, -12, base + 14), ...seg(-12, base + 14, -12, base - 40)],
    'mono',
    2,
  );
  items.push({ stroke: hl, top: 0 }, { stroke: box, top: 0 });
  const blob = clusterBlob(items, 3, line);
  assert.equal(blob.length, w.strokes.length);
  assert.ok(!blob.includes(items.length - 1) && !blob.includes(items.length - 2));
  // picked up by its outline, the box brings the word inside it (but not the highlight)
  const boxed = clusterBlob(items, items.length - 1, line);
  assert.equal(boxed.length, w.strokes.length + 1);
  assert.ok(!boxed.includes(items.length - 2));
});

for (const cap of [9, 10, 12, 14]) {
  test(`small writing still comes word by word (cap ${cap} on 32px lines)`, () => {
    const line = 32;
    const base = ruleY(4, line);
    const words = ['tint', 'lit', 'tilt'];
    let x = 0;
    const ws = words.map((t) => {
      const w = word(t, x, base, cap);
      x = w.next;
      return w;
    });
    const items = place(ws.flatMap((w) => w.strokes));
    let at = 0;
    for (const w of ws) {
      const want = w.strokes.map((s) => s.id).sort();
      // from its first stroke, and from its last (an i-dot or a t-bar)
      assert.deepEqual(ids(items, clusterBlob(items, at, line)), want);
      assert.deepEqual(ids(items, clusterBlob(items, at + w.strokes.length - 1, line)), want);
      at += w.strokes.length;
    }
  });
}

test('a cell drawn with its parts inside comes whole from its outline, a part alone from the part', () => {
  const line = 32;
  const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 44) =>
    pen(Array.from({ length: n + 3 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2 + 0.4) * rx, cy + Math.sin((i / n) * Math.PI * 2 + 0.4) * ry] as [number, number]));
  const membrane = ellipse(120, 120, 52, 40);
  const nucleus = ellipse(112, 122, 14, 11, 24);
  const dots = [pen(seg(144, 106, 145.5, 106.5, 1)), pen(seg(148, 130, 149.5, 130.5, 1)), pen(seg(90, 102, 91.5, 102.5, 1))];
  const items = place([membrane, nucleus, ...dots]);
  assert.equal(clusterBlob(items, 0, line).length, items.length);
  assert.ok(!clusterBlob(items, 1, line).includes(0));
});

test('every blob on the page, once', () => {
  const line = 32;
  const a = word('tint', 0, ruleY(3, line), 18);
  const b = word('lit', a.next, ruleY(3, line), 18);
  const c = word('nil', 0, ruleY(5, line), 18);
  const items = place([...a.strokes, ...b.strokes, ...c.strokes]);
  const groups = blobGroups(items, line);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.flat().sort((x, y) => x - y), items.map((_, i) => i));
});

test('pressing on ink prefers pen strokes and does not grab a highlight from a line away', () => {
  const ink = pen(seg(0, 100, 40, 100));
  const hl = pen(seg(0, 104, 40, 104), 'highlighter', 16);
  const items = place([ink, hl]);
  assert.equal(strokeAt(items, 20, 101, 3), 0);
  assert.equal(strokeAt(items, 20, 110, 3), 1);
  // 14px from the highlight's centre line is outside its painted band
  assert.equal(strokeAt(items, 20, 118, 3), -1);
  assert.equal(strokeAt(items, 20, 60, 3), -1);
});

test('the baseline is where the letters stand, not where descenders end', () => {
  const line = 32;
  const base = ruleY(2, line);
  for (const text of ['tint', 'gin', 'g', 'Tl']) {
    const w = word(text, 10, base, 18);
    const b = estimateBaseline(place(w.strokes), line)!;
    assert.ok(Math.abs(b - base) < 1, `${text}: ${b} vs ${base}`);
  }
  // stored in a block lower down the page
  const w = word('tin', 10, base - 64, 18);
  assert.ok(Math.abs(estimateBaseline(place(w.strokes, 64), line)! - base) < 1);
  // a dash sits where it is drawn; highlights have no baseline
  assert.equal(estimateBaseline(place([pen(seg(0, 70, 30, 70))]), line), 70);
  assert.equal(estimateBaseline(place([pen(seg(0, 70, 30, 70), 'highlighter', 16)]), line), null);
});

test('a dragged blob snaps its baseline to the nearest ruled line, and its edge to the margin', () => {
  const line = 32;
  const box = { minX: 30, minY: 60, maxX: 90, maxY: 84 };
  // written 5px above line 2, dragged down two lines and a bit
  const s = snapMove({ box, baseline: ruleY(2, line) - 5, dx: -27, dy: 2 * line + 2, line, tol: 7, xTargets: [{ x: 0, kind: 'margin' }] });
  assert.equal(s.rule, ruleY(4, line));
  assert.equal(ruleY(2, line) - 5 + s.dy, ruleY(4, line));
  assert.equal(s.dx, -30);
  assert.equal(s.x?.kind, 'margin');
  // halfway between lines: no snap
  const free = snapMove({ box, baseline: ruleY(2, line), dx: 50, dy: 16, line, tol: 7, xTargets: [{ x: 0, kind: 'margin' }] });
  assert.deepEqual([free.dx, free.dy, free.rule, free.x], [50, 16, null, null]);
  // highlights move by whole lines
  const hl = snapMove({ box, baseline: null, dx: 0, dy: 35, line, tol: 7 });
  assert.equal(hl.dy, 32);
});

test('with half a line of tolerance a drop always lands on the nearest ruled line; edges keep a short reach', () => {
  const line = 32;
  const box = { minX: 30, minY: 60, maxX: 90, maxY: 84 };
  for (let off = -16; off <= 15; off++) {
    const s = snapMove({ box, baseline: ruleY(2, line), dx: 25, dy: 2 * line + off, line, tol: line / 2, xTol: 7, xTargets: [{ x: 0, kind: 'margin' }] });
    assert.equal(ruleY(2, line) + s.dy, ruleY(4, line), `offset ${off}`);
    assert.equal(s.dx, 25);
  }
  const near = snapMove({ box, baseline: ruleY(2, line), dx: -26, dy: 0, line, tol: line / 2, xTol: 7, xTargets: [{ x: 0, kind: 'margin' }] });
  assert.equal(near.dx, -30);
  const far = snapMove({ box, baseline: ruleY(2, line), dx: -14, dy: 0, line, tol: line / 2, xTol: 7, xTargets: [{ x: 0, kind: 'margin' }] });
  assert.equal(far.dx, -14);
});

test('a dropped blob lands in exactly one block', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', top: 0, zoneStart: 0, zoneEnd: 64 },
    { id: 'b', type: 'heading', top: 80, zoneStart: 64, zoneEnd: 128 },
    { id: 'c', type: 'inkBlock', top: 128, zoneStart: 128, zoneEnd: 256 },
  ];
  assert.equal(resolveDropTarget(blocks, -40, 32)?.id, 'a');
  assert.equal(resolveDropTarget(blocks, 70, 32)?.id, 'b');
  assert.equal(resolveDropTarget(blocks, 300, 32)?.id, 'c');
  assert.equal(resolveDropTarget(blocks, 600, 32), null);
  assert.equal(resolveDropTarget(blocks.slice(0, 2), 200, 32), null);
  assert.equal(resolveDropTarget([], 10, 32), null);
});

test('a small selection moves from anywhere on it; handles resize where they are drawn', () => {
  const dot = { minX: 100, minY: 100, maxX: 108, maxY: 108 };
  assert.deepEqual(hitSelection(dot, { x: 104, y: 104 }, 1), { kind: 'inside' });
  assert.deepEqual(hitSelection(dot, { x: 108, y: 108 }, 1), { kind: 'inside' });
  // the frame is at least 26px, with handles 6px outside it
  assert.deepEqual(hitSelection(dot, { x: 104 + 13 + 6, y: 104 + 13 + 6 }, 1), { kind: 'handle', corner: 3 });
  assert.deepEqual(hitSelection(dot, { x: 104 - 19, y: 104 - 19 }, 1), { kind: 'handle', corner: 0 });
  assert.equal(hitSelection(dot, { x: 160, y: 104 }, 1), null);
  const big = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  assert.deepEqual(hitSelection(big, { x: 3, y: 3 }, 1), { kind: 'inside' });
  assert.deepEqual(hitSelection(big, { x: 206, y: -6 }, 1), { kind: 'handle', corner: 1 });
  assert.deepEqual(hitSelection(big, { x: 100, y: -8 }, 1), { kind: 'edge' });
  // at 50% zoom everything is twice as large in page units
  assert.deepEqual(hitSelection(big, { x: 212, y: -12 }, 2), { kind: 'handle', corner: 1 });
});

test('autoscroll speeds up towards the edges', () => {
  assert.equal(autoscrollSpeed(500, 100, 900), 0);
  assert.ok(autoscrollSpeed(110, 100, 900) < 0);
  assert.ok(autoscrollSpeed(60, 100, 900) < autoscrollSpeed(120, 100, 900));
  assert.ok(autoscrollSpeed(895, 100, 900) > 0);
});

test('a sketch dropped into text lands between words with tidy spaces, small enough for the line', () => {
  assert.equal(wordBoundary('we measured g', 5), 3);
  assert.equal(wordBoundary('we measured g', 9), 11);
  assert.equal(wordBoundary('we measured g', 3), 3);
  assert.equal(wordBoundary('ab', 0), 0);
  assert.deepEqual(inlineSpacing('we', ' measured'), { lead: true, trail: false });
  assert.deepEqual(inlineSpacing('we ', 'measured'), { lead: false, trail: true });
  assert.deepEqual(inlineSpacing('pendulum.', ''), { lead: true, trail: false });
  assert.deepEqual(inlineSpacing('', 'Today'), { lead: false, trail: true });
  assert.deepEqual(inlineSpacing('x', '.'), { lead: true, trail: false });
  assert.equal(fitInline(14, 4, 21, 9), 1);
  assert.ok(Math.abs(fitInline(40, 4, 21, 9) - 0.5) < 1e-9);
  assert.ok(fitInline(19.5, 6, 21, 9) < 1);
});

test('the demo notes are written with the felt marker, the only pen', () => {
  const strokes = Object.values(seedInk as unknown as Record<string, Stroke[]>).flat();
  const brushes = new Set(strokes.map((s) => s.brush));
  assert.ok(brushes.has('marker'));
  assert.deepEqual([...brushes].filter((b) => b !== 'marker' && b !== 'highlighter' && b !== 'mono'), []);
});

test('a note named by its handwriting shows the math written out, never LaTeX', () => {
  const named = (text: string) =>
    displayTitle({
      version: 1,
      meta: { id: 'n', title: '', folder: '', tags: [], created: 0, updated: 0, paper: 'ruled' },
      content: { type: 'doc', content: [{ type: 'inkBlock', attrs: { transcript: { text } } }] },
    });
  assert.equal(named('Ex. Find $\\lim_{x \\to 3} \\frac{x^2 - 9}{x - 3}$'), 'Ex. Find lim x→3 (x^2 - 9)/(x - 3)');
  assert.equal(named('$$v_0^2 = 2 g h$$'), 'v0^2 = 2 g h');
  assert.equal(named('\\theta = \\pi / 4'), 'θ = π / 4');
  assert.match(named('$$\n$$'), /^Note · /, 'nothing left: the date name');
});
