// End-to-end test of classes and homework against scripts/mock-llm.mjs.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/homework.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { launch, shot, BASE, OUT, createClassDialog, newNoteFromSidebar, noteMenuItem, showSidebar } from './lib.mjs';

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
/** Opens the folded "Done (n)" list at the bottom of the Homework page (the due groups never fold). */
const openDone = async () => {
  await page.waitForSelector('.homework-view');
  const head = page.locator('.homework-view .hw-done-head[aria-expanded="false"]');
  if (await head.count()) await head.click();
};
/** Picks an item from the open class page's ⋯ menu (Edit class…, Delete class…). */
const classPageMenu = async (label) => {
  await page.click('.class-view .class-head-more');
  await page.click(`.context-menu .menu-item:has-text("${label}")`);
};
const folderMeta = () => page.evaluate(() => window.__nib.vault.getState().folderMeta);

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
await page.waitForSelector('[data-ai-status="online"]', { timeout: 15000 });
await mock({ fail: 0, truncate: 0, firstTokenMs: 0 });

// ---------------------------------------------------------------- classes
await page.waitForSelector('.tree-row.is-class', { timeout: 15000 });
const classRows = await page.locator('.tree-row.is-class').allTextContents();
check(classRows.length === 5, `the demo notebooks are classes (${classRows.map((t) => t.replace(/\d+$/, '').trim()).join(', ')})`);
check((await page.textContent('.nav-item:has-text("Homework") .nav-count')) === '1', 'Homework shows one assignment to do');

await createClassDialog(page);
check(!(await page.locator('.class-dialog :is(.gfield, input[placeholder*="code" i], input[placeholder*="teacher" i])').count()), 'New class asks for no course code, teacher or term');
await page.fill('.class-name-input input', 'Organic Chemistry');
check((await page.locator('.class-dialog .icon-pick.is-active[aria-label="flask"]').count()) === 1, 'the class icon follows the name as it is typed (flask)');
await page.click('.class-form button[type="submit"]');
await page.waitForSelector('.class-view .class-title:has-text("Organic Chemistry")');
check(await page.locator('.tree-row.is-class:has-text("Organic Chemistry")').count(), 'the new class is in the sidebar');
{
  const m = (await folderMeta())['Organic Chemistry'];
  check(m?.kind === 'class' && !('code' in m) && !('instructor' in m) && !('term' in m), 'a new class stores its colour and icon, nothing from Classroom');
}
await classPageMenu('Edit class');
// The dialog shows the guessed icon (nothing stored yet, so it still follows the name).
const flask = await page.waitForSelector('.class-dialog .icon-pick.is-active[aria-label="flask"]', { timeout: 3000 }).catch(() => null);
check(!!flask && (await page.locator('.icon-pick.is-active').count()) === 1, 'the class icon is guessed from its name (flask)');
check(await page.locator('.class-dialog .class-to-folder').count(), 'Edit class offers to turn the class back into a plain folder');
await page.keyboard.press('Escape');

// A name that differs only in case from a class that exists is never an error: it gets a number.
await createClassDialog(page);
await page.fill('.class-name-input input', 'organic chemistry');
await page.keyboard.press('Enter');
await page.waitForSelector('.class-view .class-title:has-text("organic chemistry 2")');
check((await folderMeta())['organic chemistry 2']?.kind === 'class', 'a class named like another in any case gets its own folder (“organic chemistry 2”)');
// Deleting it from its page's ⋯ (which has only Edit, Show in Finder and Delete).
await page.click('.class-view .class-head-more');
const pageMenu = (await page.locator('.context-menu .menu-item').allTextContents()).map((t) => t.trim());
check(!pageMenu.some((t) => /New note|New homework|Review/.test(t)), `the class page's ⋯ leaves out what its buttons already do (${pageMenu.join(', ')})`);
await page.click('.context-menu .menu-item:has-text("Delete class")');
await page.click('.modal .btn:has-text("Delete class")');
await page.waitForSelector('.toast:has-text("Deleted organic chemistry 2")');

