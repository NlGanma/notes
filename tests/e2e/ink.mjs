// End-to-end test of the type ↔ handwriting flow, driven with real pointer
// events. Run against the dev server:  node tests/e2e/ink.mjs
import { launch, shot, BASE, showSidebar } from './lib.mjs';
import { handPaths, writeText } from './hand.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const { browser, page, errors } = await launch({ width: 1440, height: 1000 });
const V = '.note-view:not(.is-hidden)';
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exitCode = 1;
};
const check = (cond, msg) => (cond ? console.log('ok  ', msg) : fail(msg));

const wrapBox = async () => page.locator('.note-view:not(.is-hidden) .editor-wrap').boundingBox();
const docJSON = () =>
  page.evaluate(() => {
    const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror');
    return ed?.editor?.getJSON();
  });

await page.goto(BASE);
await page.waitForTimeout(1200);

// 1. New note, title, a typed paragraph.
await page.keyboard.press(`${MOD}+n`);
await page.waitForTimeout(400);
await page.keyboard.type('Physics Lab 3 — Pendulum');
await page.keyboard.press('Enter');
await page.keyboard.type('Today we measured g with a simple pendulum.');
await page.waitForTimeout(300);

// 2. Pick the pen and write below the text.
await page.keyboard.press('Alt+p');
await page.waitForTimeout(200);
let wrap = await wrapBox();
const lineY = wrap.y + 32 * 2 + 23; // third ruled line
await writeText(page, 'T = 2 pi sqrt(L/g)', wrap.x + 6, lineY, 18);
await page.waitForTimeout(300);
let doc = await docJSON();
const inkBlocks = doc.content.filter((b) => b.type === 'inkBlock');
check(inkBlocks.length === 1, `handwriting below the text became one handwriting area (got ${inkBlocks.length})`);
check((inkBlocks[0]?.attrs.ink?.length ?? 0) > 10, `strokes stored in the handwriting area (${inkBlocks[0]?.attrs.ink?.length})`);
await shot(page, 'ink-01-written');

// 3. Just start typing: text lands on the line under the handwriting.
await page.keyboard.type('So g = 4 pi^2 L / T^2.');
await page.waitForTimeout(300);
doc = await docJSON();
const types = doc.content.map((b) => b.type);
const idxInk = types.indexOf('inkBlock');
check(types[idxInk + 1] === 'paragraph' && JSON.stringify(doc.content[idxInk + 1]).includes('So g = 4'), 'typed text landed right after the handwriting');
const tool = await page.evaluate(() => JSON.parse(localStorage.getItem('nib.tools') || '{}'));
void tool;
await shot(page, 'ink-02-typed-after');

// 4. Esc returns to the pen; write again below the typed line.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(await page.locator(`${V} .tb-tool[data-tool="pen"].is-active`).count(), 'Esc switched back to the pen');
wrap = await wrapBox();
const lastBlock = await page.locator('.note-view:not(.is-hidden) .ProseMirror > *').last().boundingBox();
const belowY = lastBlock.y + lastBlock.height + 40;

// 5. Draw a rough circle and hold → snaps to an ellipse.
const cx = wrap.x + 120;
const cy = belowY + 40;
await page.mouse.move(cx + 40, cy);
await page.mouse.down();
for (let i = 1; i <= 40; i++) {
  const t = (i / 40) * Math.PI * 2;
  const r = 40 + Math.sin(i * 1.7) * 2.5;
  await page.mouse.move(cx + Math.cos(t) * r, cy + Math.sin(t) * r * 0.8, { steps: 1 });
}
await page.waitForTimeout(700); // hold
await page.mouse.up();
await page.waitForTimeout(300);
doc = await docJSON();
const lastInk = doc.content.filter((b) => b.type === 'inkBlock').pop();
const circle = lastInk?.attrs.ink?.[lastInk.attrs.ink.length - 1];
check(circle?.brush === 'mono' && circle?.closed, `hold-to-snap turned the circle into a clean shape (brush=${circle?.brush})`);
// The marker draws 1.6× its size; the clean line keeps that width, so it reads as the same pen.
check(Math.abs(circle?.size - 1.6 * 1.6 * 0.95) < 0.01, `the snapped shape is as wide as the marker line it came from (${circle?.size?.toFixed(2)})`);
await shot(page, 'ink-03-snapped');

// 6. Select: drag a box around the circle (⌘⇧4-style, corner to corner), then move it right.
await page.keyboard.press('Alt+l');
await page.mouse.move(cx - 60, cy - 55);
await page.mouse.down();
await page.mouse.move(cx + 60, cy + 55, { steps: 10 });
await page.waitForTimeout(80);
check(await page.locator(`${V} .ink-overlay .marquee`).count(), 'dragging on the bare page draws a Select box');
await page.mouse.up();
await page.waitForTimeout(250);
check(await page.locator(`${V} .ink-sel-menu`).count(), 'a box around ink selects it and shows the action menu');
check(!(await page.locator(`${V} .ink-overlay .marquee`).count()), 'and the box itself goes away');
await shot(page, 'ink-04-lasso');
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 160, cy + 6, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
doc = await docJSON();
const moved = doc.content
  .filter((b) => b.type === 'inkBlock')
  .flatMap((b) => b.attrs.ink ?? [])
  .find((s) => s.id === circle.id);
check(moved && moved.pts[0] > circle.pts[0] + 120, 'dragging the selection moved the strokes');
await shot(page, 'ink-05-moved');
await page.keyboard.press('Escape');

// 7. Precise eraser through the handwriting.
await page.keyboard.press('Alt+e');
await page.locator(`${V} .tb-seg button:has-text("Part")`).click();
const inkOfFirst = async () => JSON.stringify((await docJSON()).content.find((b) => b.type === 'inkBlock').attrs.ink);
const before = await inkOfFirst();
const heightBefore = (await docJSON()).content.find((b) => b.type === 'inkBlock').attrs.height;
await page.mouse.move(wrap.x + 20, lineY - 30);
await page.mouse.down();
await page.mouse.move(wrap.x + 60, lineY + 6, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(250);
const after = await inkOfFirst();
check(after !== before, 'precise eraser cut through the handwriting');
check((await docJSON()).content.find((b) => b.type === 'inkBlock').attrs.height === heightBefore, 'erasing did not change the area height');
await shot(page, 'ink-06-erased');

// 8. Undo restores the erased ink (ink and text share one history).
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);
const undone = await inkOfFirst();
check(undone === before, `${MOD}+Z restored the erased strokes`);

// 9. Inline capture: write a symbol right after a typed line, then keep typing.
await page.keyboard.press('Alt+t');
const para = page.locator('.note-view:not(.is-hidden) .ProseMirror > p').first();
const pb = await para.boundingBox();
// The click puts the caret at the end of the line. (No End key: on macOS it scrolls the page instead.)
await page.mouse.click(pb.x + pb.width - 2, pb.y + 16);
await page.keyboard.type(' Result');
await page.keyboard.press('Alt+p');
const lineEnd = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const $p = ed.state.doc.resolve(2);
  const r = ed.view.coordsAtPos($p.end());
  return { x: r.right, y: (r.top + r.bottom) / 2 };
});
// a hand-drawn arrow right after "Result"
const ax = lineEnd.x + 10;
const ay = lineEnd.y;
await page.mouse.move(ax, ay);
await page.mouse.down();
await page.mouse.move(ax + 30, ay, { steps: 6 });
await page.mouse.up();
await page.mouse.move(ax + 20, ay - 7);
await page.mouse.down();
await page.mouse.move(ax + 30, ay, { steps: 3 });
await page.mouse.move(ax + 20, ay + 7, { steps: 3 });
await page.mouse.up();
await page.keyboard.type(' 9.79 m/s^2');
await page.waitForTimeout(300);
doc = await docJSON();
const firstPara = doc.content.find((b) => b.type === 'paragraph');
const hasInline = JSON.stringify(firstPara).includes('inkInline');
check(hasInline, 'symbol written at the end of a line was folded into the sentence as an inline sketch');
check(JSON.stringify(firstPara).includes('9.79'), 'typing continued after the inline sketch');
await shot(page, 'ink-07-inline-capture');

// 10. ⌘D inline sketch pad.
const inlineCount = (d) => (JSON.stringify(d).match(/"inkInline"/g) ?? []).length;
const inlineBefore = inlineCount(await docJSON());
await page.keyboard.press(`${MOD}+d`);
await page.waitForTimeout(300);
check(await page.locator('.inkpad').count(), `${MOD}+D opened the inline sketch pad`);
const padBox = await page.locator('.inkpad-canvas').boundingBox();
const k = padBox.width / 440;
await page.mouse.move(padBox.x + 40 * k, padBox.y + 100 * k);
await page.mouse.down();
for (let i = 0; i <= 20; i++) await page.mouse.move(padBox.x + (40 + i * 3) * k, padBox.y + (100 - Math.sin(i / 3) * 30 - i * 2) * k);
await page.mouse.up();
await shot(page, 'ink-08-pad');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
doc = await docJSON();
check(inlineCount(doc) === inlineBefore + 1, 'inline sketch inserted at the caret');
await shot(page, 'ink-09-final');

// 11. Picking handwriting up and putting it down, in a fresh note.
await page.keyboard.press(`${MOD}+n`);
await page.waitForTimeout(400);
await page.keyboard.type('Moving handwriting');
await page.keyboard.press('Enter');
await page.keyboard.type('Energy is conserved in a closed system.');
await page.waitForTimeout(300);
await page.keyboard.press('Alt+p');
await page.waitForTimeout(200);
wrap = await wrapBox();
const R = (k) => (k + 0.75) * 32 - 1; // ruled line k, in page-layer coordinates (32px lines)
/** Every stroke with its points in layer coordinates (x from the text column, y from its top). */
const inkNow = () =>
  page.evaluate(() => {
    const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
    const out = [];
    ed.state.doc.forEach((node, offset) => {
      const top = ed.view.dom.offsetTop + ed.view.nodeDOM(offset).offsetTop;
      for (const s of node.attrs.ink ?? []) {
        const pts = [];
        for (let i = 0; i + 1 < s.pts.length; i += 3) pts.push([s.pts[i], s.pts[i + 1] + top]);
        out.push({ id: s.id, block: node.attrs.id, type: node.type.name, size: s.size, pts });
      }
    });
    return out;
  });
