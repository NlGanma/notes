// End-to-end test of Review (the Mastery Engine) against scripts/mock-llm.mjs:
// pick notes from two classes, practise them interleaved, and check that every
// question, answer and "your notes say" comes from the notes.
//   node scripts/mock-llm.mjs &   (port 11434)
//   node tests/e2e/review.mjs
import { launch, shot, BASE } from './lib.mjs';

const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:11434';
const { browser, page, errors } = await launch({ width: 1440, height: 940 });
const check = (cond, msg) => {
  console.log(cond ? 'ok  ' : 'FAIL', msg);
  if (!cond) process.exitCode = 1;
};
const stats = () => fetch(`${MOCK}/__mock`).then((r) => r.json()).then((j) => j.stats);
const mock = (body) => fetch(`${MOCK}/__mock`, { method: 'POST', body: JSON.stringify(body) });
const state = () =>
  page.evaluate(() => {
    const s = window.__nib.review.getState();
    const c = s.current;
    return {
      phase: c?.phase ?? null,
      item: c?.item ?? null,
      concept: c ? { id: c.concept.id, name: c.concept.name, noteId: c.concept.noteId } : null,
      group: c ? s.pool.find((p) => p.id === c.concept.id)?.groupName : null,
      index: s.session?.index ?? null,
      summary: !!s.summary,
      shownAt: c?.shownAt ?? 0,
    };
  });
const fold = (t) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
/** Words (4+ letters) of a text that none of the session's notes contain. */
const notInNotes = (text, noteIds) =>
  page.evaluate(
    ({ text, noteIds }) => {
      const notes = window.__nib.vault.getState().notes;
      const fold = (t) =>
        t
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase();
      const hay = fold(noteIds.map((id) => JSON.stringify(notes[id]?.content ?? '') + ' ' + (notes[id]?.meta.title ?? '')).join(' '));
      const clean = text.replace(/\$[^$]*\$/g, ' ').replace(/\\[a-z]+/g, ' ');
      return [...new Set(fold(clean).match(/\p{L}{4,}/gu) ?? [])].filter((w) => !hay.includes(w));
    },
    { text, noteIds },
  );
/** The mock model's slips (see badQuestions in scripts/mock-llm.mjs). */
const SLIP = /Napoleon|1805|at night|an example of/;
const waitPhase = (phases) =>
  page.waitForFunction((ph) => ph.includes(window.__nib.review.getState().current?.phase), phases, { timeout: 15000 });

/** Answers the current item from the notes (the answer key, the right choice or the key points). */
async function answerRight(item) {
  if (item.format === 'mcq') await page.click(`.rv-choice >> nth=${item.correct}`);
  else if (item.format === 'rate') await page.click('.rv-check-btn');
  else {
    await page.fill('.rv-input', item.expected ?? (item.points ?? [item.fact]).join('; ').replace(/\*\*|==/g, ''));
    await page.keyboard.press('Enter');
  }
  await waitPhase(['feedback', 'self']);
  if ((await state()).phase === 'self') await page.click('.rv-self button:has-text("Got it")');
  await waitPhase(['feedback']);
}

await page.goto(BASE);
await page.waitForSelector('[data-ai-status="online"]', { timeout: 15000 });

// A lecture written as plain prose: little structure for the rules to read, so the Mastery Engine reads it.
await page.evaluate(() => {
  const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  window.__nib.vault.getState().createNote({
    folder: 'Calculus I',
    title: 'Lecture 6 — Related rates',
    content: {
      type: 'doc',
      content: [
        para(
          'In related rates problems we differentiate both sides of an equation with respect to time. Every quantity that changes is treated as a function of time, so the chain rule applies to each one. First draw a picture and name the changing quantities, then write an equation that links them.',
        ),
        para(
          'A common mistake is substituting the numbers before differentiating, which turns a changing quantity into a constant and makes its rate zero. The units of the answer are the units of the quantity divided by the units of time.',
        ),
      ],
    },
  });
});

// ---------------------------------------------------------------- picker
await page.click('.nav-item:has-text("Review")');
await page.waitForSelector('.review-view .rv-tree');
const groups = await page.locator('.rv-row.is-group .rv-name').allTextContents();
check(groups.includes('Calculus I') && groups.includes('Spanish II'), `the picker lists classes (${groups.join(', ')})`);
check(!(await page.locator('.rv-row.is-note:has-text("Problem Set")').count()), '…and homework is not offered for review');