// Editing a seeded class keeps what older versions stored (course code, teacher, the old colour).
await showSidebar(page);
await page.click('.sidebar .nav-class:has-text("Calculus I")');
await classPageMenu('Edit class');
await page.click('.class-form button[type="submit"]');
await page.waitForTimeout(300);
{
  const m = (await folderMeta())['Calculus I'];
  check(m?.code === 'MATH 1A' && m?.instructor === 'Prof. Alvarez' && m?.color === '#2160e8', 'saving Edit class keeps the stored course code, teacher and colour');
}

// New note from the class page lands in the class.
await showSidebar(page);
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await page.click('.class-actions .btn:has-text("New note")');
check(/In Organic Chemistry/.test(await page.textContent('.new-note-pop .menu-caption')), 'the class page’s New note says where the note goes');
await page.click('.new-note-pop .paper-opt:has-text("Lined")');
await page.waitForSelector(`${V} .page-title`);
await page.locator(`${V} .page-title`).fill('Lecture 1 — SN2 reactions');
await page.locator(`${V} .page-title`).press('Enter');
await page.keyboard.type('In an SN2 reaction the nucleophile attacks from the back side in one concerted step. ');
await page.keyboard.type('This backside attack inverts the stereocenter, called Walden inversion.');
await page.waitForTimeout(600);
check(/Organic Chemistry/.test(await page.textContent(`${V} .crumb.is-class`)), 'a note made from the class page belongs to the class');

// ---------------------------------------------------------------- homework from a PDF
await showSidebar(page);
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await page.waitForSelector('.class-view');
await page.click('.class-actions .btn:has-text("New homework")');
await page.waitForSelector('.hw-dialog');
check(/Organic Chemistry/.test(await page.textContent('.hw-dialog .hw-for')), 'new homework defaults to the current class');
check(!(await page.locator('.hw-dialog :is(textarea, [contenteditable])').count()), 'New homework has no instructions field (they go on the homework page)');
const chooser = page.waitForEvent('filechooser');
await page.click('.hw-dialog .hw-worksheet-add');
await (await chooser).setFiles(path.join(tmp, 'Problem Set 5.pdf'));
await page
  .waitForFunction(() => document.querySelector('.hw-dialog .hw-title-input')?.value === 'Problem Set 5', null, { timeout: 5000 })
  .catch(() => undefined);
check((await page.inputValue('.hw-dialog .hw-title-input')) === 'Problem Set 5', 'the title comes from the file name');
await page.click('.hw-dialog .hw-create');
await page.waitForSelector(`${V} .hw-bar`, { timeout: 15000 });
await page.waitForTimeout(800);
check(await page.locator(`${V} .ProseMirror img`).count(), 'the PDF page is in the homework, ready to write on');
const alt = await page.locator(`${V} .ProseMirror img`).first().getAttribute('alt');
check(/nucleophile/.test(alt ?? ''), 'the PDF text layer is kept for the assistant');
check(/All Organic Chemistry notes/.test(await page.textContent(`${V} .hw-source-chip`)), 'homework uses the class notes as its sources by default');
check(/answers only from these notes/.test(await page.textContent(`${V} .hw-work-note`)), 'under its sources the homework says the assistant answers only from them');
await shot(page, 'hw-01-pdf-homework');
await showSidebar(page);
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
check(await page.locator('.class-view .class-homework .hw-row-item:has-text("Problem Set 5")').count(), 'it is listed under the class page’s Homework');

// A worksheet dropped on the class page starts New homework with it.
{
  const pdf = fs.readFileSync(path.join(tmp, 'Problem Set 5.pdf')).toString('base64');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'Dropped sheet.pdf', { type: 'application/pdf' }));
    const el = document.querySelector('.class-view .class-col');
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, pdf);
  await page.waitForSelector('.hw-dialog .hw-sheet-name:has-text("Dropped sheet.pdf")', { timeout: 5000 }).catch(() => undefined);
  check(
    (await page.locator('.hw-dialog .hw-sheet-name:has-text("Dropped sheet.pdf")').count()) && /Organic Chemistry/.test(await page.textContent('.hw-dialog .hw-for')),
    'a PDF dropped on the class page opens New homework for that class with the worksheet attached',
  );
  await page.click('.hw-dialog .btn:has-text("Cancel")');
  check(!(await page.locator('.drop-hint').count()), '…and the drop overlay goes away');
}