const byId = (list) => new Map(list.map((s) => [s.id, s]));
const selCount = async () => Number((await page.locator(`${V} .ink-sel-menu`).getAttribute('data-strokes', { timeout: 1000 }).catch(() => null)) ?? 0);
const mid = (path) => path[Math.floor(path.length / 2)];
const drag = async (from, dx, dy, { hold = 0, shotName } = {}) => {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + dx / 2, from[1] + dy / 2, { steps: 5 });
  await page.mouse.move(from[0] + dx, from[1] + dy, { steps: 5 });
  await page.waitForTimeout(120 + hold);
  if (shotName) await shot(page, shotName);
  await page.mouse.up();
  await page.waitForTimeout(250);
};

// 11a. A tap on a handwritten word selects the whole word, not one stroke and not the next word.
await writeText(page, 'kinetic energy', wrap.x + 10, wrap.y + R(3), 18);
const kinetic = handPaths('kinetic', wrap.x + 10, wrap.y + R(3), 18).paths;
await page.keyboard.press('Alt+l');
await page.waitForTimeout(150);
await page.mouse.click(...mid(kinetic[2]));
await page.waitForTimeout(250);
check((await selCount()) === kinetic.length, `a tap on a handwritten word selects the whole word (${await selCount()} of ${kinetic.length} strokes)`);
await shot(page, 'ink-10-word-selected');

// 11b. Dropping snaps the baseline onto a ruled line, even for a word written a little above its line.
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');
const massBase = R(6) - 5;
await writeText(page, 'mass', wrap.x + 40, wrap.y + massBase, 18);
const mass = handPaths('mass', wrap.x + 40, wrap.y + massBase, 18).paths;
let was = await inkNow();
const massIds = was.slice(-mass.length).map((s) => s.id);
await page.keyboard.press('Alt+l');
await drag(mid(mass[0]), 40, 66, { shotName: 'ink-11-drag-guides' });
let now = byId(await inkNow());
const m0 = was.find((s) => s.id === massIds[0]);
const m1 = now.get(massIds[0]);
// baseline R(6) - 5, dragged 66px down: 3px short of R(8), so it snaps exactly onto R(8)
check(Math.abs(m1.pts[0][1] - m0.pts[0][1] - (R(8) - massBase)) < 1, `a dropped word snaps its baseline onto the ruled line (moved ${(m1.pts[0][1] - m0.pts[0][1]).toFixed(2)}, expected ${R(8) - massBase})`);
check(Math.abs(m1.pts[0][0] - m0.pts[0][0] - 40) < 0.6, 'and keeps the horizontal position it was dropped at');
check(massIds.every((id) => now.get(id)?.block === m1.block), 'the word stays together in one block');

// 11c. ⌥ drags freely, without snapping.
await page.keyboard.down('Alt');
await drag([wrap.x + m1.pts[0][0], wrap.y + m1.pts[0][1]], 30, 13);
await page.keyboard.up('Alt');
const m2 = byId(await inkNow()).get(massIds[0]);
check(Math.abs(m2.pts[0][0] - m1.pts[0][0] - 30) < 0.6 && Math.abs(m2.pts[0][1] - m1.pts[0][1] - 13) < 0.6, `holding ⌥ drops the ink exactly where it was let go (moved ${(m2.pts[0][0] - m1.pts[0][0]).toFixed(1)}, ${(m2.pts[0][1] - m1.pts[0][1]).toFixed(1)})`);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);
const m3 = byId(await inkNow()).get(massIds[0]);
check(Math.abs(m3.pts[0][0] - m1.pts[0][0]) < 0.01 && Math.abs(m3.pts[0][1] - m1.pts[0][1]) < 0.01, `one ${MOD}+Z puts a dropped word back`);

// 11d. A small blob moves from its middle instead of being resized (it used to grab a corner handle).
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');
await writeText(page, 'x', wrap.x + 320, wrap.y + R(10), 9);
const small = handPaths('x', wrap.x + 320, wrap.y + R(10), 9).paths;
const smallBox = { minX: Math.min(...small.flat().map((q) => q[0])), maxX: Math.max(...small.flat().map((q) => q[0])), minY: Math.min(...small.flat().map((q) => q[1])), maxY: Math.max(...small.flat().map((q) => q[1])) };
const centre = [(smallBox.minX + smallBox.maxX) / 2, (smallBox.minY + smallBox.maxY) / 2];
check(Math.hypot(smallBox.maxX - smallBox.minX, smallBox.maxY - smallBox.minY) < 24, `the test symbol is small (${Math.hypot(smallBox.maxX - smallBox.minX, smallBox.maxY - smallBox.minY).toFixed(1)}px across)`);
was = await inkNow();
const xIds = was.slice(-small.length).map((s) => s.id);
await page.keyboard.press('Alt+l');
await page.mouse.click(...centre);
await page.waitForTimeout(200);
await drag(centre, 100, 32);
now = byId(await inkNow());
const x0 = was.find((s) => s.id === xIds[0]);
const x1 = now.get(xIds[0]);
const span = (s) => Math.max(...s.pts.map((q) => q[0])) - Math.min(...s.pts.map((q) => q[0]));
check(Math.abs(x1.pts[0][0] - x0.pts[0][0] - 100) < 0.6 && Math.abs(x1.pts[0][1] - x0.pts[0][1] - 32) < 1, `dragging a small symbol from its middle moves it (by ${(x1.pts[0][0] - x0.pts[0][0]).toFixed(1)}, ${(x1.pts[0][1] - x0.pts[0][1]).toFixed(1)})`);
check(Math.abs(span(x1) - span(x0)) < 0.1 && x1.size === x0.size, 'and does not resize it');

// 11e. A blob stored half in one block and half in the next is picked up whole and lands in one block.
const wave = handPaths('wave', 200, R(1), 18).paths.map((p, i) => ({ id: `wave${i}`, brush: 'ballpoint', color: '#1c1c1e', size: 2, pts: p.flatMap(([x, y]) => [x, y, 0.5]) }));
await page.evaluate((strokes) => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const tr = ed.state.tr;
  const half = Math.ceil(strokes.length / 2);
  let i = 0;
  ed.state.doc.forEach((node, offset) => {
    if (i > 1) return;
    const top = ed.view.dom.offsetTop + ed.view.nodeDOM(offset).offsetTop;
    const part = (i === 0 ? strokes.slice(0, half) : strokes.slice(half)).map((s) => ({ ...s, pts: s.pts.map((v, k) => (k % 3 === 1 ? v - top : v)) }));
    tr.setNodeAttribute(offset, 'ink', [...(node.attrs.ink ?? []), ...part]);
    i++;
  });
  ed.view.dispatch(tr);
}, wave);
await page.waitForTimeout(300);
was = await inkNow();
const waveBlocks = new Set(was.filter((s) => s.id.startsWith('wave')).map((s) => s.block));
check(waveBlocks.size === 2, `the test word is stored across two blocks (${waveBlocks.size})`);
const wavePt = [wrap.x + wave[1].pts[3], wrap.y + wave[1].pts[4]];
await page.mouse.click(...wavePt);
await page.waitForTimeout(200);
check((await selCount()) === wave.length, `a word split across two blocks is picked up whole (${await selCount()} of ${wave.length})`);
await drag(wavePt, 0, 64);
now = await inkNow();
const waveAfter = now.filter((s) => s.id.startsWith('wave'));
check(waveAfter.length === wave.length && new Set(waveAfter.map((s) => s.block)).size === 1, `dropping it puts the whole word in one block (${new Set(waveAfter.map((s) => s.block)).size} blocks)`);

// 11f. Dropping a small blob onto a line of text makes an inline sketch between the words.
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');
await writeText(page, 'x2', wrap.x + 420, wrap.y + R(13), 14);
const sym = handPaths('x2', wrap.x + 420, wrap.y + R(13), 14).paths;
was = await inkNow();
const symIds = was.slice(-sym.length).map((s) => s.id);
await page.keyboard.press('Alt+l');
const textAt = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const r = ed.view.coordsAtPos(1 + 'Energy is '.length);
  return { x: r.left, base: r.bottom - 3, height: ed.view.nodeDOM(0).offsetHeight };
});
const symLeft = Math.min(...sym.flat().map((q) => q[0]));
const symFrom = mid(sym[0]);
await page.mouse.move(...symFrom);
await page.mouse.down();
await page.mouse.move(symFrom[0] - 40, symFrom[1] - 60, { steps: 6 });
await page.mouse.move(symFrom[0] + textAt.x + 1 - symLeft, symFrom[1] + textAt.base - (wrap.y + R(13)), { steps: 8 });
await page.waitForTimeout(150);
check(await page.locator(`${V} .drop-caret[display="inline"]`).count(), 'hovering over a line of text shows where the sketch will go in');
check(/Release to put it in the text/.test(await page.locator(`${V} .tb-hint`).innerText()), 'and the toolbar says what letting go will do');
await shot(page, 'ink-12-drop-into-text');
await page.mouse.up();
await page.waitForTimeout(300);
doc = await docJSON();
const p11 = doc.content.find((b) => b.type === 'paragraph');
const at = p11.content.findIndex((n) => n.type === 'inkInline');
check(at > 0 && /Energy is $/.test(p11.content[at - 1].text) && /^ conserved/.test(p11.content[at + 1]?.text ?? ''), `dropping it there puts an inline sketch between "is" and "conserved" (${JSON.stringify(p11.content.map((n) => n.text ?? `[${n.type}]`))})`);
now = byId(await inkNow());
check(symIds.every((id) => !now.has(id)), 'its strokes left the page');
check((await page.evaluate(() => document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor.view.nodeDOM(0).offsetHeight)) === textAt.height, 'the line of text did not get taller');
await shot(page, 'ink-13-dropped-into-text');
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(300);
doc = await docJSON();
now = byId(await inkNow());
check(!JSON.stringify(doc.content.find((b) => b.type === 'paragraph')).includes('inkInline') && symIds.every((id) => now.has(id)), `one ${MOD}+Z turns it back into free handwriting`);

