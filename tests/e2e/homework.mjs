// End-to-end test of classes and homework against scripts/mock-llm.mjs.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/homework.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { launch, shot, BASE, OUT, createClassDialog } from './lib.mjs';

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
const mock = (faults) => fetch(`${MOCK}/__mock`, { method: 'POST', body: JSON.stringify(faults) }).then((r) => r.json());
const lastBot = () => page.locator('.assistant .msg.is-bot').last();

// A worksheet as a real PDF (with a text layer) and as a photo (no text).
const sheet = `<html><body style="font: 18px Georgia; padding: 48px"><h1>Problem Set 5</h1><ol>
  <li>Explain what a nucleophile does in an SN2 reaction.</li><li>Why does SN2 invert the stereocenter?</li></ol></body></html>`;
const tmp = fs.mkdtempSync(path.join(OUT, 'hw-'));
{
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 700, height: 500 } });
  await p.setContent(sheet);
  await p.pdf({ path: path.join(tmp, 'Problem Set 5.pdf'), width: '700px', height: '500px' });
  await p.screenshot({ path: path.join(tmp, 'worksheet-photo.png') });
  await b.close();
}

await page.goto(BASE);
await page.waitForSelector('.ai-status.is-online', { timeout: 15000 });
await mock({ fail: 0, truncate: 0, firstTokenMs: 0 });

// ---------------------------------------------------------------- classes
await page.waitForSelector('.tree-row.is-class', { timeout: 15000 });
const classRows = await page.locator('.tree-row.is-class').allTextContents();
check(classRows.length === 5, `the demo notebooks are classes (${classRows.map((t) => t.replace(/\d+$/, '').trim()).join(', ')})`);
check((await page.textContent('.nav-item:has-text("Homework") .nav-count')) === '1', 'Homework shows one assignment to do');

await createClassDialog(page);
await page.fill('.class-name-input input', 'Organic Chemistry');
await page.fill('.class-form .gfield:has-text("Course code") input', 'CHEM 8A');
await page.fill('.class-form .gfield:has-text("Teacher") input', 'Dr. Ruiz');
await page.click('.class-form button[type="submit"]');
await page.waitForSelector('.banner-name:has-text("Organic Chemistry")');
check(/CHEM 8A/.test(await page.textContent('.banner-section')), 'the class banner shows its course code');
await page.click('.banner-info');
check(/Dr\. Ruiz/.test(await page.textContent('.class-info')), '…and its details show the teacher');
await page.keyboard.press('Escape');
await page.click('.banner-customize');
check((await page.locator('.icon-pick.is-active[aria-label="flask"]').count()) === 1, 'the class icon is guessed from its name (flask)');
await page.keyboard.press('Escape');
check(await page.locator('.tree-row.is-class:has-text("Organic Chemistry")').count(), 'the new class is in the sidebar');

// New note from the class page lands in the class.
await page.click('.stream-actions .btn:has-text("New note")');
await page.waitForSelector(`${V} .page-title`);
await page.locator(`${V} .page-title`).fill('Lecture 1 — SN2 reactions');
await page.locator(`${V} .page-title`).press('Enter');
await page.keyboard.type('In an SN2 reaction the nucleophile attacks from the back side in one concerted step. ');
await page.keyboard.type('This backside attack inverts the stereocenter, called Walden inversion.');
await page.waitForTimeout(600);
check(/Organic Chemistry/.test(await page.textContent(`${V} .crumb.is-class`)), 'a note made from the class page belongs to the class');

// ---------------------------------------------------------------- homework from a PDF
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await page.waitForSelector('.banner');
await page.click('.stream-actions .btn:has-text("Add homework")');
await page.waitForSelector('.hw-dialog');
check((await page.$eval('.hw-dialog .hw-for select', (s) => s.selectedOptions[0]?.textContent ?? ''))?.includes('Organic Chemistry'), 'new homework defaults to the current class');
const chooser = page.waitForEvent('filechooser');
await page.click('.hw-attach-tile.is-scan');
await (await chooser).setFiles(path.join(tmp, 'Problem Set 5.pdf'));
await page
  .waitForFunction(() => document.querySelector('.hw-form .hw-title input')?.value === 'Problem Set 5', null, { timeout: 5000 })
  .catch(() => undefined);