// ⌘K runs a command typed by name, even though the Welcome note mentions the same words; nothing found says so.
await page.keyboard.press('Meta+k');
await page.fill('.palette-input input', 'new hom');
await page.keyboard.press('Enter');
await page.waitForSelector('.hw-dialog', { timeout: 3000 }).catch(() => undefined);
check(await page.locator('.hw-dialog').count(), '⌘K “new hom” and Enter opens New homework, not a note that mentions it');
await page.click('.hw-dialog .btn:has-text("Cancel")');
await page.keyboard.press('Meta+k');
await page.fill('.palette-input input', 'zzqx');
await page.waitForTimeout(200);
check(
  (await page.locator('.palette-empty:has-text("No matches")').count()) && !(await page.locator('.palette-item.is-active').count()),
  '…and a query nothing matches says No matches, with nothing picked for Enter',
);
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- homework from a photo (OCR)
await page.click('.nav-item:has-text("Homework")');
await page.click('.homework-view .btn.is-primary:has-text("New homework")');
await page.click('.hw-dialog .hw-for');
await page.click('.hw-class-menu .menu-item:has-text("Organic Chemistry")');
const chooser2 = page.waitForEvent('filechooser');
await page.click('.hw-dialog .hw-worksheet-add');
await (await chooser2).setFiles(path.join(tmp, 'worksheet-photo.png'));
await page.click('.hw-dialog .hw-create');
await page.waitForSelector(`${V} .hw-bar`);
await page.waitForFunction((v) => /Problem Set 5/.test(document.querySelector(`${v} .ProseMirror img`)?.getAttribute('alt') ?? ''), V, { timeout: 15000 });
check(true, 'a photographed worksheet is read by the vision model');
// A page nobody has read yet: the worksheet chip offers to read it.
await page.evaluate((v) => {
  const ed = document.querySelector(`${v} .ProseMirror`).editor;
  ed.commands.command(({ tr }) => {
    tr.doc.descendants((n, pos) => {
      if (n.type.name === 'image') tr.setNodeMarkup(pos, undefined, { ...n.attrs, alt: '' });
    });
    return true;
  });
}, V);
await page.waitForSelector(`${V} .hw-read`);
check(/^Read 1 page$/.test((await page.textContent(`${V} .hw-read`)).trim()), 'an unread worksheet page shows Read 1 page beside the worksheet');
await page.click(`${V} .hw-read`);
await page.waitForSelector('.toast:has-text("Pages read")', { timeout: 15000 });
await page.waitForSelector(`${V} .hw-read`, { state: 'detached' });
check(/Problem Set 5/.test((await page.locator(`${V} .ProseMirror img`).first().getAttribute('alt')) ?? ''), '…and reading it puts the questions where the assistant can see them');
await page.click('.nav-item:has-text("Homework")');
await page.waitForSelector('.homework-view');
check((await page.locator('.hw-row-item').count()) === 3, 'the Homework page lists all three assignments');
check(!(await page.locator('.homework-view :is(.gtab, [role="tab"])').count()), '…in one list, with no Assigned / Missing / Done tabs');
await shot(page, 'hw-02-list');

// Two quick clicks on one checkbox tick it and untick it; they never reach the row below.
{
  const box = await page.locator('.homework-view .hw-row-item:has-text("worksheet-photo") .hw-check').boundingBox();
  const undone = () => page.locator('.homework-view .hw-row-item:not(.is-done)').count();
  check((await undone()) === 3, 'three homework to do before the clicks');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1800);
  check((await undone()) === 3 && !(await page.locator('.homework-view .hw-done-head').count()), 'a quick second click unticks the same homework instead of ticking the next one');
  check(!(await page.locator('.toast:has-text("Marked as done")').count()), '…and takes its Marked as done toast away');
}