// 11g. With the lasso, a sketch in the text can be pulled back out onto the page.
await drag(symFrom, symFrom[0] + textAt.x + 1 - symLeft - symFrom[0], textAt.base - (wrap.y + R(13)));
const sketchBox = await page.locator(`${V} .ProseMirror > p .ink-inline-node`).first().boundingBox();
check(!!sketchBox, 'the sketch is back in the sentence');
was = await inkNow();
await drag([sketchBox.x + sketchBox.width / 2, sketchBox.y + sketchBox.height / 2], 0, 32 * 14);
doc = await docJSON();
now = await inkNow();
const popped = now.filter((s) => !was.some((w) => w.id === s.id));
check(
  !JSON.stringify(doc.content.find((b) => b.type === 'paragraph')).includes('inkInline') && doc.content.find((b) => b.type === 'paragraph').content[0].text === 'Energy is conserved in a closed system.',
  'dragging the sketch out of the sentence leaves the text as it was',
);
check(popped.length === sym.length && new Set(popped.map((s) => s.block)).size === 1, `and puts it on the page as handwriting again (${popped.length} strokes)`);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(300);
doc = await docJSON();
check(JSON.stringify(doc.content.find((b) => b.type === 'paragraph')).includes('inkInline') && (await inkNow()).length === was.length, `one ${MOD}+Z puts it back in the sentence`);

// 11h. Dragging past the first line keeps the ink at the top of the note (it used to jump to the end),
// on lines of its own rather than on top of the first sentence.
await page.keyboard.press('Escape');
const kNow = byId(await inkNow());
const kFirst = kNow.get(was.find((s) => Math.abs(s.pts[0][0] - (kinetic[0][0][0] - wrap.x)) < 0.6 && Math.abs(s.pts[0][1] - (kinetic[0][0][1] - wrap.y)) < 0.6)?.id);
const kFrom = [wrap.x + kFirst.pts[3][0], wrap.y + kFirst.pts[3][1]];
await drag(kFrom, 0, -(R(3) + 60));
doc = await docJSON();
now = byId(await inkNow());
const kMoved = now.get(kFirst.id);
const kAll = [...now.values()].filter((s) => s.block === kMoved?.block);
const kTop = Math.min(...kAll.flatMap((s) => s.pts.map((q) => q[1])));
const textTop = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let top = 0;
  ed.state.doc.forEach((n, off) => {
    if (!top && n.type.name === 'paragraph') top = ed.view.dom.offsetTop + ed.view.nodeDOM(off).offsetTop;
  });
  return top;
});
const kBottom = Math.max(...kAll.flatMap((s) => s.pts.map((q) => q[1])));
check(
  !!kMoved && kMoved.block === doc.content[0].attrs.id && doc.content[0].type === 'inkBlock' && kTop >= 0 && kBottom <= textTop + 2,
  `a word dragged above the first line gets lines of its own at the top of the note, above the text (top ${kTop.toFixed(1)}, bottom ${kBottom.toFixed(1)}, text starts ${textTop})`,
);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);
doc = await docJSON();
check(doc.content[0].type === 'paragraph' && Math.abs(byId(await inkNow()).get(kFirst.id).pts[0][1] - kFirst.pts[0][1]) < 0.01, `one ${MOD}+Z puts it back`);

// 11i. Arrow keys nudge (a burst is one undo step); ⌥↓ moves a whole line.
const energy = handPaths('energy', wrap.x + 10 + handPaths('kinetic ', 0, 0, 18).width, wrap.y + R(3), 18).paths;
await page.mouse.click(...mid(energy[0]));
await page.waitForTimeout(200);
const eCount = await selCount();
was = byId(await inkNow());
const eId = [...was.values()].find((s) => Math.abs(s.pts[0][0] - (energy[0][0][0] - wrap.x)) < 0.6 && Math.abs(s.pts[0][1] - (energy[0][0][1] - wrap.y)) < 0.6)?.id;
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
now = byId(await inkNow());
check(eCount > 1 && Math.abs(now.get(eId).pts[0][0] - was.get(eId).pts[0][0] - 5) < 0.01, 'five arrow presses nudge the selection 5px');
const eIds = [...now.values()].filter((s) => Math.abs(s.pts[0][0] - (was.get(s.id)?.pts[0][0] ?? NaN) - 5) < 0.01).map((s) => s.id);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);
now = byId(await inkNow());
check(Math.abs(now.get(eId).pts[0][0] - was.get(eId).pts[0][0]) < 0.01, `one ${MOD}+Z undoes the whole burst of nudges`);
await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(150);
now = byId(await inkNow());
check(Math.abs(now.get(eId).pts[0][1] - was.get(eId).pts[0][1] - 32) < 1, '⌥↓ moves it down one ruled line');
// three small nudges put it 3px off its line; ⌥↓ then lands it on the next line, not 3px off it
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(150);
now = byId(await inkNow());
check(Math.abs(now.get(eId).pts[0][1] - was.get(eId).pts[0][1] - 64) < 1, `⌥↓ from 3px off its line lands on the next ruled line (moved ${(now.get(eId).pts[0][1] - was.get(eId).pts[0][1]).toFixed(1)}, want 64)`);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);

// 11j. Resizing from a corner handle scales about the opposite corner; one undo puts it back.
was = byId(await inkNow());
const padOf = (s) => s.size * 1.0; // felt marker: strokeBounds adds 1 × size
const boxOf = (list) => ({
  minX: Math.min(...list.flatMap((s) => s.pts.map((q) => q[0] - padOf(s)))),
  minY: Math.min(...list.flatMap((s) => s.pts.map((q) => q[1] - padOf(s)))),
});
const eBefore = eIds.map((id) => was.get(id));
const eBox = boxOf(eBefore);
const hb = await page.locator(`${V} .sel-box circle`).nth(3).boundingBox();
const handle = [hb.x + hb.width / 2, hb.y + hb.height / 2];
await drag(handle, (handle[0] - (wrap.x + eBox.minX)) * 0.5, (handle[1] - (wrap.y + eBox.minY)) * 0.5);
now = byId(await inkNow());
const eAfter = eIds.map((id) => now.get(id));
const eBox2 = boxOf(eAfter);
const grew = eAfter[0].size / eBefore[0].size;
check(Math.abs(grew - 1.5) < 0.03 && Math.abs(eBox2.minX - eBox.minX) < 1 && Math.abs(eBox2.minY - eBox.minY) < 1, `dragging the corner handle resizes the word about its opposite corner (×${grew.toFixed(2)})`);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);
const eUndone = byId(await inkNow());
check(eIds.every((id) => Math.abs(eUndone.get(id).size - was.get(id).size) < 0.001), `one ${MOD}+Z undoes the resize`);

// 11k. ⌘-drag with the pen picks ink up instead of drawing.
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');
was = byId(await inkNow());
const eNow = was.get(eId);
const ePt = [wrap.x + eNow.pts[2][0], wrap.y + eNow.pts[2][1]];
await page.keyboard.down('Meta');
await drag(ePt, 24, 0);
await page.keyboard.up('Meta');
now = byId(await inkNow());
check(now.size === was.size && Math.abs(now.get(eId).pts[0][0] - eNow.pts[0][0] - 24) < 0.6, `⌘-dragging handwriting with the pen moves it instead of drawing (${now.size - was.size} new strokes)`);

