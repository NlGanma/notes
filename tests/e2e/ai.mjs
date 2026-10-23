// End-to-end test of the local-AI features against scripts/mock-llm.mjs.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/ai.mjs
import { launch, shot, BASE, openClassNote, noteMenuItem, showSidebar } from './lib.mjs';

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
check((await page.locator('.ink-menu .menu-item:has-text("Ask about this")').count()) === 1 && !(await page.locator('.ink-menu .menu-item:has-text("Tutor")').count()), 'the handwriting menu has one Ask about this…');
await page.click('.ink-menu .menu-item:has-text("Ask about this")');
await page.waitForSelector(`${V} .snip-ask`);
check((await page.locator(`${V} .snip-quick button`).allTextContents()).join('·').includes('Explain·Hint·Check my work·Solve it'), 'it opens the Ask composer with Explain · Hint · Check my work · Solve it');
await page.click(`${V} .snip-quick button:has-text("Hint")`);
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

// 4. Select a box over the Squeeze theorem heading and the ink beside it. The assistant is open, so Ask puts
// the area in its composer instead of opening a second composer on the page.
const composerAtts = '.assistant .composer-atts .att';
await page.locator(`${V} .tb-tool[data-tool="lasso"]`).click();
const heading = page.locator(`${V} .ProseMirror h2:has-text("Squeeze theorem")`);
await heading.scrollIntoViewIfNeeded();
const boxOver = async () => {
  const hb = await heading.boundingBox();
  await page.mouse.move(hb.x - 10, hb.y - 6);
  await page.mouse.down();
  await page.mouse.move(hb.x + 640, hb.y + 150, { steps: 10 });
  await page.mouse.up();
};
await boxOver();
await page.waitForSelector(composerAtts);
await page.waitForTimeout(200);
check(
  (await page.locator(`${V} .ink-sel-menu`).count()) === 1 && !(await page.locator(`${V} .snip-ask`).count()),
  'with the assistant open, letting go of the box puts the area in its composer; the ink it caught stays selected',
);
check((await page.locator(`${composerAtts} img`).count()) > 0, 'the area went into the assistant’s composer as a picture');
check(/Text in that area/.test((await page.locator(composerAtts).allTextContents()).join(' ')), '…with the typed text inside the box');
await shot(page, 'ai-03-snip');
const attsBefore = await page.locator(composerAtts).count();
await page.click(`${V} .ink-sel-menu .sel-btn:has-text("Ask")`);
await page.waitForTimeout(400);
check(
  (await page.locator(composerAtts).count()) === attsBefore && !(await page.locator(`${V} .snip-ask`).count()),
  'Ask on the selection uses that composer too, without a second picture or a composer on the page',
);
await page.locator('.assistant textarea').fill('What does this say?');
await page.locator('.assistant textarea').press('Enter');
await waitIdle();
check((await page.locator('.assistant .msg.is-user').last().locator('.msg-att-chip, .msg-att-img').count()) > 0, 'sending it asks about that area');
const worked = page.locator(`${V} .ink-block-node`).first();
await worked.scrollIntoViewIfNeeded();
await worked.hover();
await worked.locator('.ink-more').first().click();
await page.click('.ink-menu .menu-item:has-text("Ask about this")');
await page.waitForTimeout(300);
check(
  !(await page.locator(`${V} .snip-ask`).count()) && /Handwriting/.test((await page.locator(composerAtts).allTextContents()).join(' ')),
  'with the assistant open, a handwriting area’s Ask about this… goes into its composer too',
);