// Chapters: Spanish II is organised by unit.
await page.click('.rv-row.is-group:has-text("Spanish II")');
check(await page.locator('.rv-row.is-chapter:has-text("Unidad 3")').count(), 'a class’s chapters (its subfolders) can be picked');
await page.click('.rv-row.is-chapter:has-text("Unidad 3") .rv-box');
await page.click('.rv-row.is-group:has-text("Calculus I") .rv-box');
const label = (await page.locator('.rv-panel-label').textContent()) ?? '';
check(/Calculus I/.test(label) && /Spanish II/.test(label), `two classes picked together (“${label}”)`);
check(await page.locator('.rv-check:has-text("Mix classes") input:not([disabled])').count(), '…and mixing them is offered');
const statsText = (await page.locator('.rv-panel-stats').textContent()) ?? '';
check(/\d+ ideas?/.test(statsText), `the panel counts the ideas in the notes (${statsText.trim()})`);
check(await page.locator('.rv-warn').count(), 'untranscribed handwriting is called out as not reviewable');

// The Mastery Engine reads passages the rules found little in; its slips are rejected.
await page.waitForTimeout(2200);
await page.waitForFunction(() => !window.__nib.review.getState().reading, null, { timeout: 15000 });
const st0 = await stats();
const modelConcepts = await page.evaluate(() => Object.values(window.__nib.review.getState().file.modelConcepts).map((c) => c.name));
check(st0.kinds.includes('mastery-concepts'), 'the Mastery Engine reads the passages the rules found little in');
check(!modelConcepts.some((n) => /Photosynthesis|Mitochondria powerhouse/.test(n)), `…and ideas it made up are rejected (kept: ${modelConcepts.join(', ') || 'none'})`);
await shot(page, 'review-01-picker');

// ---------------------------------------------------------------- session
await page.click('.seg button:has-text("Quick")');
// The model's next three questions slip: an invented name and year, a premise in plain words, the answer in the question.
await mock({ badQuestions: 3 });
const selected = await page.evaluate(() => window.__nib.review.getState().selection);
await page.click('.rv-start');
await page.waitForSelector('.rv-session .rv-card');
const top = (await page.locator('.rv-topbar-label').textContent()) ?? '';
check(/Calculus I/.test(top) && /Spanish II/.test(top), `the session mixes both classes (${top})`);
await shot(page, 'review-02-question');