// 11l. Ink written on the typed text stays ink when it is nudged: a circle around a word, a tick after the line.
const onText = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const p = ed.state.doc.child(0);
  const i = p.textBetween(0, p.content.size, undefined, '￼').indexOf('conserved');
  const a = ed.view.coordsAtPos(1 + i);
  const b = ed.view.coordsAtPos(1 + i + 'conserved'.length);
  const end = ed.view.coordsAtPos(1 + p.content.size);
  return { left: a.left, right: b.left, top: a.top, bottom: a.bottom, endX: end.left, mid: (end.top + end.bottom) / 2 };
});
const inlineOnLine = async () => (JSON.stringify((await docJSON()).content[0]).match(/"inkInline"/g) ?? []).length;
const inlinesBefore = await inlineOnLine();
const strokesBefore = new Set((await inkNow()).map((s) => s.id));
const ringC = [(onText.left + onText.right) / 2, (onText.top + onText.bottom) / 2];
const ringR = [(onText.right - onText.left) / 2 + 8, (onText.bottom - onText.top) / 2 + 6];
await page.mouse.move(ringC[0] + ringR[0], ringC[1]);
await page.mouse.down();
for (let i = 1; i <= 40; i++) {
  const t = (i / 36) * Math.PI * 2;
  await page.mouse.move(ringC[0] + Math.cos(t) * ringR[0], ringC[1] + Math.sin(t) * ringR[1]);
}
await page.mouse.up();
await page.mouse.move(onText.endX + 14, onText.mid);
await page.mouse.down();
await page.mouse.move(onText.endX + 18, onText.mid + 5, { steps: 3 });
await page.mouse.move(onText.endX + 28, onText.mid - 8, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(250);
was = await inkNow();
const [ring, tick] = was.filter((s) => !strokesBefore.has(s.id));
await page.keyboard.press('Alt+l');
await drag([wrap.x + ring.pts[5][0], wrap.y + ring.pts[5][1]], 12, 0);
await drag([wrap.x + tick.pts[1][0], wrap.y + tick.pts[1][1]], 12, 0);
now = byId(await inkNow());
check(
  (await inlineOnLine()) === inlinesBefore && now.has(ring.id) && now.has(tick.id) && Math.abs(now.get(tick.id).pts[0][0] - tick.pts[0][0] - 12) < 0.6,
  `nudging a circle around a typed word, or a tick after the line, keeps them as handwriting (inline sketches ${inlinesBefore} → ${await inlineOnLine()}, circle ${now.has(ring.id) ? 'kept' : 'gone'}, tick moved ${now.has(tick.id) ? (now.get(tick.id).pts[0][0] - tick.pts[0][0]).toFixed(1) : 'gone'})`,
);
const ringDy = (now.get(ring.id)?.pts[0][1] ?? NaN) - ring.pts[0][1];
const tickDy = (now.get(tick.id)?.pts[0][1] ?? NaN) - tick.pts[0][1];
check(Math.abs(ringDy) < 0.5 && Math.abs(tickDy) < 0.5, `and moved sideways they stay at their height on the text (circle ${ringDy.toFixed(1)}, tick ${tickDy.toFixed(1)})`);
await shot(page, 'ink-14-annotations');
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');

// 11m. Dragging to the top edge scrolls the page, and the drop still lands under the pointer.
await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  ed.commands.insertContentAt(ed.state.doc.content.size, Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Line ${i + 1}` }] })));
});
await page.waitForTimeout(400);
const scroller = page.locator(`${V} .note-scroll`);
await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(300);
wrap = await wrapBox();
const lastBottom = await page.evaluate(() => {
  const pm = document.querySelector('.note-view:not(.is-hidden) .ProseMirror');
  return pm.lastElementChild.getBoundingClientRect().bottom;
});
const farBase = Math.round((lastBottom - wrap.y + 40) / 32) * 32 + 23; // a ruled line just below the text
await writeText(page, 'far', wrap.x + 60, wrap.y + farBase, 18);
const far = handPaths('far', wrap.x + 60, wrap.y + farBase, 18).paths;
await page.waitForTimeout(200);
was = await inkNow();
const farIds = was.slice(-far.length).map((s) => s.id);
await page.keyboard.press('Alt+l');
const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
const dockBottom = (await page.locator(`${V} .toolbar-dock`).boundingBox()).y + 48;
const farFrom = mid(far[0]);
const w0 = await wrapBox();
await page.mouse.move(...farFrom);
await page.mouse.down();
await page.mouse.move(farFrom[0] + 20, dockBottom + 8, { steps: 12 });
await page.waitForTimeout(700);
await page.mouse.move(farFrom[0] + 20, 520, { steps: 8 });
await page.waitForTimeout(150);
// ⌥ keeps it as ink: how far the page scrolled varies from run to run, and over a line of text a small word
// would otherwise go into the sentence.
await page.keyboard.down('Alt');
await page.mouse.up();
await page.keyboard.up('Alt');
await page.waitForTimeout(300);
const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
const w1 = await wrapBox();
now = byId(await inkNow());
const f0 = was.find((s) => s.id === farIds[0]);
const f1 = now.get(farIds[0]);
// The grabbed point followed the pointer through the scroll: it lands where the mouse let go (give or take a snap).
const wantDy = 520 - w1.y - (farFrom[1] - w0.y);
check(scrollBefore - scrollAfter > 200, `dragging to the top edge scrolled the page up (${scrollBefore - scrollAfter}px)`);
check(
  !!f1 && Math.abs(f1.pts[0][1] - f0.pts[0][1] - wantDy) <= 17 && Math.abs(f1.pts[0][0] - f0.pts[0][0] - 20) < 0.6,
  `after scrolling, the word lands under the pointer (moved ${f1 ? (f1.pts[0][1] - f0.pts[0][1]).toFixed(1) : '?'}, pointer moved ${wantDy.toFixed(1)})`,
);
check(!!f1 && farIds.every((id) => now.get(id)?.block === f1.block), 'and arrives whole, in one block');
await shot(page, 'ink-15-autoscrolled');

// 11n. After a drop the menu waits for a tap; up against the toolbar it opens below the selection instead of hiding under it.
check((await page.locator(`${V} .ink-sel-menu`).count()) === 0, 'after a drop the menu stays out of the way until the selection is tapped');
await page.mouse.click(w1.x + f1.pts[2][0], w1.y + f1.pts[2][1]);
await page.waitForTimeout(250);
check((await page.locator(`${V} .ink-sel-menu`).count()) === 1, 'a tap on the selection brings the menu back');
const selRect = await page.locator(`${V} .sel-box rect`).boundingBox();
await scroller.evaluate((el, dy) => (el.scrollTop += dy), selRect.y - (dockBottom + 4));
await page.waitForTimeout(250);
const selNow = await page.locator(`${V} .sel-box rect`).boundingBox();
const menuBox = await page.locator(`${V} .ink-sel-menu`).boundingBox();
check(!!menuBox && !!selNow && menuBox.y > selNow.y + selNow.height - 1, `near the toolbar the selection menu opens below the selection (menu at ${menuBox?.y.toFixed(0)}, selection ends ${(selNow.y + selNow.height).toFixed(0)})`);
await shot(page, 'ink-16-menu-below');

// 12. More of the feel: in a fresh note with two typed sentences.
await page.keyboard.press('Escape');
await page.keyboard.press(`${MOD}+n`);
await page.waitForTimeout(400);
await page.keyboard.type('Light reactions');
await page.keyboard.press('Enter');
await page.keyboard.type('Photosynthesis converts light energy into chemical energy.');
await page.keyboard.press('Enter');
await page.keyboard.type('Chlorophyll absorbs mostly red and blue light.');
await page.waitForTimeout(300);
await page.keyboard.press('Alt+p');
await page.waitForTimeout(200);
wrap = await wrapBox();
const newIds = async (fn) => {
  const before = new Set((await inkNow()).map((s) => s.id));
  await fn();
  await page.waitForTimeout(120);
  return (await inkNow()).filter((s) => !before.has(s.id)).map((s) => s.id);
};
const strokePath = async (pts) => {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const q of pts.slice(1)) await page.mouse.move(q[0], q[1], { steps: 2 });
  await page.mouse.up();
};
const inlineIn = async (i) => page.evaluate((i) => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let n = 0;
  ed.state.doc.child(i).forEach((c) => (n += c.type.name === 'inkInline' ? 1 : 0));
  return n;
}, i);
const textAtOffset = (i, text) => page.evaluate(([i, text]) => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let pos = 0;
  ed.state.doc.forEach((_n, off, k) => {
    if (k === i) pos = off + 1;
  });
  const r = ed.view.coordsAtPos(pos + ed.state.doc.child(i).textContent.indexOf(text));
  return { x: r.left, base: r.bottom - 3 };
}, [i, text]);

// 12a. The first stroke on the line after a skipped line is kept (the area's resize strip swallowed it).
await writeText(page, 'Force', wrap.x + 8, wrap.y + R(3), 18);
const ball = handPaths('ball', wrap.x + 8, wrap.y + R(5), 20).paths;
const ballIds = await newIds(() => writeText(page, 'ball', wrap.x + 8, wrap.y + R(5), 20));
check(ballIds.length === ball.length, `after a skipped line every stroke is kept ("ball": ${ballIds.length} of ${ball.length})`);
await shot(page, 'ink-17-after-skipped-line');

// 12b. Pressing the outline of a drawn cell picks up what is drawn inside it.
const cell = { x: wrap.x + 420, y: wrap.y + R(8) - 6 };
const ellipse = (cx, cy, rx, ry, n = 44) => Array.from({ length: n + 3 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2 + 0.4) * rx, cy + Math.sin((i / n) * Math.PI * 2 + 0.4) * ry]);
const cellIds = await newIds(async () => {
  await strokePath(ellipse(cell.x, cell.y, 52, 40));
  await strokePath(ellipse(cell.x - 8, cell.y + 2, 14, 11, 24));
  for (const [dx, dy] of [[24, -14], [28, 10], [-30, -18]]) await strokePath([[cell.x + dx, cell.y + dy], [cell.x + dx + 1.5, cell.y + dy + 0.5]]);
});
await page.keyboard.press('Alt+l');
await page.mouse.click(...ellipse(cell.x, cell.y, 52, 40)[0]);
await page.waitForTimeout(200);
check(cellIds.length === 5 && (await selCount()) === 5, `pressing a drawn cell's outline picks up its nucleus and dots too (${await selCount()} of ${cellIds.length})`);
await page.keyboard.press('Escape');

// 12c. Small writing still comes word by word.
await page.keyboard.press('Alt+p');
const tiny = handPaths('mass', wrap.x + 20, wrap.y + R(13), 10).paths;
const tinyIds = await newIds(() => writeText(page, 'mass', wrap.x + 20, wrap.y + R(13), 10));
await writeText(page, 'times', wrap.x + 20 + handPaths('mass ', 0, 0, 10).width, wrap.y + R(13), 10);
await page.keyboard.press('Alt+l');
await page.mouse.click(...mid(tiny[0]));
await page.waitForTimeout(200);
check((await selCount()) === tinyIds.length, `a tap on small handwriting picks up one whole word (${await selCount()} of ${tinyIds.length})`);
const clear = await page.evaluate(() => {
  const m = document.querySelector('.note-view:not(.is-hidden) .ink-sel-menu').getBoundingClientRect();
  const top = Math.min(...[...document.querySelectorAll('.note-view:not(.is-hidden) .sel-box circle')].map((c) => c.getBoundingClientRect().top));
  return { menuBottom: m.bottom, handlesTop: top };
});
check(clear.menuBottom <= clear.handlesTop, `the menu sits clear of a small selection's handles (menu ends ${clear.menuBottom.toFixed(0)}, handles start ${clear.handlesTop.toFixed(0)})`);
await page.keyboard.press('Escape');

// 12d. Wherever it is let go, a word lands on the nearest ruled line; ⇧⌘Z redoes the move.
const force = handPaths('Force', wrap.x + 8, wrap.y + R(3), 18).paths;
const fId = (await inkNow()).find((s) => Math.abs(s.pts[0][0] - (force[0][0][0] - wrap.x)) < 0.6 && Math.abs(s.pts[0][1] - (force[0][0][1] - wrap.y)) < 0.6)?.id;
// [how far it is dragged, the line it should land on (relative to where it was)]
for (const [dy, want] of [
  [75, 64],
  [88, 96],
  [19, 32],
]) {
  const f0 = byId(await inkNow()).get(fId);
  await drag([wrap.x + f0.pts[2][0], wrap.y + f0.pts[2][1]], 200, dy);
  const f1 = byId(await inkNow()).get(fId);
  const off = dy - want;
  check(Math.abs(f1.pts[0][1] - f0.pts[0][1] - want) < 1, `let go ${off >= 0 ? '+' : ''}${off}px off a line, a word still lands on the nearest one (moved ${(f1.pts[0][1] - f0.pts[0][1]).toFixed(1)}, want ${want})`);
  if (dy === 75) {
    await page.keyboard.press(`${MOD}+z`);
    await page.waitForTimeout(200);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await page.waitForTimeout(200);
    check(Math.abs(byId(await inkNow()).get(fId).pts[0][1] - f1.pts[0][1]) < 0.01, `${MOD}+Z then ${MOD}+Shift+Z redoes the move`);
  }
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(200);
}

// 12e. Let go at the very start of a typed line, a word joins the sentence instead of sitting on its first letters.
const tinyNow = (await inkNow()).filter((s) => tinyIds.includes(s.id));
const tinyLeft = Math.min(...tinyNow.flatMap((s) => s.pts.map((q) => q[0]))) - tinyNow[0].size;
const p2 = await textAtOffset(1, 'Chlorophyll');
await drag([wrap.x + tinyNow[0].pts[2][0], wrap.y + tinyNow[0].pts[2][1]], p2.x - 1 - (wrap.x + tinyLeft), p2.base - (wrap.y + R(13)));
check((await inlineIn(1)) === 1, 'a word let go at the start of a typed line joins the sentence');
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);

// 12f. A drawing let go between two paragraphs gets lines of its own there, instead of covering both.
await page.keyboard.press('Alt+p');
const bx = { x: wrap.x + 200, y: wrap.y + R(17) };
const boxIds = await newIds(async () => {
  await strokePath([[bx.x, bx.y - 50], [bx.x + 90, bx.y - 50], [bx.x + 90, bx.y], [bx.x, bx.y], [bx.x, bx.y - 50]]);
  await strokePath([[bx.x + 10, bx.y - 25], [bx.x + 80, bx.y - 25]]);
});
await page.keyboard.press('Alt+l');
const p1Bottom = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  return ed.view.nodeDOM(0).getBoundingClientRect().bottom;
});
await page.mouse.move(bx.x + 45, bx.y - 50);
await page.mouse.down();
await page.mouse.move(bx.x - 20, bx.y - 200, { steps: 8 });
await page.mouse.move(bx.x - 120, p1Bottom - 2, { steps: 8 });
await page.waitForTimeout(150);
check(await page.locator(`${V} .room-line[display="inline"]`).count(), 'over the text, a line shows where it will make room');
await shot(page, 'ink-18-room-between-paragraphs');
await page.mouse.up();
await page.waitForTimeout(300);
doc = await docJSON();
const blocks = doc.content.map((b) => b.type);
const boxBlock = doc.content.findIndex((b) => (b.attrs?.ink ?? []).some((s) => boxIds.includes(s.id)));
const covered = await page.evaluate((ids) => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const wr = document.querySelector('.note-view:not(.is-hidden) .editor-wrap').getBoundingClientRect();
  const rects = [];
  ed.state.doc.forEach((n, off) => {
    if (n.type.name !== 'paragraph' || !n.textContent) return;
    const range = document.createRange();
    range.selectNodeContents(ed.view.nodeDOM(off));
    for (const q of range.getClientRects()) rects.push(q);
  });
  let hits = 0;
  ed.state.doc.forEach((n, off) => {
    const top = ed.view.dom.offsetTop + ed.view.nodeDOM(off).offsetTop;
    for (const s of n.attrs.ink ?? []) {
      if (!ids.includes(s.id)) continue;
      for (let i = 0; i + 1 < s.pts.length; i += 3) {
        const x = wr.left + s.pts[i];
        const y = wr.top + s.pts[i + 1] + top;
        if (rects.some((q) => x > q.left && x < q.right && y > q.top && y < q.bottom)) hits++;
      }
    }
  });
  return hits;
}, boxIds);
check(boxBlock === 1 && blocks[0] === 'paragraph' && blocks[1] === 'inkBlock' && blocks[2] === 'paragraph' && covered === 0, `a drawing let go between two paragraphs gets lines of its own between them (blocks ${blocks.slice(0, 3).join(', ')}; points on text ${covered})`);
await shot(page, 'ink-19-room-made');
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);
// Pushed up from the handwriting area onto the last typed line, it goes back into the top of that area:
// no new lines open and nothing else in the area moves.
const blocksBefore = (await docJSON()).content.length;
const othersBefore = (await inkNow()).filter((s) => !boxIds.includes(s.id));
await page.mouse.move(bx.x + 45, bx.y);
await page.mouse.down();
await page.mouse.move(bx.x + 45, bx.y - 200, { steps: 8 });
await page.mouse.move(bx.x + 45, wrap.y + R(1) - 8 + 50, { steps: 8 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(300);
const othersAfter = byId(await inkNow());
const boxAfter = (await inkNow()).filter((s) => boxIds.includes(s.id));
const p2Bottom = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  return ed.view.dom.offsetTop + ed.view.nodeDOM(ed.state.doc.child(0).nodeSize).offsetTop + ed.view.nodeDOM(ed.state.doc.child(0).nodeSize).offsetHeight;
});
check(
  (await docJSON()).content.length === blocksBefore &&
    othersBefore.every((s) => Math.abs(othersAfter.get(s.id).pts[0][1] - s.pts[0][1]) < 0.01) &&
    Math.min(...boxAfter.flatMap((s) => s.pts.map((q) => q[1]))) >= p2Bottom,
  `pushed up onto the last typed line, a drawing goes back into its handwriting area and nothing else moves (top ${Math.min(...boxAfter.flatMap((s) => s.pts.map((q) => q[1]))).toFixed(0)}, text ends ${p2Bottom})`,
);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);