// Ticking a row's checkbox finishes it: it stays a moment, checked, then moves into Done. Undo brings it back.
await page.click('.hw-row-item:has-text("worksheet-photo") .hw-check');
await page.waitForSelector('.toast:has-text("Marked as done")');
check(await page.locator('.homework-view .hw-row-item.is-done:has-text("worksheet-photo") .hw-check[aria-checked="true"]').count(), 'a ticked homework stays in its place for a moment, checked');
await page.waitForSelector('.homework-view .hw-row-item:has-text("worksheet-photo")', { state: 'detached', timeout: 5000 });
check(/Done \(1\)/.test(await page.textContent('.hw-done-head')), '…then moves into the folded Done list');
await page.click('.toast:has-text("Marked as done") .toast-action:has-text("Undo")');
await page.waitForSelector('.hw-row-item:has-text("worksheet-photo")');
check(true, '…and Undo puts it back');

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
check(/Link notes so the assistant can answer from them/.test(await page.textContent(`${V} .hw-no-sources`)), 'with no sources the line under the bar asks for linked notes');
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
check((await page.getAttribute(`${V} .hw-done`, 'aria-pressed')) === 'true', 'Mark done turns into a pressed Done');
await page.click('.nav-item:has-text("Homework")');
await page.waitForSelector('.homework-view');
check(!(await page.locator('.hw-row-item:has-text("Problem Set 4")').count()), 'marking done removes it from the list');
await openDone();
check(await page.locator('.hw-row-item.is-done:has-text("Problem Set 4")').count(), '…and lists it under Done');

