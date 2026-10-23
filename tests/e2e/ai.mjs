// End-to-end test of the local-AI features against scripts/mock-llm.mjs.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/ai.mjs
import { launch, shot, BASE, openClassNote, noteMenuItem } from './lib.mjs';

const { browser, page, errors } = await launch({ width: 1440, height: 940 });
const V = '.note-view:not(.is-hidden)';
const check = (cond, msg) => {
  console.log(cond ? 'ok  ' : 'FAIL', msg);
  if (!cond) process.exitCode = 1;
};
const waitIdle = async () => {
  await page.waitForFunction(() => !document.querySelector('.msg.is-streaming, .msg-making'), null, { timeout: 20000 });
  await page.waitForTimeout(200);
};

await page.goto(BASE);
await page.waitForSelector('[data-ai-status="online"]', { timeout: 15000 });
const status = await page.getAttribute('[data-ai-status]', 'title');
check(/qwen2\.5vl/.test(status), `connected to the local model server, chose a vision model (${status.trim()})`);

// 1. Tutor on the handwritten worked example.
await openClassNote(page, 'Calculus I', 'Lecture 4');
await page.waitForTimeout(800);
const inkBlock = page.locator(`${V} .ink-block-node`).first();
await inkBlock.scrollIntoViewIfNeeded();
await inkBlock.hover();
await inkBlock.locator('.ink-more').first().click();
await page.click('.ink-menu .menu-item:has-text("Tutor me through it")');
await page.waitForSelector('.assistant .msg.is-bot');
await waitIdle();
const tutor = await page.textContent('.assistant .msg.is-bot .md');
check(/Hint/.test(tutor) && !/boxed/.test(tutor), 'tutor gives a hint, not the answer');
check(await page.locator('.assistant .msg-att-img').count(), 'the handwriting was attached as an image');
check(await page.locator('.assistant .katex').count(), 'math in the reply is typeset');
await shot(page, 'ai-01-tutor');

// 2. Follow-up chip: check my work.
await page.click('.followup:has-text("Check my work")');
await waitIdle();
check(/Verdict/.test(await page.locator('.assistant .msg.is-bot').last().textContent()), '"Check my work" follow-up works');

// 3. Insert the reply into the note as an assistant callout.
await page.locator('.assistant .msg.is-bot').last().hover();
await page.locator('.assistant .msg.is-bot').last().locator('.msg-act:has-text("Insert into note")').click();
await page.waitForTimeout(300);
check(await page.locator(`${V} .callout[data-variant="ai"]`).count(), 'reply inserted into the note as an assistant callout');
await shot(page, 'ai-02-inserted');

// 3b. With the assistant open, a window narrowed until the page would be under 760px puts the sidebar away,
// and widening it again brings the sidebar back.
const sidebarShown = () => page.evaluate(() => !document.querySelector('.sidebar.is-hidden'));
const mainWidth = () => page.evaluate(() => Math.round(document.querySelector('.main').getBoundingClientRect().width));
const shownBefore = await sidebarShown();
await page.setViewportSize({ width: 1100, height: 940 });
await page.waitForTimeout(400);
check(shownBefore && !(await sidebarShown()) && (await mainWidth()) >= 700, `narrowing the window beside the assistant puts the sidebar away (page ${await mainWidth()}px)`);
await page.setViewportSize({ width: 1440, height: 940 });
await page.waitForTimeout(400);
check(await sidebarShown(), '…and widening it brings the sidebar back');