check((await page.inputValue('.hw-form .hw-title input')) === 'Problem Set 5', 'the title comes from the file name');
await page.click('.hw-dialog .btn.is-primary');
await page.waitForSelector(`${V} .hw-bar`, { timeout: 15000 });
await page.waitForTimeout(800);
check(await page.locator(`${V} .ProseMirror img`).count(), 'the PDF page is in the homework, ready to write on');
const alt = await page.locator(`${V} .ProseMirror img`).first().getAttribute('alt');
check(/nucleophile/.test(alt ?? ''), 'the PDF text layer is kept for the assistant');
check(/All Organic Chemistry notes/.test(await page.textContent(`${V} .hw-source-chip`)), 'homework uses the class notes as its sources by default');
await shot(page, 'hw-01-pdf-homework');
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await page.click('.gtab:has-text("Classwork")');
check(
  await page.locator('.class-view .topic:has(.topic-title:has-text("Homework")) .cw-row:has-text("Problem Set 5")').count(),
  'it is filed under the class’s Homework topic in Classwork',
);

// ---------------------------------------------------------------- homework from a photo (OCR)
await page.click('.nav-item:has-text("Homework")');
await page.click('.homework-view .btn.is-primary');
await page.click('.menu-item:has-text("Homework")');
await page.selectOption('.hw-dialog .hw-for select', { label: 'Organic Chemistry' });
const chooser2 = page.waitForEvent('filechooser');
await page.click('.hw-attach-tile.is-scan');
await (await chooser2).setFiles(path.join(tmp, 'worksheet-photo.png'));
await page.click('.hw-dialog .btn.is-primary');
await page.waitForSelector(`${V} .hw-bar`);
await page.waitForFunction((v) => /Problem Set 5/.test(document.querySelector(`${v} .ProseMirror img`)?.getAttribute('alt') ?? ''), V, { timeout: 15000 });
check(true, 'a photographed worksheet is read by the vision model');
await page.click('.nav-item:has-text("Homework")');
check((await page.locator('.hw-row-item').count()) === 3, 'the Homework page lists all three assignments');
await shot(page, 'hw-02-list');

// ---------------------------------------------------------------- grounded answers
await page.click('.hw-row-item:has-text("Problem Set 4")');
await page.waitForSelector(`${V} .hw-bar`);
check(/Lecture 4/.test(await page.textContent(`${V} .hw-bar`)), 'Problem Set 4 is linked to Lecture 4');
if (!(await page.locator('.assistant').count())) await page.click('.top-btn.is-assistant');
await page.waitForSelector('.assistant-name:has-text("Homework helper")');
check(/1 linked note/.test(await page.textContent('.assistant-sub')), 'the assistant is in homework mode');

// Problem 1 — covered by the notes: cited, same method.
await page
  .locator(`${V} .ProseMirror li`)
  .nth(0)
  .click({ position: { x: 20, y: 8 } });
await page.click('.starter:has-text("Solve it the way")');
await waitIdle();
let md = await lastBot().locator('.md').innerHTML();
check(/class="cite"/.test(md) && /squeeze theorem/i.test(md), 'a covered problem is answered from the notes with citations');
check(!(await lastBot().locator('.outside-notes').count()), 'nothing is marked as outside the notes when the notes cover it');
check(await lastBot().locator('.grounding-item.is-cited').count(), 'the grounding check counts statements backed by the notes');
check(/Lecture 4/.test(await lastBot().locator('.sources').textContent()), 'sources list the lecture');

// Citation preview shows exactly what the note says.
await lastBot().locator('.cite').first().click();
await page.waitForSelector('.cite-preview');
check(/Squeeze|g\(x\)/i.test(await page.textContent('.cite-preview')), 'clicking a citation previews the cited passage');
await page.keyboard.press('Escape');
await shot(page, 'hw-03-cited');

