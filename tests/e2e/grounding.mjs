// End-to-end test of the notes-only policy against scripts/mock-llm.mjs:
// every answer comes from the notes, and anything that doesn't is said plainly
// and boxed as the AI's own knowledge ("proceed with caution").
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/grounding.mjs
import { launch, shot, BASE, openClassNote } from './lib.mjs';

const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:11434';
const { browser, page, errors } = await launch({ width: 1440, height: 940 });
const V = '.note-view:not(.is-hidden)';
const check = (cond, msg) => {
  console.log(cond ? 'ok  ' : 'FAIL', msg);
  if (!cond) process.exitCode = 1;
};
const waitIdle = async () => {
  await page.waitForFunction(() => !document.querySelector('.msg.is-streaming, .msg-making'), null, { timeout: 25000 });
  await page.waitForTimeout(250);
};
const stats = () => fetch(`${MOCK}/__mock`).then((r) => r.json()).then((j) => j.stats);
/** Waits until the model has been called `n` more times than in `since` (a busy machine starts requests late), then for the reply. */
const waitCalls = async (since, n) => {
  for (let i = 0; i < 80 && (await stats()).chat < since.chat + n; i++) await page.waitForTimeout(250);
  await waitIdle();
};
const bot = () => page.locator('.assistant .msg.is-bot').last();
const ask = async (text) => {
  await page.fill('.assistant .composer textarea', text);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.assistant .msg.is-bot');
  await waitIdle();
};

await page.goto(BASE);
await page.waitForSelector('.ai-status.is-online', { timeout: 15000 });

// ---------------------------------------------------------------- per-note: covered
await openClassNote(page, 'Calculus I', 'Lecture 4');
await page.waitForSelector(`${V} .ProseMirror`);
await page.keyboard.press('Meta+j').catch(() => undefined);
if (!(await page.locator('.assistant').count())) await page.click('.top-btn:has-text("Assistant"), .top-btn[title^="Assistant"]').catch(() => undefined);
await page.waitForSelector('.assistant .composer textarea');
await ask('What does my note say about the squeeze theorem?');
check(await bot().locator('.md .cite').count(), 'a question about the open note is answered from it, with citations');
check(!(await bot().locator('.outside-notes').count()), '…and nothing is boxed when the note covers it');
check(await bot().locator('.grounding-item.is-cited').count(), '…and the check counts statements backed by the note');
check(/Lecture 4/.test((await bot().locator('.sources').textContent().catch(() => '')) ?? ''), '…and the note is listed as the source');

// ---------------------------------------------------------------- per-note: not covered
let before = await stats();
await ask('What is the capital of Peru?');
let after = await stats();
const banner = (await bot().locator('.coverage-banner').textContent().catch(() => '')) ?? '';
check(/notes don.t cover this/i.test(banner) && /proceed with caution/i.test(banner), 'an off-topic question says the notes don’t cover it and to proceed with caution');
const head = (await bot().locator('.outside-notes .outside-head').first().textContent().catch(() => '')) ?? '';
check(/AI.s own knowledge/.test(head) && /proceed with caution/.test(head), '…and the answer is boxed as the AI’s own knowledge');
check(/Lima/.test(await bot().locator('.outside-notes').textContent().catch(() => '')), '…with the general-knowledge answer inside the box');
check(!(await bot().locator('.outside-notes .cite').count()), '…and no citations inside the box');
const kinds = after.kinds.slice(before.kinds.length);
check(kinds.length === 1 && kinds[0] === 'general', `the coverage check ran first: no notes prompt was sent (${kinds.join(', ')})`);
await shot(page, 'grounding-01-not-covered');

// Search my notes anyway: the notes prompt runs; the model says what isn't there.
before = await stats();
await bot().locator('.coverage-force').click();
await waitCalls(before, 2);
after = await stats();
check(after.kinds.slice(before.kinds.length).join(',') === 'note,general', '“Search my notes anyway” asks the notes first, then answers the rest separately');
check(/notes don.t cover this/i.test((await bot().locator('.coverage-banner').textContent().catch(() => '')) ?? ''), '…and still labels it');
check(!/NOT IN NOTES/.test(await bot().textContent()), '…without showing the model’s raw “NOT IN NOTES” line');

// ---------------------------------------------------------------- per-note: containment
await ask('How do I use the squeeze theorem with the power rule?');
const auto = (await bot().locator('.outside-notes.is-auto').textContent().catch(() => '')) ?? '';
check(/power rule/i.test(auto), 'a cited sentence the note doesn’t back is moved into a “not found in your notes” box');
check(/Not found in your notes/.test(auto) && /proceed with caution/.test(auto), '…labelled by the app');
const outsideText = await bot()
  .locator('.md')
  .evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.outside-notes').forEach((b) => b.remove());
    return c.textContent;
  });
check(!/power rule/i.test(outsideText), '…and is no longer shown as coming from the notes');
check(/not found in your notes/i.test(await bot().locator('.grounding').textContent()), '…and the check bar says so');
await shot(page, 'grounding-02-contained');