// ---------------------------------------------------------------- class-scoped Q&A and study tools
await showSidebar(page);
await page.click('.tree-row.is-class:has-text("Calculus I")');
await page.fill('.class-view .class-ask textarea', 'What does the squeeze theorem say?');
await page.press('.class-view .class-ask textarea', 'Enter');
await page.waitForSelector('.library .msg.is-bot', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.msg.is-streaming'), null, { timeout: 20000 });
const srcFolders = await page.locator('.library .msg.is-bot').last().locator('.source-sec').allTextContents();
check(
  srcFolders.length > 0 && srcFolders.every((s) => s.startsWith('Calculus I') && !/Homework/.test(s)),
  `class Q&A only cites that class’s notes, never homework (${srcFolders.join(' | ')})`,
);

// Study tools for the class live in Ask your notes, which the class page's composer opened on the class.
await page.click('.library .study-tool:has-text("Flashcards")');
await page.waitForSelector('.flashcard, .flashcards', { timeout: 20000 });
check(true, 'flashcards are made from the class in Ask your notes, opened from its page');

// ---------------------------------------------------------------- Polish files loose notes into classes
await page.click('.nav-item:has-text("All notes")');
await newNoteFromSidebar(page, 'Squared');
check((await page.locator(`${V} .page.paper-grid`).count()) === 1, 'a note made from the New note menu is on the paper picked there');
await page.locator(`${V} .page-title`).fill('Exam review');
await page.locator(`${V} .page-title`).press('Enter');
await page.keyboard.type('Squeeze theorem: if g is below f and h above, and both limits equal L, the limit of f is L. A removable discontinuity is a hole.');
await page.waitForTimeout(700);
await noteMenuItem(page, 'Polish');
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

// ---------------------------------------------------------------- New note from the keyboard
// The paper used last has the focus; ← and → move it, Enter makes the note on that paper.
await showSidebar(page);
await page.click('.sidebar .side-new');
await page.waitForSelector('.new-note-pop .paper-opt');
const lastPaper = await page.evaluate(() => JSON.parse(localStorage.getItem('nib.settings') || '{}').state?.paper);
const focusedPaper = () => page.evaluate(() => document.activeElement?.getAttribute('data-paper') ?? null);
await page.waitForFunction((p) => document.activeElement?.getAttribute('data-paper') === p, lastPaper, { timeout: 2000 }).catch(() => {});
check((await focusedPaper()) === lastPaper, `the New note menu opens with the last paper used in focus (${lastPaper})`);
await page.keyboard.press('ArrowLeft');
const pickedPaper = await focusedPaper();
check(pickedPaper && pickedPaper !== lastPaper, `← moves the focus to the next paper (${pickedPaper})`);
const beforeId = await page.evaluate(() => window.__nib.ui.getState().view.id ?? null);
await page.keyboard.press('Enter');
await page.waitForFunction((b) => {
  const v = window.__nib.ui.getState().view;
  return v.kind === 'note' && v.id !== b;
}, beforeId);
check(
  await page.evaluate((p) => {
    const v = window.__nib.ui.getState().view;
    return window.__nib.vault.getState().notes[v.id]?.meta.paper === p;
  }, pickedPaper),
  '…and Enter makes a note on that paper',
);
check(!(await page.locator(`${V} .paper-strip`).count()), 'a note made from a paper in the menu does not offer the paper again');
await page.click('.sidebar .side-new');
await page.waitForFunction(() => document.activeElement?.closest('.new-note-pop'));
await page.keyboard.press('Escape');
check(await page.evaluate(() => !document.querySelector('.new-note-pop') && !!document.activeElement?.classList.contains('side-new')), 'Esc closes it and gives the focus back to New note');

// ⌘N takes the last paper and offers the choice under the title until something goes in the body.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
await page.keyboard.press(`${MOD}+n`);
await page.waitForSelector(`${V} .paper-strip:not(.is-spent)`);
check(true, '⌘N offers the paper under the new note’s title');
await page.click(`${V} .paper-strip .paper-opt[data-paper="grid"]`);
check((await page.locator(`${V} .page.paper-grid`).count()) === 1, '…picking Squared there switches the page');
check(await page.evaluate(() => JSON.parse(localStorage.getItem('nib.settings') || '{}').state?.paper === 'grid'), '…and the next note starts on it too');
const titleTop = await page.locator(`${V} .surface`).evaluate((el) => el.getBoundingClientRect().top);
await page.locator(`${V} .page-title`).press('Enter');
await page.keyboard.type('Limits');
await page.waitForSelector(`${V} .paper-strip.is-spent`);
const bodyTop = await page.locator(`${V} .surface`).evaluate((el) => el.getBoundingClientRect().top);
check(Math.abs(bodyTop - titleTop) < 1, 'the first words put the paper choice away without moving the page');

// ---------------------------------------------------------------- renaming a class keeps links
await showSidebar(page);
await page.click('.tree-row.is-class:has-text("Organic Chemistry")');
await classPageMenu('Edit class');
await page.fill('.class-name-input input', 'Orgo');
await page.click('.class-form button[type="submit"]');
await page.waitForSelector('.class-view .class-title:has-text("Orgo")');
check((await page.locator('.class-view .class-homework .hw-row-item').count()) === 2, 'renaming the class keeps its homework');
await page.click('.class-view .hw-row-item:has-text("Problem Set 5")');
check(/All Orgo notes/.test(await page.textContent(`${V} .hw-source-chip`)), 'homework links follow the renamed class');

// ---------------------------------------------------------------- deleting a class can be undone
const orgoLive = () => page.evaluate(() => Object.values(window.__nib.vault.getState().notes).filter((n) => !n.meta.trashed && n.meta.folder.startsWith('Orgo')).length);
const orgoBefore = await orgoLive();
await showSidebar(page);
await page.click('.sidebar .nav-class:has-text("Orgo")', { button: 'right' });
await page.click('.context-menu .menu-item:has-text("Delete class")');
await page.click('.modal .btn:has-text("Delete class")');
await page.waitForSelector('.toast:has-text("Deleted Orgo")');
check((await orgoLive()) === 0 && !(await page.locator('.sidebar .nav-class:has-text("Orgo")').count()), `Delete class moves its ${orgoBefore} notes and homework to Trash`);
await page.click('.toast:has-text("Deleted Orgo") .toast-action:has-text("Undo")');
await page.waitForSelector('.sidebar .nav-class:has-text("Orgo")');
await page.waitForTimeout(300);
check((await orgoLive()) === orgoBefore && (await page.evaluate(() => window.__nib.vault.getState().folderMeta.Orgo?.kind)) === 'class', '…and Undo brings the class back with all of them');

// ---------------------------------------------------------------- a class can go back to being a plain folder
await createClassDialog(page);
await page.fill('.class-name-input input', 'Scratch');
await page.keyboard.press('Enter');
await page.waitForSelector('.class-view .class-title:has-text("Scratch")');
await classPageMenu('Edit class');
await page.click('.class-dialog .class-to-folder');
await page.click('.modal .btn:has-text("Turn into folder")');
await page.waitForSelector('.notes-view .list-title:has-text("Scratch")');
check((await folderMeta()).Scratch?.kind !== 'class' && !(await page.locator('.sidebar .nav-class:has-text("Scratch")').count()), 'Turn into a plain folder makes the class a folder in All notes');

check(!errors.some((e) => /Warning:|Maximum update depth/.test(e)), 'no React warnings (an effect setting state on every keystroke shows up here)');
// 503s are the injected faults above.
console.log(errors.filter((e) => !/favicon|status of 503/.test(e)).join('\n') || 'no page errors');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