const seq = [];
const formats = new Set();
let ungrounded = [];
let idkChecked = false;
let accentChecked = false;
let wrongChecked = false;
let rubricGraded = false;
let napoleon = false;
let modelPhrased = 0;
for (let turn = 0; turn < 40; turn++) {
  const s = await state();
  if (s.summary || !s.item) break;
  const { item } = s;
  seq.push(s.group);
  formats.add(item.format);
  if (item.origin === 'model') modelPhrased++;
  if (SLIP.test(item.prompt)) napoleon = true;
  // The grounding invariant, seen from outside: everything shown as the notes' is in the notes.
  for (const t of [item.fact, item.expected ?? '', ...(item.accept ?? []), ...(item.points ?? []), ...(item.choices ?? [])]) {
    const extra = await notInNotes(t, selected);
    if (extra.length) ungrounded.push(`${item.key}: ${extra.join(' ')}`);
  }
  const before = await stats();
  if (!idkChecked && item.format !== 'mcq' && item.format !== 'rate') {
    // "I don't know": no grading call, the notes' answer at once.
    await page.click('.rv-idk');
    await waitPhase(['feedback']);
    await page.waitForTimeout(300);
    const after = await stats();
    const calls = after.kinds.slice(before.kinds.length);
    check(!calls.some((k) => /mastery-(grade|nudge)/.test(k)), `“I don’t know” makes no grading call (${calls.join(', ') || 'none'})`);
    check(await page.locator('.rv-notes-say').count(), '…and shows what the notes say right away');
    check(await page.locator('.rv-verdict.is-wrong').count(), '…and counts as not known');
    await shot(page, 'review-03-dont-know');
    idkChecked = true;
  } else if (!accentChecked && (item.format === 'recall' || item.format === 'cloze') && /[áéíóúñ]/i.test(item.expected ?? '') && s.group === 'Spanish II') {
    // A missing accent is a note, not a zero.
    await page.fill('.rv-input', fold(item.expected));
    await page.keyboard.press('Enter');
    await waitPhase(['feedback']);
    const note = (await page.locator('.rv-grade-note').textContent().catch(() => '')) ?? '';
    check(/accent/i.test(note), `a missing accent gets a note (“${note}”)`);
    check(await page.locator('.rv-verdict.is-right').count(), '…and still counts as right');
    accentChecked = true;
  } else if (!wrongChecked && (item.format === 'recall' || item.format === 'cloze')) {
    // A wrong answer: a hint that points back to the notes, one retry, then the notes' answer.
    await page.fill('.rv-input', 'banana');
    await page.keyboard.press('Enter');
    await waitPhase(['feedback']);
    check(await page.locator('.rv-verdict.is-wrong').count(), 'a wrong answer is marked wrong');
    await page.waitForSelector('.rv-feedback .rv-hint', { timeout: 5000 }).catch(() => undefined);
    const hint = (await page.locator('.rv-feedback .rv-hint').textContent().catch(() => '')) ?? '';
    check(hint.length > 10, `…with a hint back to the notes (“${hint.trim().slice(0, 90)}”)`);
    const leak = item.expected && fold(hint).includes(fold(item.expected));
    check(!leak, '…that doesn’t give the answer away');
    check(!(await page.locator('.rv-notes-say').count()), '…and the answer stays hidden until the retry');
    await page.fill('.rv-retry .rv-input', item.expected ?? '');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.rv-retry-result');
    check(/second try/.test((await page.locator('.rv-retry-result').textContent()) ?? ''), 'the retry is checked');
    check(await page.locator('.rv-notes-say').count(), '…and then the notes’ line is shown');
    await shot(page, 'review-04-retry');
    wrongChecked = true;
  } else if (item.format === 'mcq') {
    await page.click(`.rv-choice >> nth=${item.correct}`);
    await waitPhase(['feedback']);
    check(await page.locator('.rv-verdict.is-right').count(), 'the right choice is marked right');
  } else if (item.format === 'rate') {
    await page.click('.rv-check-btn');
    await waitPhase(['self']);
    check(await page.locator('.rv-notes-say').count(), 'a self-check shows the notes’ line before asking how it went');
    await page.click('.rv-self button:has-text("Got it")');
    await waitPhase(['feedback']);
  } else if (item.format === 'recall' || item.format === 'cloze') {
    await page.fill('.rv-input', item.expected ?? '');
    await page.keyboard.press('Enter');
    await waitPhase(['feedback']);
  } else {
    // Free answers: the note's key points in the student's words → the model grades against them.
    const answer = (item.points ?? [item.fact]).join('; ').replace(/\*\*|==/g, '');
    await page.fill('.rv-input', answer);
    await page.keyboard.press('Enter');
    await waitPhase(['feedback', 'self']);
    if ((await state()).phase === 'self') await page.click('.rv-self button:has-text("Got it")');
    await waitPhase(['feedback']);
    const v = await page.locator('.rv-verdict').getAttribute('class');
    check(/is-right|is-partial/.test(v ?? ''), `a free answer from the notes’ key points is ${/is-right/.test(v ?? '') ? 'right' : 'partly right'} (${item.format})`);
    rubricGraded = true;
  }
  // Every answer ends with the notes' own words and the mastery change.
  check(await page.locator('.rv-mastery-change').count(), `feedback shows the idea’s mastery change (${item.format})`);
  const shown = s.shownAt;
  await page.click('.rv-next');
  await page.waitForFunction((t) => {
    const r = window.__nib.review.getState();
    return !!r.summary || (r.current && r.current.shownAt !== t);
  }, shown);
}
check(!ungrounded.length, `every answer, key point and choice shown is in the notes${ungrounded.length ? `: ${ungrounded.slice(0, 3).join(' | ')}` : ''}`);
check(!napoleon, 'a model-phrased question with a false premise, or with its own answer, is never shown');
console.log(`     formats: ${[...formats].join(', ')} · model-phrased: ${modelPhrased} · classes: ${seq.join(' → ')}`);
check(seq.includes('Calculus I') && seq.includes('Spanish II'), 'questions came from both classes');
let run = 1;
let maxRun = 1;
for (let i = 1; i < seq.length; i++) {
  run = seq[i] === seq[i - 1] ? run + 1 : 1;
  maxRun = Math.max(maxRun, run);
}
check(maxRun <= 2, `interleaved: never 3 in a row from one class (longest run ${maxRun})`);
check(idkChecked && wrongChecked, 'the session covered “I don’t know” and a wrong answer');
if (!accentChecked) console.log('     (no accented answer came up this session)');
if (!rubricGraded) console.log('     (no free-answer question came up this session)');