// 4b. With the assistant closed, the same box's Ask opens the composer on the page; Explain asks at once.
await page.click('.top-btn:has-text("Assistant"), .top-btn[title^="Assistant"]');
await page.waitForFunction(() => !document.querySelector('.assistant'));
await page.locator(`${V} .tb-tool[data-tool="lasso"]`).click();
await boxOver();
await page.click(`${V} .ink-sel-menu .sel-btn:has-text("Ask")`);
await page.waitForSelector(`${V} .snip-ask`);
await page.click(`${V} .snip-quick button:has-text("Explain")`);
await page.waitForSelector('.assistant .msg.is-user');
await page.waitForTimeout(300);
await waitIdle();
const lastUser = page.locator('.assistant .msg.is-user').last();
check((await lastUser.locator('.msg-att-img').count()) > 0, 'the selected area (picture + text) was attached');
check(!(await page.locator(`${V} .snip-ask`).count()), 'and the composer on the page closed');
await shot(page, 'ai-04-snip-answer');

// 4c. Read handwriting: what was read then opens from the handwriting's ⋯, over it, and Esc puts it away.
await page.locator(`${V} .tb-tool[data-tool="text"]`).click();
const readBlock = page.locator(`${V} .ink-block-node`).first();
const inkMenu = async (item) => {
  await readBlock.scrollIntoViewIfNeeded();
  await readBlock.hover();
  await readBlock.locator('.ink-more').first().click();
  await page.click(`.ink-menu .menu-item:has-text("${item}")`);
};
await inkMenu('Read handwriting');
await page.waitForSelector('.toast:has-text("Handwriting read")', { timeout: 20000 });
const readToast = (await page.textContent('.toast:has-text("Handwriting read")')).replace(/\s+/g, ' ').trim();
check(/^Handwriting read\s*\S/.test(readToast) && !/[$\\]/.test(readToast), `the toast says what was read, its math written out (${readToast})`);
await inkMenu('Show what was read');
await page.waitForSelector('.popover.ink-transcript');
check(/^What was read/.test(await page.textContent('.popover.ink-transcript')), 'what was read opens from the handwriting’s ⋯');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(!(await page.locator('.popover.ink-transcript').count()), '…and Esc puts it away');

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
// Retry makes the cards again, and they open when they're done, as the first ones did.
await page.locator('.library .lib-tool-turn .msg-act[title="Retry"]').last().click();
const closedForRetry = !(await page.locator('.lib-artifact').count());
await page.waitForTimeout(300);
await waitIdle();
await page.waitForSelector('.lib-artifact .flashcards', { timeout: 20000 });
check(closedForRetry && (await page.locator('.library .art-card.is-open').count()) === 1, 'Retry on a study card makes it again and opens the new cards when they’re done');
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