// 4. Snip & ask: drag over the squeeze-theorem area.
await page.locator(`${V} .tb-tool[data-tool="ask"]`).click();
const heading = page.locator(`${V} .ProseMirror h2:has-text("Squeeze theorem")`);
await heading.scrollIntoViewIfNeeded();
const hb = await heading.boundingBox();
await page.mouse.move(hb.x - 10, hb.y - 6);
await page.mouse.down();
await page.mouse.move(hb.x + 640, hb.y + 150, { steps: 10 });
await page.mouse.up();
await page.waitForSelector(`${V} .snip-ask`);
await shot(page, 'ai-03-snip');
await page.click(`${V} .snip-quick button:has-text("Explain")`);
await page.waitForTimeout(300);
await waitIdle();
const lastUser = page.locator('.assistant .msg.is-user').last();
check((await lastUser.locator('.msg-att-chip, .msg-att-img').count()) > 0, 'the snipped area (text + ink) was attached');
await shot(page, 'ai-04-snip-answer');

// 5. Text selection → Ask AI.
await page.locator(`${V} .tb-tool[data-tool="text"]`).click();
const para = page.locator(`${V} .ProseMirror p:has-text("The professor said")`);
await para.scrollIntoViewIfNeeded();
const pb = await para.boundingBox();
await page.mouse.click(pb.x + 4, pb.y + 10);
await page.mouse.down();
await page.mouse.move(pb.x + 420, pb.y + 12, { steps: 8 });
await page.mouse.up();
await page.waitForSelector('.bubble');
await page.click('.bubble .bub-btn.is-ai');
await shot(page, 'ai-05-bubble');
await page.click('.bubble-panel .menu-item:has-text("Explain this")');
await waitIdle();
check(/Selected text/.test(await page.locator('.assistant .msg.is-user').last().textContent()), 'selected text attached to the question');

// 6. Ask your notes: grounded answer with citations.
await page.click('.nav-item:has-text("Ask your notes")');
await page.waitForSelector('.library');
await page.fill('.library-composer textarea', 'What is the squeeze theorem?');
await page.keyboard.press('Enter');
await page.waitForSelector('.library .msg.is-bot .cite');
await waitIdle();
const answer = await page.textContent('.library .msg.is-bot .md');
check(/squeeze|squeezed|g\(x\)/i.test(answer), 'library answer drawn from the calculus note');
check(await page.locator('.library .sources .source').count(), 'sources listed under the answer');
const chips = (await page.locator('.library .lib-dock .study-tool').allTextContents()).map((t) => t.trim()).join(' · ');
check(chips === 'Summarize · Study guide · Key terms · Flashcards · Quiz me', `the study tools stay under the composer during a conversation (${chips})`);
// The docked composer grows with what's typed (up to a cap), so a long question stays readable.
const box = page.locator('.library-composer textarea');
await box.click();
for (let i = 1; i <= 5; i++) {
  await page.keyboard.type(`line ${i} of a long question`);
  if (i < 5) await page.keyboard.press('Shift+Enter');
}
const grown = await box.evaluate((el) => ({ box: el.clientHeight, text: el.scrollHeight }));
check(grown.box > 120 && grown.text - grown.box < 4, `the docked composer grows to fit five lines (${grown.box}px for ${grown.text}px of text)`);
await box.fill('');
await page.locator('.library .msg.is-bot .cite').first().click();
await page.waitForSelector('.cite-preview');
await shot(page, 'ai-06-library-cited');
await page.click('.cite-preview .btn');
await page.waitForTimeout(900);
check(await page.locator(`${V} .nib-flash-box`).count(), 'citation opened the note and highlighted the source block');
await shot(page, 'ai-07-citation-jump');

