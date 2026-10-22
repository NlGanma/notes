// End-to-end test of the type ↔ handwriting flow, driven with real pointer
// events. Run against the dev server:  node tests/e2e/ink.mjs
import { launch, shot, BASE } from './lib.mjs';
import { writeText } from './hand.mjs';

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
await page.mouse.click(pb.x + pb.width - 2, pb.y + 16);
await page.keyboard.press('End');
await page.keyboard.type(' Result');
await page.keyboard.press('Alt+p');
const endX = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  const $p = ed.state.doc.resolve(2);
  return ed.view.coordsAtPos($p.end()).right;
});
// a hand-drawn arrow right after "Result"
const ax = endX + 10;
const ay = pb.y + 14;
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
check((JSON.stringify(doc).match(/inkInline/g) ?? []).length >= 2, 'inline sketch inserted at the caret');
await shot(page, 'ink-09-final');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED')).join('\n') || 'no page errors');
await browser.close();