// 7b. Every way into Ask your notes comes back to the live conversation, on the notes it was asking about.
{
  const state = () =>
    page.evaluate(() => ({
      chip: document.querySelector('.library .scope-chip-label')?.textContent ?? '',
      head: document.querySelector('.library .library-title h1')?.textContent ?? '',
      asked: document.querySelector('.library .msg.is-user .msg-bubble')?.textContent ?? '',
    }));
  await page.click('.library button[title="New conversation"]');
  await page.click('.library .scope-chip');
  await page.click('.scope-menu .menu-item:has-text("Calculus I")');
  await page.fill('.library-composer textarea', 'What is a limit?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.library .msg.is-bot');
  await waitIdle();
  await page.click('.tab:has-text("Lecture 4")');
  await showSidebar(page);
  await page.click('.nav-item:has-text("Ask your notes")');
  await page.waitForSelector('.library');
  const side = await state();
  check(side.chip === 'Calculus I' && side.head === 'Calculus I' && side.asked === 'What is a limit?', `the sidebar's Ask your notes returns to the conversation, still on its class (${JSON.stringify(side)})`);
  await page.click('.tab:has-text("Lecture 4")');
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('.palette');
  await page.keyboard.type('Ask your notes');
  await page.click('.palette-item:has(.palette-label:text-is("Ask your notes"))');
  await page.waitForSelector('.library');
  const pal = await state();
  check(pal.chip === 'Calculus I' && pal.asked === 'What is a limit?', `…and so does the palette's (${JSON.stringify(pal)})`);

  // A study tool with nothing in the notes to make it from says so in the conversation; it isn't an output.
  await page.fill('.library-composer textarea', 'zebra migration across the Serengeti');
  await page.click('.study-tool:has-text("Summarize")');
  await page.waitForTimeout(300);
  await waitIdle();
  const refusal = await page.locator('.library .msg.is-bot').last().textContent();
  check(/isn.t enough in these notes/.test(refusal), `a study tool the notes can't support says so (${refusal.trim().slice(0, 60)})`);
  check(!(await page.locator('.library .art-card:has-text("zebra")').count()) && !(await page.locator('.lib-artifact').count()), '…as a reply, not as a study output to open or save');
  check(await page.locator('.library .msg.is-bot').last().locator('.msg-act[title="Retry"]').count(), '…with Retry');

  // A narrow page: the output covers the conversation and takes the keyboard; Escape gives it back.
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.click('.library button[title="New conversation"]');
  await page.click('.study-tool:has-text("Flashcards")');
  await page.waitForSelector('.lib-artifact.is-overlay .flashcards', { timeout: 20000 });
  await page.waitForTimeout(200);
  const focus = await page.evaluate(() => ({
    inPanel: !!document.activeElement?.closest('.lib-artifact'),
    inert: document.querySelector('.lib-main')?.hasAttribute('inert'),
  }));
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const flipped = await page.locator('.fc-card.is-flipped').count();
  const typed = await page.inputValue('.library-composer textarea');
  check(focus.inPanel && focus.inert && flipped && typed === '', `at 1000px the flashcards take the keyboard: Space flips the card (${JSON.stringify({ ...focus, flipped, typed })})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({
    open: !!document.querySelector('.lib-artifact'),
    composer: document.activeElement?.matches('.library-composer textarea'),
    inert: document.querySelector('.lib-main')?.hasAttribute('inert'),
  }));
  check(!back.open && back.composer && !back.inert, `…and Escape closes them, back to the composer (${JSON.stringify(back)})`);
  // The output floats over the right of the conversation; a click on the part left showing closes it too.
  await page.click('.library .art-card');
  await page.waitForSelector('.lib-artifact.is-overlay');
  await page.waitForTimeout(400); // it slides in
  const geo = await page.evaluate(() => {
    const lib = document.querySelector('.library').getBoundingClientRect();
    const art = document.querySelector('.lib-artifact').getBoundingClientRect();
    return { lib: Math.round(lib.left), shown: Math.round(art.left - lib.left), right: Math.round(lib.right - art.right) };
  });
  await page.mouse.click(geo.lib + 40, 300);
  await page.waitForTimeout(200);
  const outside = await page.locator('.lib-artifact').count();
  check(geo.shown >= 200 && geo.right === 0 && !outside, `…the conversation stays in view beside it, and a click there closes it (${JSON.stringify({ ...geo, open: outside })})`);
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.waitForTimeout(300);
  await page.click('.library .scope-chip');
  await page.click('.scope-menu .menu-item:has-text("All notes")');
}

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
// (With the quick fixes done, the captions go: what's left is one short list.)
check(await page.locator('.polish .polish-row:has-text("Move to Calculus I")').count(), '…and Polish stays open on the choices it left alone');
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
  // A new profile is seeded first (the Welcome note opens when it's done).
  await off.waitForSelector('.note-view:not(.is-hidden) .page-title', { timeout: 15000 });
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
  await slow.waitForSelector('.note-view:not(.is-hidden) .page-title', { timeout: 15000 });
  await slow.click('.nav-item:has-text("Ask your notes")');
  await slow.waitForSelector('.library .composer-status.is-loading');
  await slow.fill('.library-composer textarea', 'What is the squeeze theorem?');
  await slow.keyboard.press('Enter');
  await slow.waitForSelector('.library .msg.is-bot');
  // Long enough for an instant error to show, well inside the app's own 5s wait for /api/tags.
  await slow.waitForTimeout(600);
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
