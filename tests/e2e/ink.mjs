// End-to-end test of the type ↔ handwriting flow, driven with real pointer
// events. Run against the dev server:  node tests/e2e/ink.mjs
import { launch, shot, BASE } from './lib.mjs';
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
await shot(page, 'ink-03-snapped');

// 6. Lasso the circle and move it right.
await page.keyboard.press('Alt+l');
await page.mouse.move(cx - 60, cy - 55);
await page.mouse.down();
for (const [x, y] of [
  [cx + 60, cy - 55],
  [cx + 60, cy + 55],
  [cx - 60, cy + 55],
  [cx - 60, cy - 55],
])
  await page.mouse.move(x, y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
check(await page.locator(`${V} .ink-sel-menu`).count(), 'lasso selection shows the action menu');
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
await page.locator(`${V} .tb-seg button:has-text("Precise")`).click();
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

// 11g. Arrow keys nudge (a burst is one undo step); ⌥↓ moves a whole line.
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
await page.keyboard.press(`${MOD}+z`);
await page.waitForTimeout(200);
now = byId(await inkNow());
check(Math.abs(now.get(eId).pts[0][0] - was.get(eId).pts[0][0]) < 0.01, `one ${MOD}+Z undoes the whole burst of nudges`);
await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(150);
now = byId(await inkNow());
check(Math.abs(now.get(eId).pts[0][1] - was.get(eId).pts[0][1] - 32) < 0.01, '⌥↓ moves it down exactly one ruled line');

// 11h. ⌘-drag with the pen picks ink up instead of drawing.
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

// 11i. Dragging to the top edge scrolls the page, and the drop still lands under the pointer.
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
await page.mouse.up();
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
  !!f1 && Math.abs(f1.pts[0][1] - f0.pts[0][1] - wantDy) <= 8 && Math.abs(f1.pts[0][0] - f0.pts[0][0] - 20) < 0.6,
  `after scrolling, the word lands under the pointer (moved ${f1 ? (f1.pts[0][1] - f0.pts[0][1]).toFixed(1) : '?'}, pointer moved ${wantDy.toFixed(1)})`,
);
check(!!f1 && farIds.every((id) => now.get(id)?.block === f1.block), 'and arrives whole, in one block');
await shot(page, 'ink-14-autoscrolled');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED')).join('\n') || 'no page errors');
await browser.close();