// ---------------------------------------------------------------- summary
await page.waitForSelector('.rv-summary');
check(/Session complete/.test((await page.locator('.rv-summary-head').textContent()) ?? ''), 'the session ends with a summary');
const rows = await page.locator('.rv-class-row .rv-class-name').allTextContents();
check(rows.includes('Calculus I') && rows.includes('Spanish II'), `…with progress for each class (${rows.join(', ')})`);
check(/next review/.test((await page.locator('.rv-class-meta').first().textContent()) ?? ''), '…and when to come back');
await shot(page, 'review-05-summary');
await page.click('.rv-summary-actions .btn.is-primary');

// ---------------------------------------------------------------- model-phrased questions
// Questions the model phrased were cached only if they passed the checks; the next session uses them.
// Phrasing runs in the background, so wait for it to finish before reading the cache.
await page.waitForFunction(() => !window.__nib.scheduler.busy, null, { timeout: 30000 });
const cached = await page.evaluate(() => Object.values(window.__nib.review.getState().file.questions).flat());
check((await stats()).kinds.includes('mastery-question'), 'the Mastery Engine phrased questions for the higher levels');
check(cached.length > 0 && !cached.some((q) => SLIP.test(q.prompt)), `…and only the ones that passed the checks were kept (${cached.length})`);
const slipped = 3 - (await fetch(`${MOCK}/__mock`).then((r) => r.json())).faults.badQuestions;
check(slipped > 0, `…though the model slipped (${slipped} of its questions were rejected)`);
await page.click('.rv-start');
await page.waitForSelector('.rv-session .rv-card');
let phrased = null;
for (let turn = 0; turn < 15 && !phrased; turn++) {
  const s = await state();
  if (s.summary || !s.item) break;
  if (s.item.origin === 'model') {
    phrased = s.item;
    break;
  }
  await answerRight(s.item);
  // A student takes a moment over each answer; the next questions are phrased meanwhile.
  await page.waitForFunction(() => !window.__nib.scheduler.busy, null, { timeout: 30000 });
  await page.click('.rv-next');
  await page.waitForFunction((t) => {
    const r = window.__nib.review.getState();
    return !!r.summary || (r.current && r.current.shownAt !== t);
  }, s.shownAt);
}
if (phrased) {
  check(await page.locator('.rv-card[data-source="model"]').count(), `a model-phrased question is shown (“${phrased.prompt.slice(0, 70)}”)`);
  const extra = await notInNotes([phrased.fact, ...(phrased.points ?? [])].join(' '), selected);
  check(!extra.length, `…and its answer is the notes’ own text${extra.length ? ` (not in notes: ${extra.join(' ')})` : ''}`);
} else console.log('     (no idea reached the explain level in the second session)');
// Esc in the answer box only leaves the box (a half-typed answer is kept); the next one ends the session.
const running = () => page.evaluate(() => !!window.__nib.review.getState().session);
const endedEarly = await running();
await page.keyboard.press('Escape');
if (await running()) await page.keyboard.press('Escape');
await page.waitForSelector('.rv-summary');
if (endedEarly) check(/Stopped after \d+ question/.test((await page.locator('.rv-summary-head').textContent()) ?? ''), 'a session ended early says it stopped');
await page.click('.rv-summary-actions .btn.is-primary');

// ---------------------------------------------------------------- persistence
const saved = await page.evaluate(() => Object.keys(window.__nib.review.getState().file.states).length);
await page.waitForTimeout(1200);
await page.reload();
await page.waitForSelector('.sidebar');
await page.waitForFunction(() => window.__nib.review.getState().loaded, null, { timeout: 10000 });
const reloaded = await page.evaluate(() => {
  const f = window.__nib.review.getState().file;
  return { states: Object.keys(f.states).length, sessions: f.sessions.length };
});
check(reloaded.states === saved && saved > 0, `what was learned is saved with the vault (${reloaded.states}/${saved} ideas)`);
check(reloaded.sessions >= 1, '…and so is the session');
await page.click('.nav-item:has-text("Review")');
await page.waitForSelector('.rv-tree');
await page.click('.rv-row.is-group:has-text("Calculus I")');
check(await page.locator('.rv-row.is-note .rv-mastery').count(), 'the picker shows how well each reviewed note is known');

// ---------------------------------------------------------------- entry points
await page.click('.tree-row:has-text("Calculus I")', { button: 'right' });
check(await page.locator('.context-menu :text("Review this class")').count(), 'a class can be reviewed from the sidebar');
await page.keyboard.press('Escape');

const real = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(e));
check(!real.length, `no page errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