// 7. Study tools: flashcards and quiz, each opening beside the conversation.
await page.click('.nav-item:has-text("Ask your notes")');
await page.click('.library button[title="New conversation"]');
check(/What do you want to know/.test(await page.textContent('.library')), 'a new conversation starts from the greeting');
await page.click('.study-tool:has-text("Flashcards")');
await page.waitForSelector('.lib-artifact .flashcards', { timeout: 20000 });
check(/Make flashcards/.test(await page.locator('.library .msg.is-user').last().textContent()), 'the request reads as the student’s own words');
check(await page.locator('.library .art-card.is-open').count(), '…and its card in the conversation shows it open');
await page.click('.fc-card');
await page.waitForTimeout(500);
await shot(page, 'ai-08-flashcards');
await page.click('.library button[title="New conversation"]');
check(!(await page.locator('.lib-artifact').count()), 'a new conversation closes the open output');
await page.fill('.library-composer textarea', 'limits');
await page.click('.study-tool:has-text("Quiz")');
await page.waitForSelector('.quiz', { timeout: 20000 });
check(/Quiz me on limits/.test(await page.locator('.library .msg.is-user').last().textContent()), 'text in the box becomes the study tool’s topic');
check((await page.inputValue('.library-composer textarea')) === '', '…and the box clears');
await page.locator('.quiz-choice').nth(1).click();
check(await page.locator('.quiz-choice.is-right').count(), 'quiz marks answers');
await shot(page, 'ai-09-quiz');

// History: earlier conversations come back, and the one they replace goes into History.
await page.click('.library button[title="History"]');
const earlier = await page.locator('.history-menu .menu-item').allTextContents();
check(earlier.some((t) => /squeeze theorem/i.test(t)) && earlier.some((t) => /Flashcards/.test(t)), `History lists the earlier conversations (${earlier.length})`);
await page.click('.history-menu .menu-item:has-text("Flashcards")');
check(await page.locator('.library .art-card').count(), '…and opens one again, its flashcards with it');
await page.click('.library button[title="History"]');
check(await page.locator('.history-menu .menu-item:has-text("Quiz me: limits")').count(), '…while the quiz moves into History');

// Deleting: an earlier conversation from History (with Undo), and the one on the page from its title.
const pastCount = await page.locator('.history-menu .history-row').count();
const quizRow = page.locator('.history-menu .history-row:has-text("Quiz me: limits")');
await quizRow.hover();
await quizRow.locator('.history-delete').click();
check((await page.locator('.history-menu .history-row').count()) === pastCount - 1, 'an earlier conversation can be deleted from History');
await page.click('.toast-action:has-text("Undo")');
await page.click('.library button[title="History"]').catch(() => undefined);
await page.waitForSelector('.history-menu');
check(await page.locator('.history-menu .menu-item:has-text("Quiz me: limits")').count(), '…and Undo brings it back');
await page.keyboard.press('Escape');
await page.click('.library .lib-head-conv');
await page.click('.menu-item:has-text("Delete conversation")');
check(/What do you want to know/.test(await page.textContent('.library')), 'deleting the conversation on the page goes back to the greeting');
await page.click('.toast-action:has-text("Undo")');
check(await page.locator('.library .art-card').count(), '…and Undo brings it back');

// 8. Polish → read handwriting in the background-transcription path.
await page.click('.tab:has-text("Lecture 4")');
await page.waitForTimeout(500);
await noteMenuItem(page, 'Polish');
await page.waitForSelector('.polish');
await shot(page, 'ai-10-polish');
const read = page.locator('.polish-row:has-text("searchable") button');
if (await read.count()) {
  await read.click();
  await page.waitForTimeout(1500);
}
await page.keyboard.press('Escape');
const transcript = await page.evaluate(() => {
  const ed = document.querySelector('.note-view:not(.is-hidden) .ProseMirror').editor;
  let t = null;
  ed.state.doc.forEach((n) => {
    if (n.type.name === 'inkBlock' && n.attrs.transcript) t = n.attrs.transcript;
  });
  return t;
});
check(transcript && /lim/.test(transcript.text), 'handwriting was read by the vision model and stored as a transcript');