// 12g. A big word shrunk to fit a sentence comes back out at its own size.
await page.keyboard.press('Alt+p');
const big = handPaths('Big', wrap.x + 300, wrap.y + R(19), 26).paths;
const bigIds = await newIds(() => writeText(page, 'Big', wrap.x + 300, wrap.y + R(19), 26));
await page.keyboard.press('Alt+l');
const bigNow = (await inkNow()).filter((s) => bigIds.includes(s.id));
const height = (list) => Math.max(...list.flatMap((s) => s.pts.map((q) => q[1]))) - Math.min(...list.flatMap((s) => s.pts.map((q) => q[1])));
const bigLeft = Math.min(...bigNow.flatMap((s) => s.pts.map((q) => q[0]))) - bigNow[0].size;
const into = await textAtOffset(0, 'energy into');
await drag([wrap.x + bigNow[0].pts[3][0], wrap.y + bigNow[0].pts[3][1]], into.x + 1 - (wrap.x + bigLeft), into.base - (wrap.y + R(19)));
const fitNow = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let fit = null;
  ed.state.doc.child(0).forEach((c) => {
    if (c.type.name === 'inkInline') fit = c.attrs.fit;
  });
  return fit;
});
check(fitNow !== null && fitNow < 1, `a big word dropped into a sentence is shrunk to fit the line (×${fitNow})`);
const sk = await page.locator(`${V} .ProseMirror > p .ink-inline-node`).first().boundingBox();
const outIds = await newIds(() => drag([sk.x + sk.width / 2, sk.y + sk.height / 2], 0, R(15) - R(0)));
const outNow = (await inkNow()).filter((s) => outIds.includes(s.id));
check(outNow.length === bigIds.length && Math.abs(height(outNow) / height(bigNow) - 1) < 0.03 && Math.abs(outNow[0].size - bigNow[0].size) < 0.05, `pulled back out, it is its own size again (${((height(outNow) / height(bigNow)) * 100).toFixed(0)}%, pen ${outNow[0]?.size})`);

// 12h. A word let go just off the left edge of the word above lines up with it.
await page.keyboard.press('Escape');
wrap = await wrapBox();
const tinyBack = (await inkNow()).filter((s) => tinyIds.includes(s.id));
const massLeft = Math.min(...tinyBack.flatMap((s) => s.pts.map((q) => q[0])));
const outLeft = Math.min(...outNow.flatMap((s) => s.pts.map((q) => q[0])));
const outBase = Math.round((Math.max(...outNow.flatMap((s) => s.pts.map((q) => q[1]))) + 1) / 32 - 0.75);
await drag([wrap.x + outNow[0].pts[3][0], wrap.y + outNow[0].pts[3][1]], massLeft + 3 - outLeft, R(14) - R(outBase));
const aligned = (await inkNow()).filter((s) => outIds.includes(s.id));
const alignedLeft = Math.min(...aligned.flatMap((s) => s.pts.map((q) => q[0])));
check(Math.abs(alignedLeft - massLeft) < 1, `a word let go 3px off the edge of the word above lines up with it (edges ${(alignedLeft - massLeft).toFixed(1)}px apart)`);

// 12i. In a narrow window the toolbar still says what letting go will do.
await page.setViewportSize({ width: 1024, height: 768 });
await page.waitForTimeout(400);
wrap = await wrapBox();
const hintShown = async () => page.evaluate(() => {
  const h = document.querySelector('.note-view:not(.is-hidden) .tb-hint');
  return h ? { text: h.textContent, shown: getComputedStyle(h).display !== 'none' && h.getBoundingClientRect().width > 20 } : null;
});
const idle = await hintShown();
check(!idle, `at rest Select puts no explainer in the bar${idle ? ` (found "${idle.text}")` : ''}`);
const sc = await page.evaluate(() => {
  const p = document.querySelector('.note-view:not(.is-hidden) .page');
  return p.getBoundingClientRect().width / p.offsetWidth;
});
const forceNow = byId(await inkNow()).get(fId);
const target = await textAtOffset(0, 'chemical');
await page.mouse.move(wrap.x + forceNow.pts[2][0] * sc, wrap.y + forceNow.pts[2][1] * sc);
await page.mouse.down();
await page.mouse.move(target.x + 6, target.base - 20, { steps: 8 });
await page.mouse.move(target.x + 2 + (forceNow.pts[2][0] - Math.min(...forceNow.pts.map((q) => q[0]))) * sc, target.base - (R(3) - forceNow.pts[2][1]) * sc, { steps: 6 });
await page.waitForTimeout(150);
const hovering = await hintShown();
check(!!hovering?.shown && /Release to put it in the text/.test(hovering.text), `and while dragging over text it says "${hovering?.text}"`);
await shot(page, 'ink-20-narrow-hint');
await page.keyboard.press('Escape');
await page.mouse.up();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(300);
wrap = await wrapBox();

