// End-to-end test of the local-AI features against scripts/mock-llm.mjs.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/ai.mjs
import { launch, shot, BASE, openClassNote } from './lib.mjs';

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
await page.waitForSelector('.ai-status.is-online', { timeout: 15000 });
const status = await page.textContent('.ai-status');
check(/qwen2\.5vl/.test(status), `connected to the local model server, chose a vision model (${status.trim()})`);

// 1. Tutor on the handwritten worked example.
await openClassNote(page, 'Calculus I', 'Lecture 4');
await page.waitForTimeout(800);
const inkBlock = page.locator(`${V} .ink-block-node`).first();
await inkBlock.scrollIntoViewIfNeeded();
await inkBlock.hover();
await page.locator(`${V} .ink-block-node .ink-action[title^="Math tutor"]`).first().click();
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
await page.click('.study-tool:has-text("Quiz me")').catch(() => undefined);
await page.click('.library button[title="New conversation"]');
await page.click('.study-tool:has-text("Quiz me")');
await page.waitForSelector('.quiz', { timeout: 20000 });
const choices = page.locator('.quiz-q').first().locator('.quiz-choice');
await choices.nth(1).click();
await page.locator('.quiz-q').nth(1).locator('.quiz-choice').nth(0).click();
check(await page.locator('.quiz-choice.is-right').count(), 'quiz marks answers');
await shot(page, 'ai-09-quiz');

// 8. Polish → read handwriting in the background-transcription path.
await page.click('.tab:has-text("Lecture 4")');
await page.waitForTimeout(500);
await page.click('.top-btn[aria-label="Polish"]');
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
await page.click('.ai-status');
await page.waitForSelector('.status-card.is-online');
await shot(page, 'ai-11-settings');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
console.log(errors.join('\n') || 'no page errors');
await browser.close();