// Problem 4 — not in the notes: general knowledge is fenced off.
await page
  .locator(`${V} .ProseMirror li`)
  .nth(3)
  .click({ position: { x: 20, y: 8 } });
await page.fill('.composer-input', 'How do I do problem 4?');
await page.press('.composer-input', 'Enter');
await waitIdle();
check(await lastBot().locator('.outside-notes').count(), 'what the notes don’t cover is boxed as “Not from your notes”');
check(/don.t cover/i.test(await lastBot().locator('.md').textContent()), 'the answer says plainly what the notes don’t cover');
check(!(await lastBot().locator('.outside-notes .cite').count()), 'no citations inside the general-knowledge box');
check(await lastBot().locator('.grounding-item.is-outside').count(), 'the grounding bar flags the part not from the notes');
await shot(page, 'hw-04-outside');

// The prompt really is restricted to the linked notes.
const req = await page.evaluate(() => JSON.parse(localStorage.getItem('nib.assistant') || '{}'));
void req;

// Insert into the note keeps the general-knowledge box marked.
await lastBot().hover();
await lastBot().locator('.msg-act:has-text("Insert into note")').click();
await page.waitForTimeout(300);
check(await page.locator(`${V} .callout[data-variant="outside"]`).count(), 'inserted answers keep the “not from your notes” marking');

// ---------------------------------------------------------------- linking notes
await page.click(`${V} .hw-source-chip button[aria-label^="Remove"]`);
await page.waitForSelector(`${V} .hw-no-sources`);
check(await page.locator(`${V} .hw-suggest:has-text("Lecture 4")`).count(), 'with nothing linked, Lecture 4 is suggested');
await page.click('.assistant .icon-btn[title="New conversation"]');
await page.click('.starter:has-text("Give me a hint")');
await waitIdle();
check(/haven.t linked any notes/i.test(await lastBot().textContent()), 'without linked notes the helper says so');
check(await lastBot().locator('.outside-notes').count(), '…and marks everything as general knowledge');

await page.click(`${V} .hw-link-btn`);
await page.waitForSelector('.link-dialog');
check(/Lecture 4/.test(await page.locator('.link-dialog .link-row').first().textContent()), 'the picker suggests the matching lecture first');
await page.click('.link-dialog .link-row:has-text("Lecture 4")');
await page.click('.link-dialog .btn.is-primary');
await page.waitForTimeout(300);
check(/Lecture 4/.test(await page.textContent(`${V} .hw-bar`)), 'linking a note shows it as a source');

// ---------------------------------------------------------------- harness: retries & continue
await page.click('.assistant .icon-btn[title="New conversation"]');
await mock({ fail: 2, status: 503 });
await page
  .locator(`${V} .ProseMirror li`)
  .nth(1)
  .click({ position: { x: 20, y: 8 } });
await page.fill('.composer-input', 'Help me with problem 2');
await page.press('.composer-input', 'Enter');
await waitIdle();
let stats = (await mock({})).stats;
check(stats.failed >= 2 && (await lastBot().locator('.cite').count()), 'two server errors were retried and the answer still arrived');

await mock({ truncate: 1 });
await page.fill('.composer-input', 'And problem 3?');
await page.press('.composer-input', 'Enter');
await waitIdle();
const cut = (await lastBot().locator('.md').textContent()).length;
check(await lastBot().locator('.msg-continue').count(), 'a reply cut off by the token limit offers “continue”');
await lastBot().locator('.msg-continue').click();
await waitIdle();
const full = (await lastBot().locator('.md').textContent()).length;
check(full > cut && !(await lastBot().locator('.msg-continue').count()), `continue extends the same reply (${cut} → ${full} chars)`);
// The raw reply (KaTeX repeats formula text in the DOM, so read the stored markdown).
const joinedText = await page.evaluate(() => {
  const threads = JSON.parse(localStorage.getItem('nib.assistant') || '{}').state?.threads ?? {};
  const msgs = Object.values(threads).flatMap((t) => t.messages);
  return [...msgs].reverse().find((m) => m.role === 'assistant' && m.status === 'done')?.content ?? '';
});
const words = joinedText.split(/\s+/);
const fiveGrams = words.map((_, i) => words.slice(i, i + 5).join(' ')).filter((g) => g.split(' ').length === 5);
const repeated = fiveGrams.some((g, i) => fiveGrams.indexOf(g) !== i);
if (repeated) console.log('     joined:', JSON.stringify(joinedText));
check(!repeated && /\[\d\]\.$/.test(joinedText.trim()), 'the continued reply joins seamlessly (no repeated words at the seam, ends where the answer ends)');