// History hygiene: the model never gets its unverified text back as fact.
await ask('And what about continuity?');
const last = (await stats()).last;
const hist = last
  .filter((m) => m.role === 'assistant')
  .map((m) => m.content)
  .join('\n');
check(!/power rule|Lima/i.test(hist), 'earlier unverified or general-knowledge text is not sent back to the model');
check(!/\[\d+\]/.test(hist), '…nor are old citation numbers');

// Inserting keeps the marking.
await bot().hover();
await page.click('.assistant .msg.is-bot >> nth=-3 >> .msg-act:has-text("Insert into note")').catch(() => undefined);

// ---------------------------------------------------------------- Ask your notes
await page.click('.nav-item:has-text("Ask your notes")');
await page.waitForSelector('.library');
await page.click('.library button[title="New conversation"]').catch(() => undefined);
const libBot = () => page.locator('.library .msg.is-bot').last();
const libAsk = async (q) => {
  await page.fill('.library-composer textarea', q);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.library .msg.is-bot');
  await waitIdle();
};
await libAsk('What is the squeeze theorem and who discovered it?');
check(/Archimedes/.test(await libBot().locator('.outside-notes.is-auto').textContent().catch(() => '')), 'library: an invented fact with a citation is caught and boxed');
check(await libBot().locator('.md > p .cite, .md > ul .cite').count(), '…while the part from the notes keeps its citations');
check(/Not in your notes: who discovered it/i.test(await libBot().locator('.coverage-banner').textContent().catch(() => '')), '…and what the notes lack is named');
check((await libBot().locator('.outside-notes').count()) >= 2, '…and answered separately in its own labelled box');
await shot(page, 'grounding-03-library');

// "Never use the AI's own knowledge": say so, make no model call.
await page.click('.library .strict-toggle');
before = await stats();
await libAsk('Who painted the Mona Lisa?');
after = await stats();
check(/answer only from your notes/i.test(await libBot().locator('.coverage-banner').textContent().catch(() => '')), 'with own knowledge off, it only says the notes don’t cover it');
check(!(await libBot().locator('.outside-notes').count()), '…shows no own-knowledge answer');
check(after.chat === before.chat, '…and makes no model call at all');
await page.click('.library .strict-toggle');

// ---------------------------------------------------------------- partly covered
await openClassNote(page, 'Spanish II', 'Pretérito');
await page.waitForSelector(`${V} .ProseMirror`);
before = await stats();
await ask('How do you conjugate tener in the preterite?');
after = await stats();
check(await bot().locator('.md > p .cite').count(), 'partly covered: what the notes have is answered with citations');
check(/Not in your notes: .*tener/i.test(await bot().locator('.coverage-banner').textContent().catch(() => '')), '…what they lack is named');
check(/AI.s own knowledge/.test(await bot().locator('.outside-notes').last().textContent().catch(() => '')), '…and answered separately, boxed');
check(after.kinds.slice(before.kinds.length).join(',') === 'note,general', `…in two calls: the notes, then general knowledge (${after.kinds.slice(before.kinds.length).join(', ')})`);
await shot(page, 'grounding-05-partial');

// ---------------------------------------------------------------- text actions
const para = page.locator(`${V} .ProseMirror p:has-text("completed actions")`);
await para.scrollIntoViewIfNeeded();
const pb = await para.boundingBox();
await page.locator(`${V} .tb-tool[data-tool="text"]`).click();
await page.mouse.click(pb.x + 4, pb.y + 10);
await page.mouse.down();
await page.mouse.move(pb.x + 380, pb.y + 12, { steps: 8 });
await page.mouse.up();
await page.waitForSelector('.bubble');
await page.click('.bubble .bub-btn.is-ai');
await page.click('.bubble-panel .menu-item:has-text("example")');
await page.waitForSelector('.assistant .msg.is-bot');
await waitIdle();
check(/paella/i.test(await bot().locator('.md').textContent()) && (await bot().locator('.md .cite').count()), '“Give an example” uses the example in the notes, cited');
await shot(page, 'grounding-04-example');

// No example in the notes: decided in code, no notes prompt; a labelled example from general knowledge.
await openClassNote(page, 'Biology', 'Cell Structure');
await page.waitForSelector(`${V} .ProseMirror`);
const li = page.locator(`${V} .ProseMirror li:has-text("Golgi apparatus")`);
await li.scrollIntoViewIfNeeded();
const lb = await li.boundingBox();
await page.mouse.click(lb.x + 30, lb.y + 10);
await page.mouse.down();
await page.mouse.move(lb.x + 330, lb.y + 12, { steps: 8 });
await page.mouse.up();
await page.waitForSelector('.bubble');
await page.click('.bubble .bub-btn.is-ai');
before = await stats();
await page.click('.bubble-panel .menu-item:has-text("example")');
await waitCalls(before, 1);
after = await stats();
check(/don.t include an example/i.test(await bot().locator('.coverage-banner').textContent().catch(() => '')), 'no example in the notes: Nib says so');
check(await bot().locator('.outside-notes').count(), '…and the example it gives is boxed as the AI’s own knowledge');
check(after.kinds.slice(before.kinds.length).join(',') === 'general', '…without sending a notes prompt');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.join('\n') || 'no page errors');
await browser.close();