// 8b. Apply all tidies the note but never files it in a class (that's its own button, and moves the file).
const loose = await page.evaluate(() => {
  const p = (t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
  const content = {
    type: 'doc',
    content: [
      p('Limits and continuity: the squeeze theorem says if g(x) ≤ f(x) ≤ h(x) and lim g = lim h = L then lim f = L.'),
      p(''),
      p(''),
      p(''),
      p('The intermediate value theorem: a continuous function on [a, b] takes every value between f(a) and f(b).'),
      p('- first typed bullet about limits'),
      p('- second typed bullet about continuity'),
    ],
  };
  const doc = window.__nib.vault.getState().createNote({ folder: '', title: 'Limits review', content });
  window.__nib.ui.getState().openNote(doc.meta.id);
  return doc.meta.id;
});
await page.waitForSelector(`${V} .page-title`);
await page.waitForTimeout(600);
await noteMenuItem(page, 'Polish');
await page.waitForSelector('.polish');
const classGroup = page.locator('.polish-group:has(.polish-group-label:text-is("Class"))');
check(await classGroup.locator('.polish-row:has-text("Move to Calculus I")').count(), 'Polish offers filing the loose note, in a group of its own');
check(!(await page.locator('.polish-group:has(.polish-all) .polish-row:has-text("Move to")').count()), '…not among the quick fixes Apply all runs');
await page.click('.polish-all');
await page.waitForTimeout(1200);
const after = await page.evaluate((id) => window.__nib.vault.getState().notes[id].meta.folder, loose);
check(after === '' && !(await page.locator(`${V} .crumb.is-class`).count()), `Apply all leaves the note where it was (folder ${JSON.stringify(after)})`);
await page.keyboard.press('Escape');

// 9. Settings shows the detected models.
await page.click('.side-settings');
await page.click('.settings-nav-item:has-text("Local AI")');
await page.waitForSelector('.status-card.is-online');
check(/qwen2\.5vl/.test(await page.textContent('.status-card')), 'Settings names the models in use');
await shot(page, 'ai-11-settings');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.join('\n') || 'no page errors');

// 10. No model server: the composer says so, Send waits, and Open settings goes to Local AI.
// (Requests are cut in this browser only; the shared mock server is untouched.)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const off = await ctx.newPage();
  await off.route('**/api/**', (r) => r.abort());
  await off.goto(BASE);
  await off.waitForSelector('[data-ai-status="offline"]', { timeout: 15000 });
  await off.click('.nav-item:has-text("Ask your notes")');
  await off.waitForSelector('.library .composer-status.is-offline');
  await off.fill('.library-composer textarea', 'What is a limit?');
  check(await off.locator('.library-composer .send-btn').isDisabled(), 'offline: the composer says the local AI isn’t running, and Send waits');
  check(await off.locator('.study-tool').first().isDisabled(), '…and so do the study chips');
  await off.click('.composer-status-link');
  await off.waitForSelector('.settings-nav-item.is-active:has-text("Local AI")');
  check(true, '…and Open settings goes to Local AI');
  await ctx.close();
}

// 11. While the model server is still being found, a question waits for it instead of failing.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const slow = await ctx.newPage();
  let release;
  const held = new Promise((r) => (release = r));
  await slow.route('**/api/tags', async (r) => {
    await held;
    await r.continue();
  });
  await slow.goto(BASE);
  await slow.click('.nav-item:has-text("Ask your notes")');
  await slow.waitForSelector('.library .composer-status.is-loading');
  await slow.fill('.library-composer textarea', 'What is the squeeze theorem?');
  await slow.keyboard.press('Enter');
  await slow.waitForSelector('.library .msg.is-bot');
  await slow.waitForTimeout(1500);
  const waiting = await slow.evaluate(() => ({
    error: document.querySelector('.library .msg-error')?.textContent ?? '',
    streaming: !!document.querySelector('.library .msg.is-bot.is-streaming'),
    stop: !!document.querySelector('.library .send-btn.is-stop'),
  }));
  check(!waiting.error && waiting.streaming && waiting.stop, `loading: a question waits for the model, with Stop, and no error (${waiting.error || 'none'})`);
  release();
  await slow.waitForSelector('.library .msg.is-bot .cite', { timeout: 20000 });
  check(!(await slow.locator('.library .msg-error').count()), '…and is answered once the model is there');
  await ctx.close();
}
await browser.close();