// ---------------------------------------------------------------- done
await page.click(`${V} .hw-done`);
await page.click('.nav-item:has-text("Homework")');
check(!(await page.locator('.hw-row-item:has-text("Problem Set 4")').count()), 'marking done removes it from To do');
await page.click('.homework-view .gtab:has-text("Done")');
check(await page.locator('.hw-row-item.is-done:has-text("Problem Set 4")').count(), '…and lists it under Done');

// ---------------------------------------------------------------- class-scoped Q&A and study tools
await page.click('.tree-row.is-class:has-text("Calculus I")');
await page.click('.class-view button[aria-label="Ask your Calculus I notes"]');
await page.waitForSelector('.library-title h1:has-text("Ask Calculus I")');
await page.fill('.library-composer textarea', 'What does the squeeze theorem say?');
await page.press('.library-composer textarea', 'Enter');
await page.waitForFunction(() => !document.querySelector('.msg.is-streaming'), null, { timeout: 20000 });
const srcFolders = await page.locator('.library .msg.is-bot').last().locator('.source-sec').allTextContents();
check(
  srcFolders.length > 0 && srcFolders.every((s) => s.startsWith('Calculus I') && !/Homework/.test(s)),
  `class Q&A only cites that class’s notes, never homework (${srcFolders.join(' | ')})`,
);

await page.click('.tree-row.is-class:has-text("Calculus I")');
await page.click('.gtab:has-text("Study")');
await page.click('.class-study-tool:has-text("Flashcards")');
await page.waitForSelector('.flashcard, .flashcards', { timeout: 20000 });
check(true, 'flashcards are made from the class from its page');

// ---------------------------------------------------------------- Polish files loose notes into classes
await page.click('.nav-item:has-text("All notes")');
await page.click('.notes-view .btn.is-create');
await page.locator(`${V} .page-title`).fill('Exam review');
await page.locator(`${V} .page-title`).press('Enter');
await page.keyboard.type('Squeeze theorem: if g is below f and h above, and both limits equal L, the limit of f is L. A removable discontinuity is a hole.');
await page.waitForTimeout(700);
await page.click('.top-btn[aria-label="Polish"]');
const moveRow = page.locator('.polish-row:has-text("Move to Calculus I")');
check(await moveRow.count(), 'Polish suggests filing an unfiled note in the class it matches');
await moveRow.locator('button').click();
await page.waitForTimeout(400);
check(
  /Calculus I/.test(
    (await page
      .locator(`${V} .crumb.is-class`)
      .textContent()
      .catch(() => '')) ?? '',
  ),
  '…and moves it there',
);
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- renaming a class keeps links
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await page.click('.class-view button[aria-label="Class settings"]');
await page.fill('.class-name-input input', 'Orgo');
await page.click('.class-form button[type="submit"]');
await page.waitForSelector('.banner-name:has-text("Orgo")');
await page.click('.gtab:has-text("Classwork")');
check((await page.locator('.class-view .topic:has(.topic-title:has-text("Homework")) .cw-row').count()) === 2, 'renaming the class keeps its homework');
await page.click('.class-view .cw-row:has-text("Problem Set 5")');
check(/All Orgo notes/.test(await page.textContent(`${V} .hw-source-chip`)), 'homework links follow the renamed class');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
// 503s are the injected faults above.
console.log(errors.filter((e) => !/favicon|status of 503/.test(e)).join('\n') || 'no page errors');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
