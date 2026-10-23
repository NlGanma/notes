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
await page.locator('.library .msg.is-bot .cite').first().click();
await page.waitForSelector('.cite-preview');
await shot(page, 'ai-06-library-cited');
await page.click('.cite-preview .btn');
await page.waitForTimeout(900);
check(await page.locator(`${V} .nib-flash-box`).count(), 'citation opened the note and highlighted the source block');
await shot(page, 'ai-07-citation-jump');

// 7. Study tools: flashcards and quiz.
await page.click('.nav-item:has-text("Ask your notes")');
await page.click('.library button[title="New conversation"]');
await page.click('.study-tool:has-text("Flashcards")');
await page.waitForSelector('.flashcards', { timeout: 20000 });
await page.click('.fc-card');
await page.waitForTimeout(500);
await shot(page, 'ai-08-flashcards');
await page.click('.library button[title="New conversation"]');
await page.click('.study-tool:has-text("Quiz")');
await page.waitForSelector('.quiz', { timeout: 20000 });
await page.locator('.quiz-choice').nth(1).click();
check(await page.locator('.quiz-choice.is-right').count(), 'quiz marks answers');
await shot(page, 'ai-09-quiz');

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

// 9. Settings shows the detected models.
await page.click('.side-settings');
await page.click('.settings-nav-item:has-text("Local AI")');
await page.waitForSelector('.status-card.is-online');
check(/qwen2\.5vl/.test(await page.textContent('.status-card')), 'Settings names the models in use');
await shot(page, 'ai-11-settings');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.join('\n') || 'no page errors');
await browser.close();