// 12j. Esc mid-drag puts the ink back and lets go of the closed hand at once.
const cursorNow = () => page.evaluate(() => document.querySelector('.note-view:not(.is-hidden) .surface').dataset.inkCursor ?? null);
const fNow = byId(await inkNow()).get(fId);
const fAt = [wrap.x + fNow.pts[2][0], wrap.y + fNow.pts[2][1]];
await page.mouse.move(...fAt);
await page.mouse.down();
await page.mouse.move(fAt[0] + 40, fAt[1] + 40, { steps: 6 });
await page.waitForTimeout(80);
const whileDragging = await cursorNow();
await page.keyboard.press('Escape');
await page.waitForTimeout(80);
const afterEsc = await cursorNow();
await page.mouse.up();
check(whileDragging === 'grabbing' && afterEsc !== 'grabbing' && Math.abs(byId(await inkNow()).get(fId).pts[0][1] - fNow.pts[0][1]) < 0.01, `Esc mid-drag puts it back and drops the closed hand (cursor ${whileDragging} → ${afterEsc})`);

// 12k. With the pen, holding ⌘ over ink shows the hand straight away.
await page.keyboard.press('Alt+p');
await page.mouse.move(fAt[0] + 1, fAt[1]);
await page.waitForTimeout(80);
await page.keyboard.down('Meta');
await page.waitForTimeout(80);
const withCmd = await cursorNow();
await page.keyboard.up('Meta');
await page.waitForTimeout(80);
check(withCmd === 'grab' && (await cursorNow()) === null, `with the pen, ⌘ over ink shows the hand without moving the pointer (${withCmd})`);

// 12l. Ink can't be dragged off the end of the page.
await page.keyboard.press('Alt+l');
const pageBottom = await page.evaluate(() => {
  const wr = document.querySelector('.note-view:not(.is-hidden) .editor-wrap').getBoundingClientRect();
  return document.querySelector('.note-view:not(.is-hidden) .page').getBoundingClientRect().bottom - wr.top;
});
await drag(fAt, 0, pageBottom + 400);
const fLow = byId(await inkNow()).get(fId);
check(Math.max(...fLow.pts.map((q) => q[1])) < pageBottom, `dragged past the end of the page, it stays on the paper (lowest point ${Math.max(...fLow.pts.map((q) => q[1])).toFixed(0)}, page ends ${pageBottom.toFixed(0)})`);
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);
await page.locator(`${V} .note-scroll`).evaluate((el) => (el.scrollTop = 0));
await page.waitForTimeout(250);

// 12m. Zoomed in, writing still comes word by word.
await page.keyboard.press('Escape');
for (let i = 0; i < 4; i++) {
  await page.keyboard.press(`${MOD}+Equal`);
  await page.waitForTimeout(120);
}
await page.keyboard.press('Alt+p');
await page.waitForTimeout(300);
wrap = await wrapBox();
const zs = await page.evaluate(() => {
  const p = document.querySelector('.note-view:not(.is-hidden) .page');
  return p.getBoundingClientRect().width / p.offsetWidth;
});
const zBase = wrap.y + R(11) * zs;
const zMass = handPaths('mass', wrap.x + 300 * zs, zBase, 16).paths;
const zIds = await newIds(() => writeText(page, 'mass', wrap.x + 300 * zs, zBase, 16));
await writeText(page, 'velocity', wrap.x + 300 * zs + handPaths('mass ', 0, 0, 16).width, zBase, 16);
await page.keyboard.press('Alt+l');
await page.mouse.click(...mid(zMass[0]));
await page.waitForTimeout(200);
check(zs > 1.3 && (await selCount()) === zIds.length, `zoomed in (×${zs.toFixed(2)}), a tap still picks up one whole word (${await selCount()} of ${zIds.length})`);
await page.keyboard.press('Escape');
await page.keyboard.press(`${MOD}+0`);
await page.waitForTimeout(300);


// 13. The Select box, in a fresh note: Esc, Space, ⌥, ⇧, a box over text, a tap.
await page.keyboard.press(`${MOD}+n`);
await page.waitForTimeout(400);
await page.keyboard.type('Select box');
await page.keyboard.press('Enter');
await page.keyboard.type('A typed line to ask about.');
await page.waitForTimeout(200);
await page.keyboard.press('Alt+p');
await page.waitForTimeout(150);
wrap = await wrapBox();
const abIds = await newIds(() => writeText(page, 'ab', wrap.x + 40, wrap.y + R(4), 18));
const cdIds = await newIds(() => writeText(page, 'cd', wrap.x + 340, wrap.y + R(4), 18));
const boxAround = (ids) => {
  const pts = [];
  return inkNow().then((all) => {
    for (const st of all) if (ids.includes(st.id)) pts.push(...st.pts);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return { x0: wrap.x + Math.min(...xs) - 12, y0: wrap.y + Math.min(...ys) - 12, x1: wrap.x + Math.max(...xs) + 12, y1: wrap.y + Math.max(...ys) + 12 };
  });
};
const ab = await boxAround(abIds);
const cd = await boxAround(cdIds);
await page.keyboard.press('Alt+l');
await page.waitForTimeout(150);
const selectedIds = () =>
  page.evaluate(() => Number(document.querySelector('.note-view:not(.is-hidden) .ink-sel-menu')?.dataset.strokes ?? 0));

// 13a. Esc lets a box go; what it would catch glows while it is dragged.
await page.mouse.move(ab.x0, ab.y0);
await page.mouse.down();
await page.mouse.move(ab.x1, ab.y1, { steps: 8 });
await page.waitForTimeout(120);
const halo = await page.evaluate(() => document.querySelectorAll('.note-view:not(.is-hidden) .ink-pen g[filter*="caught"] path').length);
check(halo === abIds.length, `while the box is dragged, the ink it would catch glows (${halo} of ${abIds.length})`);
await shot(page, 'ink-21-select-box');
await page.keyboard.press('Escape');
await page.waitForTimeout(80);
await page.mouse.up();
await page.waitForTimeout(150);
check(!(await page.locator(`${V} .ink-overlay .marquee`).count()) && (await selectedIds()) === 0, 'Esc lets the box go and selects nothing');

// 13b. Holding Space moves the box at its size: dragged around "ab", then carried over "cd".
const docBeforeSpace = JSON.stringify(await docJSON());
await page.mouse.move(ab.x0, ab.y0);
await page.mouse.down();
await page.mouse.move(ab.x1, ab.y1, { steps: 8 });
await page.keyboard.down('Space');
await page.mouse.move(ab.x1 + (cd.x0 - ab.x0), ab.y1 + (cd.y0 - ab.y0), { steps: 10 });
await page.keyboard.up('Space');
await page.mouse.move(Math.max(ab.x1 + (cd.x0 - ab.x0), cd.x1), Math.max(ab.y1 + (cd.y0 - ab.y0), cd.y1), { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(200);
const typedNothing = JSON.stringify(await docJSON()) === docBeforeSpace;
check((await selectedIds()) === cdIds.length && typedNothing, `holding Space moves the box (it caught ${await selectedIds()} of the ${cdIds.length} strokes it was moved over; the Space typed ${typedNothing ? 'nothing' : 'into the note'})`);

// 13c. ⇧ adds a box to the selection.
await page.keyboard.down('Shift');
await page.mouse.move(ab.x0, ab.y0);
await page.mouse.down();
await page.mouse.move(ab.x1, ab.y1, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(200);
check((await selectedIds()) === abIds.length + cdIds.length, `⇧ adds a box to the selection (${await selectedIds()} strokes)`);

// 13d. ⌥ grows the box from where it was pressed: pressed on the bare page between the two words and dragged
// past "cd", it reaches back over "ab" too.
await page.mouse.click(wrap.x + 600, wrap.y + R(9));
await page.waitForTimeout(150);
check((await selectedIds()) === 0, 'a tap on the bare page clears the selection');
const between = [(ab.x1 + cd.x0) / 2, (ab.y0 + ab.y1) / 2];
await page.mouse.move(...between);
await page.keyboard.down('Alt');
await page.mouse.down();
await page.mouse.move(Math.max(cd.x1, between[0] + (between[0] - ab.x0)) + 20, ab.y1 + 2, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Alt');
await page.waitForTimeout(200);
check((await selectedIds()) === abIds.length + cdIds.length, `⌥ grows the box from its centre, both ways (${await selectedIds()} of ${abIds.length + cdIds.length})`);
await page.mouse.click(wrap.x + 600, wrap.y + R(9));

// 13e. A box over typed text only stays as an area, with the Ask composer under it; Esc puts both away.
const line2 = await page.locator(`${V} .ProseMirror > p`).first().boundingBox();
await page.mouse.move(line2.x - 6, line2.y + 2);
await page.mouse.down();
await page.mouse.move(line2.x + 200, line2.y + line2.height + 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
check(
  (await page.locator(`${V} .area-frame`).count()) === 1 && (await page.locator(`${V} .snip-ask`).count()) === 1 && (await selectedIds()) === 0,
  'a box over typed text stays as an area and opens the Ask composer under it',
);
await shot(page, 'ink-22-area');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check(!(await page.locator(`${V} .area-frame`).count()) && !(await page.locator(`${V} .snip-ask`).count()), 'Esc puts the area and its composer away');

// 14. A one-stroke arrow, held at its end, snaps to a clean arrow of the marker's width.
await page.keyboard.press('Alt+p');
const ay0 = wrap.y + R(7);
const arrowIds = await newIds(async () => {
  await page.mouse.move(wrap.x + 60, ay0);
  await page.mouse.down();
  await page.mouse.move(wrap.x + 240, ay0 + 3, { steps: 18 });
  await page.mouse.move(wrap.x + 222, ay0 - 9, { steps: 4 });
  await page.mouse.move(wrap.x + 240, ay0 + 3, { steps: 4 });
  await page.mouse.move(wrap.x + 222, ay0 + 15, { steps: 4 });
  await page.waitForTimeout(700);
  await page.mouse.up();
});
const arrowStroke = await page.evaluate((id) => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let out = null;
  ed.state.doc.forEach((n) => {
    for (const st of n.attrs.ink ?? []) if (st.id === id) out = st;
  });
  return out;
}, arrowIds[0]);
const arrowXs = arrowStroke ? arrowStroke.pts.filter((_, i) => i % 3 === 0) : [];
const tipI = arrowXs.indexOf(Math.max(...arrowXs));
const tipAt = arrowXs[tipI] ?? 0;
const level = arrowStroke ? Math.abs(arrowStroke.pts[1] - arrowStroke.pts[tipI * 3 + 1]) : NaN;
check(
  arrowIds.length === 1 && arrowStroke?.brush === 'mono' && !arrowStroke.closed && Math.abs(arrowStroke.size - 1.6 * 1.6 * 0.95) < 0.01,
  `a line that ends in a V head, held, becomes a clean arrow at the marker's width (brush ${arrowStroke?.brush}, size ${arrowStroke?.size?.toFixed(2)})`,
);
check(Math.abs(tipAt - 240) < 4 && level < 0.01, `its shaft is level and ends at the tip (tip x ${tipAt.toFixed(1)}, rise ${level.toFixed(2)})`);
await shot(page, 'ink-23-arrow');

// 15. The bar: the active size retunes its slot; in a narrow window the settings fold into one button.
await page.locator(`${V} .tb-size.is-active`).click();
await page.locator('.tool-pop.is-size input[type="range"]').fill('3');
await page.waitForTimeout(100);
const tools = await page.evaluate(() => JSON.parse(localStorage.getItem('nib.tools') || '{}').state);
check(tools?.penSizes?.[1] === 3 && tools?.pen?.size === 3, `clicking the active size opens a slider that retunes that slot (${JSON.stringify(tools?.penSizes)})`);
await page.locator('.tool-pop.is-size input[type="range"]').fill('1.6');
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+e');
check((await page.locator(`${V} .tb-context button`).allTextContents()).join('|').includes('Whole stroke|Part|Highlighter only'), 'the eraser offers Whole stroke | Part and Highlighter only');
const eraserBar = () =>
  page.evaluate(() => {
    const bar = document.querySelector('.note-view:not(.is-hidden) .ink-toolbar');
    const edge = bar.closest('.note-scroll').getBoundingClientRect().right;
    const all = [...bar.querySelectorAll('.tb-tool, .tb-more, .tb-context > *')].every((el) => el.getBoundingClientRect().right <= edge);
    return { folded: bar.classList.contains('is-folded'), all, sw: bar.scrollWidth, cw: bar.clientWidth, sidebar: !document.querySelector('.sidebar.is-hidden') };
  });
await page.setViewportSize({ width: 1000, height: 760 });
await page.waitForTimeout(500);
const bar1000 = await eraserBar();
await page.locator(`${V} .tb-chip`).click();
await page.waitForTimeout(200);
const bar1000On = await eraserBar();
await page.locator(`${V} .tb-chip`).click();
check(
  bar1000.sidebar && !bar1000.folded && bar1000.all && !bar1000On.folded && bar1000On.sw === bar1000.sw,
  `at 1000×760 beside the sidebar the eraser's settings fit in the bar, Highlighter only on or off (${JSON.stringify(bar1000)})`,
);
// (960 is the narrowest the Mac app's window goes)
await page.setViewportSize({ width: 960, height: 760 });
await page.waitForTimeout(500);
const fit = await eraserBar();
check(fit.folded && fit.all && fit.sw <= fit.cw + 1, `in a narrower window the eraser's settings fold into one button and nothing is cut off (${JSON.stringify(fit)})`);
await page.locator(`${V} .tb-summary`).click();
check((await page.locator('.tool-pop.is-summary button:has-text("Part")').count()) === 1, 'the folded button opens the same settings');
await shot(page, 'ink-24-folded');
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(300);

// 16. Ask about an equation inside a quote; with the assistant open, one part of the page at a time.
await page.keyboard.press(`${MOD}+n`);
await page.waitForTimeout(400);
await page.keyboard.type('Equations');
await page.keyboard.press('Enter');
await page.keyboard.press('Alt+t');
await page.keyboard.type('A second line to ask about.');
await page.keyboard.press('Enter');
await page.keyboard.type('> Inside a quote');
await page.keyboard.press('Enter');
await page.keyboard.type('$$');
await page.keyboard.press('Space');
await page.waitForTimeout(300);
await page.keyboard.type('x^2+1');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const quoted = page.locator(`${V} .ProseMirror blockquote .math-block`).first();
const askEquation = async () => {
  await quoted.hover();
  await quoted.locator('.ink-more').click();
  await page.click('.ink-menu .menu-item:has-text("Ask about this")');
  await page.waitForTimeout(300);
};
await askEquation();
const eqBox = await quoted.boundingBox();
const eqAsk = await page.locator(`${V} .snip-ask`).boundingBox();
check(
  (await page.locator(`${V} .snip-ask input`).getAttribute('placeholder')) === 'Ask about this equation…' && eqAsk && eqAsk.y >= eqBox.y + eqBox.height - 2 && eqAsk.y < eqBox.y + eqBox.height + 40,
  'Ask about this… on an equation inside a quote opens the composer under it',
);
await page.keyboard.press('Escape');
// What is waiting in the assistant's composer (the store, as the dev server serves it).
const draftAtts = () =>
  page.evaluate(async () => {
    const { useAssistant } = await import('/src/state/assistant.ts');
    return Object.values(useAssistant.getState().drafts).flatMap((d) => d.attachments.map((a) => `${a.label}: ${a.text ?? ''}`));
  });
await page.keyboard.press(`${MOD}+j`);
await page.waitForSelector('.assistant');
await askEquation();
let atts = await draftAtts();
check(atts.length === 1 && atts[0] === 'Equation: $$x^2+1$$' && !(await page.locator(`${V} .snip-ask`).count()), `with the assistant open it goes into its composer as the equation (${JSON.stringify(atts)})`);
await page.locator(`${V} .tb-tool[data-tool="lasso"]`).click();
const boxOverLine = async (loc) => {
  const b = await loc.boundingBox();
  await page.mouse.move(b.x - 6, b.y + 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height + 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};
await boxOverLine(page.locator(`${V} .ProseMirror blockquote p`).first());
atts = await draftAtts();
check(atts.length === 1 && /^Text in that area: > Inside a quote/.test(atts[0]), `a box then replaces the equation in the composer (${JSON.stringify(atts)})`);
await boxOverLine(page.locator(`${V} .ProseMirror > p:has-text("second line")`).first());
atts = await draftAtts();
check(atts.length === 1 && atts[0] === 'Text in that area: A second line to ask about.', `and a second box replaces the first, with only the text it covers (${JSON.stringify(atts)})`);
await shot(page, 'ink-25-second-box');

// The chips carry the block they came from: asked from the panel, the answer is about the boxed paragraph and
// goes under it, not under the caret's block.
await page.keyboard.press('Alt+t');
await page.locator(`${V} .ProseMirror blockquote p`).first().click();
await page.locator(`${V} .tb-tool[data-tool="lasso"]`).click();
const second = page.locator(`${V} .ProseMirror > p:has-text("second line")`).first();
const secondId = await second.getAttribute('data-id');
await boxOverLine(second);
const chipAnchors = await page.evaluate(async () => {
  const { useAssistant } = await import('/src/state/assistant.ts');
  return Object.values(useAssistant.getState().drafts).flatMap((d) => d.attachments.map((a) => a.anchor ?? null));
});
check(!!secondId && chipAnchors.length === 1 && chipAnchors[0] === secondId, `the box's chip remembers the paragraph it came from, with the caret in the quote (${JSON.stringify(chipAnchors)})`);
await page.waitForSelector('[data-ai-status="online"]', { timeout: 15000 });
await page.locator('.assistant .composer-input').fill('Why is this here?');
await page.locator('.assistant .composer-input').press('Enter');
await page.waitForSelector('.assistant .msg.is-bot');
await page.waitForFunction(() => !document.querySelector('.msg.is-streaming, .msg-making'), null, { timeout: 20000 });
await page.waitForTimeout(200);
const askedAbout = await page.evaluate(async () => {
  const { useAssistant } = await import('/src/state/assistant.ts');
  const users = Object.values(useAssistant.getState().threads).flatMap((t) => t.messages).filter((m) => m.role === 'user');
  return users.at(-1)?.anchor ?? null;
});
check(askedAbout === secondId, 'sent from the panel, the question is about the boxed paragraph, not the caret’s block');
const reply = page.locator('.assistant .msg.is-bot').last();
await reply.hover();
await reply.locator('.msg-act:has-text("Insert into note")').click();
await page.waitForTimeout(300);
const underBoxed = await page.evaluate((id) => {
  const kids = [...document.querySelector('.note-view:not(.is-hidden) .ProseMirror').children];
  const i = kids.findIndex((e) => e.getAttribute('data-id') === id);
  return i >= 0 && !!kids[i + 1]?.matches('.callout[data-variant="ai"]');
}, secondId);
check(underBoxed, 'and Insert into note puts the answer right under that paragraph');
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);

// A box that catches ink leaves the keyboard with the ink (⌫, ⌘D and the arrows act on it), even from the composer.
await page.locator(`${V} .tb-tool[data-tool="pen"]`).click();
wrap = await wrapBox();
await writeText(page, 'ab', wrap.x + 60, wrap.y + R(9), 18);
await page.waitForTimeout(200);
await page.locator(`${V} .tb-tool[data-tool="lasso"]`).click();
await page.locator('.assistant .composer-input').fill('half a question');
const inkBefore = (await inkNow()).length;
await page.mouse.move(wrap.x + 40, wrap.y + R(9) - 30);
await page.mouse.down();
await page.mouse.move(wrap.x + 160, wrap.y + R(9) + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
atts = await draftAtts();
const inComposer = await page.evaluate(() => !!document.activeElement?.closest('.assistant'));
check(atts.some((a) => a.startsWith('Handwriting in that area')) && (await selCount()) > 0 && !inComposer, `the ink box goes into the composer, stays selected and keeps the keyboard (${JSON.stringify(atts)})`);
await page.keyboard.press('Backspace');
await page.waitForTimeout(300);
check(
  (await inkNow()).length < inkBefore - 1 && (await page.locator('.assistant .composer-input').inputValue()) === 'half a question',
  '⌫ then deletes the ink, and the question being typed is untouched',
);
await page.locator('.assistant .composer-input').fill('');
await page.keyboard.press(`${MOD}+j`);
await page.waitForFunction(() => !document.querySelector('.assistant'));

// 16b. Move to… from the ⋯ menu doesn't offer the classes' Homework folders (a plain note there would drop out of sight).
await page.locator(`${V} .tb-more`).click();
await page.click('.more-menu .menu-item:has-text("Move to")');
await page.waitForSelector('.folder-pick');
const targets = await page.locator('.folder-pick-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('title') ?? ''));
check(targets.includes('Calculus I') && !targets.some((t) => /(^|\/)Homework$/.test(t)), `Move to… lists the classes but none of their Homework folders (${targets.filter(Boolean).join(', ')})`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// 17. With the local model not running, the Ask composer says so and can't send; the selection's Ask is off.
const setAI = (patch) =>
  page.evaluate(async (p) => {
    const { useAI } = await import('/src/state/ai.ts');
    const was = useAI.getState().baseUrl;
    useAI.getState().set(p);
    return was;
  }, patch);
const aiUrl = await setAI({ baseUrl: 'http://127.0.0.1:59999' });
await page.waitForFunction(() => document.querySelector('[data-ai-status]')?.getAttribute('data-ai-status') === 'offline' || !document.querySelector('[data-ai-status]'), null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600);
await boxOverLine(page.locator(`${V} .ProseMirror > p:has-text("second line")`).first());
await page.locator(`${V} .snip-ask input`).fill('Why?');
check(
  /Local AI isn’t running/.test((await page.locator(`${V} .snip-ask .composer-status`).textContent()) ?? '') &&
    (await page.locator(`${V} .snip-ask .composer-status button:has-text("Open settings")`).count()) === 1 &&
    (await page.locator(`${V} .snip-send`).isDisabled()) &&
    (await page.locator(`${V} .snip-quick button:has-text("Explain")`).isDisabled()),
  'offline, the Ask composer says Local AI isn’t running (with Open settings), and Send and the four asks are off',
);
await shot(page, 'ink-26-offline-ask');
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+p');
wrap = await wrapBox();
await writeText(page, 'ab', wrap.x + 60, wrap.y + R(6), 18);
await page.waitForTimeout(200);
await page.keyboard.press('Alt+l');
await page.mouse.move(wrap.x + 40, wrap.y + R(6) - 30);
await page.mouse.down();
await page.mouse.move(wrap.x + 160, wrap.y + R(6) + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const selAsk = page.locator(`${V} .ink-sel-menu .sel-btn.is-ask`);
check((await selAsk.isDisabled()) && (await selAsk.getAttribute('title')) === 'Local AI isn’t running', 'and the selection menu’s Ask is off, saying why');
await setAI({ baseUrl: aiUrl });
await page.waitForTimeout(800);
check(!(await selAsk.isDisabled()), 'when the model is back, Ask is on again');
await page.keyboard.press('Escape');

// 18. Keys: ⌥P from a new note's title, Space under Select, ⌘Z away from the text, highlights, a note left empty.
const noteIds = () => page.evaluate(() => Object.keys(window.__nib.vault.getState().notes));
await page.keyboard.press(`${MOD}+n`);
await page.waitForFunction(() => document.activeElement?.classList.contains('page-title'));
await page.keyboard.press('Alt+p');
await page.waitForTimeout(150);
check(
  (await page.locator(`${V} .tb-tool[data-tool="pen"].is-active`).count()) === 1 &&
    (await page.locator(`${V} .page-title`).inputValue()) === '' &&
    !(await page.evaluate(() => document.activeElement?.classList.contains('page-title'))),
  '⌥P in a new note’s title picks up the marker and types nothing there',
);
wrap = await wrapBox();
const keyIds = await newIds(() => writeText(page, 'ab', wrap.x + 40, wrap.y + R(2), 18));
await page.keyboard.press('Alt+s');
await page.waitForTimeout(150);
const beforeKeys = JSON.stringify(await docJSON());
await page.keyboard.press('Space');
await page.keyboard.press('x');
await page.waitForTimeout(200);
check(
  JSON.stringify(await docJSON()) === beforeKeys && (await page.locator(`${V} .tb-tool[data-tool="lasso"].is-active`).count()) === 1,
  'under Select with nothing selected, Space and letters type nothing and Select stays',
);
// The handwriting's ⋯ takes the pointer on its button only: a Select box can start in the margin beside it.
const marginHits = await page.evaluate(() => {
  const block = document.querySelector('.note-view:not(.is-hidden) .ink-block-node')?.getBoundingClientRect();
  const btn = document.querySelector('.note-view:not(.is-hidden) .ink-block-node .ink-more')?.getBoundingClientRect();
  if (!block || !btn) return null;
  const at = (x, y) => !!document.elementFromPoint(x, y)?.closest('.ink-actions');
  return { beside: at(block.left - 4, block.top + 16), above: at(btn.left + 12, block.top + 1), button: at(btn.left + 12, btn.top + 12) };
});
check(
  marginHits && !marginHits.beside && !marginHits.above && marginHits.button,
  `around the handwriting's ⋯, only the button itself takes the pointer (${JSON.stringify(marginHits)})`,
);
const keyBox = await boxAround(keyIds);
await page.mouse.move(keyBox.x0, keyBox.y0);
await page.mouse.down();
await page.mouse.move(keyBox.x1, keyBox.y1, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const keyWas = byId(await inkNow()).get(keyIds[0]);
await drag([(keyBox.x0 + keyBox.x1) / 2, (keyBox.y0 + keyBox.y1) / 2], 160, 0);
const keyMoved = byId(await inkNow()).get(keyIds[0]);
await page.evaluate(() => document.activeElement?.blur?.());
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);
check(
  keyMoved.pts[0][0] > keyWas.pts[0][0] + 100 && Math.abs(byId(await inkNow()).get(keyIds[0]).pts[0][0] - keyWas.pts[0][0]) < 0.01,
  `${MOD}+Z with no field focused undoes moving the ink`,
);
await page.keyboard.press('Escape');

// 18b. Highlights alone are no writing: selected, they offer Ask but not Text or Math.
await page.keyboard.press('Alt+h');
await page.mouse.move(wrap.x + 40, wrap.y + R(5));
await page.mouse.down();
await page.mouse.move(wrap.x + 220, wrap.y + R(5), { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.keyboard.press('Alt+s');
await page.mouse.click(wrap.x + 130, wrap.y + R(5));
await page.waitForTimeout(250);
const hlMenu = await page.locator(`${V} .ink-sel-menu .sel-btn`).allTextContents();
check(
  (await selCount()) === 1 && hlMenu.some((t) => /Ask/.test(t)) && !hlMenu.some((t) => /^(Text|Math)$/.test(t.trim())),
  `a selected highlight offers no Text or Math (${hlMenu.map((t) => t.trim()).filter(Boolean).join(', ')})`,
);
await page.keyboard.press('Escape');

// 18c. ⌘Z on another page never reaches a note's text behind it.
const keyNote = await page.evaluate(() => window.__nib.ui.getState().view.id);
await page.keyboard.press('Alt+t');
await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
await page.keyboard.type('Extra words');
await page.waitForTimeout(600);
await showSidebar(page);
await page.click('.sidebar .nav-classes-label');
await page.waitForSelector('.classes-view');
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(700);
check(
  await page.evaluate((id) => JSON.stringify(window.__nib.vault.getState().notes[id]?.content).includes('Extra words'), keyNote),
  `${MOD}+Z on the Classes page leaves the note typed in before untouched`,
);
// …nor under a dialog, whether the note's text kept the focus or nothing has it.
await page.evaluate((id) => window.__nib.ui.getState().openNote(id), keyNote);
await page.waitForFunction((id) => window.__nib.ui.getState().view.id === id, keyNote);
await page.waitForTimeout(300);
await page.evaluate((V) => document.querySelector(`${V} .ProseMirror`).editor.chain().focus('end').run(), V);
await page.keyboard.type(' Keep these words');
await page.waitForTimeout(700);
const bodyText = () => page.evaluate((V) => document.querySelector(`${V} .ProseMirror`).textContent, V);
for (const blur of [false, true]) {
  if (blur) await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press(`${MOD}+,`);
  await page.waitForSelector('.modal-backdrop');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(250);
  check((await bodyText()).includes('Keep these words'), `${MOD}+Z under Settings leaves the note behind it alone (${blur ? 'nothing focused' : 'its text focused'})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-backdrop', { state: 'detached' });
}
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(250);
check(
  !(await bodyText()).includes('Keep these words') && (await bodyText()).includes('Extra words'),
  `…and with the dialog closed, ${MOD}+Z undoes that typing`,
);

// 18d. A ⌘N note left with nothing in it goes away, tab and all; one with something in it stays.
await page.keyboard.press(`${MOD}+n`);
await page.waitForSelector(`${V} .paper-strip`);
const emptyId = await page.evaluate(() => window.__nib.ui.getState().view.id);
await showSidebar(page);
await page.click('.sidebar .nav-classes-label');
await page.waitForSelector('.classes-view');
await page.waitForTimeout(300);
check(
  !(await noteIds()).includes(emptyId) &&
    !(await page.evaluate((id) => window.__nib.ui.getState().tabs.includes(id), emptyId)) &&
    (await noteIds()).includes(keyNote),
  'a ⌘N note left empty is gone, tab and all, and the one written in stays',
);

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED')).join('\n') || 'no page errors');
await browser.close();
