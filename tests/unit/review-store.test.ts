import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useVault } from '../../src/state/vault';
import { useAI } from '../../src/state/ai';
import { conceptsOf, factOf, useReview } from '../../src/state/review';
import { buildSeedNotes, SEED_CLASSES } from '../../src/lib/vault/seed';
import { isReviewable } from '../../src/lib/review/tree';
import { buildItem, hintFor, mulberry32, type Item } from '../../src/lib/review/items';
import { chunkNote } from '../../src/lib/ai/rag';
import { DAY, freshState, isMastered, type Confidence, type Level } from '../../src/lib/review/mastery';
import type { NoteDoc, VaultBackend } from '../../src/lib/vault/types';

/** The Review store driven the way a student would, on the demo notes, with the model offline. */

const clock = { now: Date.UTC(2026, 9, 1, 9) };
Date.now = () => clock.now;

const backend: VaultBackend = {
  kind: 'browser',
  label: 'memory',
  load: async () => ({ notes: [], folders: [], folderMeta: {} }),
  saveNote: async () => undefined,
  deleteNote: async () => undefined,
  createFolder: async () => undefined,
  renameFolder: async () => undefined,
  deleteFolder: async () => undefined,
  saveFolderMeta: async () => undefined,
  readKV: async () => null,
  writeKV: async () => undefined,
};

const review = () => useReview.getState();
const notes = () => useVault.getState().notes;
const byTitle = (t: string) => Object.values(notes()).find((n) => n.meta.title.startsWith(t))!;

beforeEach(() => {
  const seed = buildSeedNotes();
  useVault.setState({
    backend,
    notes: Object.fromEntries(seed.map((n) => [n.meta.id, n])),
    folders: [...new Set(seed.map((n) => n.meta.folder).filter(Boolean))],
    folderMeta: SEED_CLASSES,
    ready: true,
  });
  useAI.setState({ status: 'offline', chatModel: '' });
  useReview.setState({
    loaded: true,
    file: { version: 1, modelConcepts: {}, extracted: {}, states: {}, questions: {}, bad: [], sessions: [] },
    session: null,
    current: null,
    summary: null,
    opts: { length: 15, mix: true, askConfidence: true },
  });
});

/** Answers the current question: right (the notes' own answer) or wrong. */
async function answer(right: boolean, conf: Confidence | null = 'unsure') {
  const it = review().current!.item;
  clock.now += 20_000;
  if (it.format === 'mcq') review().choose(right ? it.correct! : (it.correct! + 1) % it.choices!.length, conf);
  else if (it.format === 'rate') {
    await review().submit('(self-check)', conf);
    review().selfGrade(right ? 1 : 0);
  } else if (it.format === 'cloze' || it.format === 'recall') await review().submit(right ? it.expected! : 'banana', conf);
  else {
    await review().submit(right ? (it.points ?? [it.fact]).join('; ').replace(/\*\*|==/g, '') : 'banana split', conf);
    if (review().current?.phase === 'self') review().selfGrade(right ? 1 : 0);
  }
}

function editNote(n: NoteDoc, edit: (content: NoteDoc['content']) => void) {
  const content = structuredClone(n.content);
  edit(content);
  useVault.setState({ notes: { ...notes(), [n.meta.id]: { ...n, content } } });
}

test('a student who knows everything masters every idea in the notes, however few questions its notes allow', async () => {
  const ids = Object.values(notes())
    .filter(isReviewable)
    .map((n) => n.meta.id);
  const asks: Record<string, number> = {};
  for (let day = 0; day < 12; day++) {
    review().setOpts({ length: 25 });
    review().start(ids);
    while (review().session && review().current) {
      asks[review().current!.concept.id] = (asks[review().current!.concept.id] ?? 0) + 1;
      await answer(true, 'sure');
      review().next();
    }
    review().closeSummary();
    clock.now += DAY;
  }
  const { states } = review().file;
  const all = ids.flatMap((id) => conceptsOf(notes()[id]));
  const unmastered = all.filter((c) => !states[c.id] || !isMastered(states[c.id], c.cap, c.needs)).map((c) => c.name);
  assert.deepEqual(unmastered, []);
  assert.ok(Math.max(...Object.values(asks)) <= 10, `no idea is asked endlessly (${Math.max(...Object.values(asks))})`);
});

test('a session moves on when its notes change under it (an idea renamed or removed)', async () => {
  const calc = byTitle('Lecture 4');
  review().start([calc.meta.id]);
  await answer(true);
  editNote(calc, (doc) => {
    const walk = (node: NoteDoc['content']) => {
      if (node.type === 'heading') for (const t of node.content ?? []) if (t.text) t.text += ' (rev)';
      node.content?.forEach(walk);
    };
    walk(doc);
  });
  const live = new Set(conceptsOf(notes()[calc.meta.id]).map((c) => c.id));
  for (let i = 0; i < 4 && review().session; i++) {
    const before = review().current!.shownAt;
    clock.now += 1000;
    review().next();
    if (!review().session) break;
    assert.notEqual(review().current!.shownAt, before, 'Next shows another question');
    assert.ok(live.has(review().current!.concept.id), 'one about the notes as they are now');
    assert.ok(review().session!.working.every((id) => live.has(id)), 'nothing stale is kept in the working set');
    await answer(true);
  }
});

test('asking to review other notes mid-session ends it, but its summary stays on screen; the picker shows the new notes after', async () => {
  // (The vault's file is read once, so reading the picked notes in the background later changes nothing here.)
  await review().load();
  const calc = byTitle('Lecture 4');
  const vocab = byTitle('Vocabulario');
  review().start([calc.meta.id]);
  await answer(true);
  review().next();
  await answer(false);
  review().request([vocab.meta.id]);
  assert.equal(review().session, null);
  assert.equal(review().summary?.items, 2, 'the session’s summary is on screen');
  assert.deepEqual(review().selection, [vocab.meta.id]);
  review().closeSummary();
  assert.equal(review().summary, null);
  assert.deepEqual(review().selection, [vocab.meta.id], 'then the notes asked for are picked');
  // Nothing answered yet: nothing to sum up.
  review().start([calc.meta.id]);
  review().request([vocab.meta.id]);
  assert.equal(review().session, null);
  assert.equal(review().summary, null);
  // A summary already seen makes way.
  review().start([calc.meta.id]);
  await answer(true);
  review().end();
  assert.ok(review().summary);
  review().request([calc.meta.id]);
  assert.equal(review().summary, null);
  assert.deepEqual(review().selection, [calc.meta.id]);
});

test('a session ended early says it stopped; one that ran its course is complete', async () => {
  const calc = byTitle('Lecture 4');
  review().setOpts({ length: 10 });
  review().start([calc.meta.id]);
  await answer(true);
  review().next();
  await answer(true);
  review().end();
  assert.equal(review().summary!.items, 2);
  assert.equal(review().summary!.stopped, true);
  review().closeSummary();
  review().start([calc.meta.id]);
  while (review().session && review().current) {
    await answer(true);
    review().next();
  }
  assert.ok(review().summary);
  assert.ok(!review().summary!.stopped);
});

test('a note trashed mid-session drops out of it', async () => {
  const calc = byTitle('Lecture 4');
  const cells = byTitle('Cell Structure');
  review().start([calc.meta.id, cells.meta.id]);
  useVault.setState({ notes: { ...notes(), [cells.meta.id]: { ...cells, meta: { ...cells.meta, trashed: Date.now() } } } });
  for (let i = 0; i < 6 && review().session; i++) {
    await answer(true);
    review().next();
    if (review().current) assert.equal(review().current!.concept.noteId, calc.meta.id);
  }
});

test('“I was right” recounts the answer as right: no re-ask, no miss, and out of the working set once mastered', async () => {
  const pret = byTitle('Pretérito');
  const c = conceptsOf(pret).find((x) => x.name === 'El pretérito')!;
  // One more right answer masters it; it's asked as a fill-in, which code grades.
  const st = { ...freshState(clock.now), p: 0.99, attempts: 6, correct: 5, best: 2, level: 0 as const, codeCorrect: 2, correctKeys: ['a', 'b'], last: clock.now - 1000, due: clock.now };
  useReview.setState({ file: { ...review().file, states: { [c.id]: st } } });
  review().start([pret.meta.id]);
  assert.equal(review().current!.concept.id, c.id);
  assert.equal(review().current!.item.graded, 'typed');
  await answer(false, 'sure');
  assert.equal(review().misconceptions.length, 1);
  review().override();
  const sess = review().session!;
  assert.ok(review().current!.feedback!.mastered);
  assert.ok(!sess.working.includes(c.id), 'a mastered idea leaves room for the next one');
  assert.ok(!sess.reask.some((r) => r.c === c.id));
  assert.equal(sess.misses[c.id] ?? 0, 0);
  assert.equal(sess.history.at(-1)!.s, 0.8);
  assert.equal(review().misconceptions.length, 0, 'it was no misconception');
});

test('“I was right” is only for an answer the student wrote and someone else graded', async () => {
  const counted = () => review().session!.history.at(-1)!.s;
  // "I don't know", pressed or typed: the answer is shown as the answer, and nothing can be overridden.
  ask('Pretérito', 'El pretérito', 0, preterite);
  review().dontKnow();
  assert.ok(review().current!.dontKnow);
  review().override();
  assert.ok(!review().current!.overridden && counted() === 0 && review().overrides === 0, 'after “I don’t know”');
  ask('Pretérito', 'El pretérito', 0, preterite);
  await review().submit('no sé', 'sure');
  assert.ok(review().current!.dontKnow);
  assert.ok(!review().current!.feedback!.hypercorrect, 'not knowing, with “Sure” on, is no mix-up');
  assert.deepEqual(review().misconceptions, []);
  review().override();
  assert.ok(!review().current!.overridden, 'after typing “no sé”');
  // The student said how it went themselves.
  ask('Lecture 4', 'Limit laws', 0, (it) => it.format === 'rate');
  await review().submit('', 'sure');
  review().selfGrade(0);
  assert.ok(review().current!.selfGraded);
  review().override();
  assert.ok(!review().current!.overridden, 'after a self-check');
  // A typed answer code marked wrong can be.
  ask('Pretérito', 'El pretérito', 0, preterite);
  await review().submit('imperfect', 'unsure');
  assert.ok(!review().current!.dontKnow && !review().current!.selfGraded);
  review().override();
  assert.ok(review().current!.overridden);
  assert.equal(review().current!.feedback!.verdict, 'right');
});

test('a reported question can be taken back', async () => {
  const vocab = byTitle('Vocabulario');
  review().start([vocab.meta.id]);
  const key = review().current!.item.key;
  await answer(false);
  review().report();
  assert.ok(review().file.bad.includes(key));
  assert.notEqual(review().current?.item.key, key, 'the session moved on');
  review().unreport(key);
  assert.ok(!review().file.bad.includes(key), 'it can be asked again');
});

test('Report undoes the answer and the question is never asked again, in any phrasing', async () => {
  const vocab = byTitle('Vocabulario');
  review().start([vocab.meta.id]);
  const cur = review().current!;
  const before = review().file.states[cur.concept.id];
  // A phrasing the model wrote for this item, cached earlier.
  const cacheKey = `${cur.item.key}#${cur.concept.chunkHash}`;
  useReview.setState({ file: { ...review().file, questions: { [cacheKey]: [{ prompt: 'Which word means childhood?', points: [], fact: cur.item.fact }] } } });
  await answer(false, 'sure');
  assert.equal(review().session!.misses[cur.concept.id], 1);
  review().report();
  const sess = review().session!;
  assert.equal(sess.history.length, 0, 'the answer is not counted');
  assert.equal(sess.misses[cur.concept.id] ?? 0, 0);
  assert.ok(!sess.reask.some((r) => r.c === cur.concept.id));
  assert.equal(review().misconceptions.length, 0);
  assert.deepEqual(review().file.states[cur.concept.id], before);
  assert.equal(review().file.questions[cacheKey], undefined, 'its cached phrasing is gone');
  // However long the session runs, that item never comes back.
  for (let i = 0; i < 30 && review().session; i++) {
    assert.notEqual(review().current!.item.key, cur.item.key);
    await answer(i % 3 !== 0);
    review().next();
  }
  review().end();
  assert.ok(!review().summary || review().summary!.items >= 0);
});

test('when nothing else is due, a learned idea is reviewed instead of the same one asked twice in a row', async () => {
  const vocab = byTitle('Vocabulario');
  const cs = conceptsOf(vocab);
  const target = cs[0];
  // Everything else was learned and isn't due for days.
  const learned = { ...freshState(clock.now), p: 0.99, attempts: 4, correct: 4, streak: 4, best: 0, codeCorrect: 4, correctKeys: ['a', 'b'], last: clock.now - DAY, due: clock.now + 5 * DAY, interval: 7 };
  useReview.setState({ file: { ...review().file, states: Object.fromEntries(cs.slice(1).map((c) => [c.id, learned])) } });
  review().start([vocab.meta.id]);
  const seq: string[] = [];
  for (let i = 0; i < 8 && review().session; i++) {
    seq.push(review().current!.concept.id);
    await answer(review().current!.concept.id !== target.id);
    review().next();
  }
  assert.equal(seq[0], target.id);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `asked twice in a row at ${i}`);
});

test('a right answer after a hint comes back later in the session, without the hint', async () => {
  const calc = byTitle('Lecture 4');
  review().start([calc.meta.id]);
  for (let i = 0; i < 6 && review().current!.item.format === 'mcq'; i++) {
    await answer(true);
    review().next();
  }
  const c = review().current!.concept;
  review().showHint();
  await answer(true);
  const fb = review().current!.feedback!;
  assert.equal(fb.verdict, 'right');
  assert.match(fb.note ?? '', /hint/);
  assert.ok(review().session!.reask.some((r) => r.c === c.id), 'it is asked again later');
  assert.ok(review().session!.history.at(-1)!.s < 0.8, 'and counted as partly known');
});

/** Puts one question about an idea on screen: the first item `want` accepts among those its notes allow at `level`. */
function ask(title: string, name: string, level: Level, want: (it: Item) => boolean = () => true, firstExposure = false): Item {
  const note = byTitle(title);
  review().start([note.meta.id]);
  const cs = conceptsOf(note);
  const c = cs.find((x) => x.name === name)!;
  const chunkText = chunkNote(note).find((ch) => ch.hash === c.chunkHash)!.text;
  const avoid: string[] = [];
  for (let i = 0; i < 10; i++) {
    const item = buildItem(c, level, { title: note.meta.title, siblings: cs.filter((x) => x !== c), avoid, rng: mulberry32(1), firstExposure, chunkText });
    if (want(item)) {
      const current = { item, concept: c, phase: 'ask' as const, hintUsed: false, revealed: false, firstInSession: true, wasDue: false, stateBefore: freshState(clock.now), shownAt: clock.now };
      useReview.setState({ current, misconceptions: [] });
      return item;
    }
    avoid.push(item.key);
  }
  throw new Error(`no such question about ${name}`);
}

const lastGraded = (item: Item) => review().file.states[item.conceptId]?.recent.at(-1)?.graded;
const preterite = (it: Item) => it.format === 'cloze' && it.expected === 'preterite';

test('Hint, and the cue after a miss, point back to the notes without the answer', async () => {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase();
  for (const [title, name, want] of [
    ['Cell Structure', 'Nucleus', (it: Item) => it.format === 'recall'],
    ['Pretérito', 'El pretérito', preterite],
    ['Pretérito', 'El pretérito', (it: Item) => it.expected === '-é, -aste, -ó, -amos, -aron'],
    ['Lecture 4', 'Squeeze theorem', (it: Item) => it.format === 'cloze' && /\$/.test(it.expected ?? '')],
    ['Vocabulario', 'portarse bien / mal', (it: Item) => it.expected === 'portarse bien / mal'],
  ] as const) {
    const item = ask(title, name, 0, want);
    const c = review().current!.concept;
    const f = factOf(item, c);
    review().showHint();
    const hint = review().current!.hint!;
    assert.equal(hint, hintFor(item, f));
    await review().submit('banana', 'sure');
    const cue = review().current!.hint!;
    assert.equal(cue, hintFor(item, f, true), 'offline, the cue is code’s');
    for (const h of [hint, cue]) {
      assert.ok(!fold(h).includes(fold(item.expected!)), `${h} gives away ${item.expected}`);
      assert.ok(!fold(h).includes(fold(item.expected!.split(/[,/]/)[0])), `${h} gives away part of ${item.expected}`);
      assert.ok(!/What do your notes say about/.test(h), 'the idea isn’t named when its name is the answer');
    }
  }
});

test('a typed answer that only repeats what the question shows is wrong, however long', async () => {
  for (const [answer, verdict] of [
    ['Use the _____ for completed actions with a clear beginning or end', 'wrong'],
    ['completed actions with a clear beginning or end', 'wrong'],
    ['the imperfect for completed actions with a clear beginning or end', 'wrong'],
    ['The preterite is for completed actions with a clear beginning or end', 'right'],
  ] as const) {
    const item = ask('Pretérito', 'El pretérito', 0, preterite);
    await review().submit(answer, 'sure');
    assert.equal(review().current!.feedback!.verdict, verdict, answer);
    if (verdict === 'wrong') assert.equal(lastGraded(item), 'typed', 'graded as the typed answer it is');
  }
  for (const [title, name, answer, verdict] of [
    ['Cell Structure', 'Mitochondria', 'site of cellular respiration; make ATP. Have their own DNA (endosymbiotic theory).', 'wrong'],
    ['Cell Structure', 'Mitochondria', 'Ribosomes — site of cellular respiration; make ATP. Have their own DNA (endosymbiotic theory).', 'wrong'],
    ['French Revolution', 'June 1789', 'Tennis Court Oath; National Assembly formed.', 'wrong'],
    ['French Revolution', 'June 1789', 'It was June 1789: the Tennis Court Oath, when the National Assembly formed.', 'right'],
  ] as const) {
    ask(title, name, 0, (it) => it.format === 'recall');
    await review().submit(answer, 'unsure');
    assert.equal(review().current!.feedback!.verdict, verdict, `${name}: ${answer}`);
  }
});

test('a second try is graded the way the first one is', async () => {
  ask('Pretérito', 'El pretérito', 0, preterite);
  await review().submit('perfect', 'unsure');
  await review().retry('The preterite is for completed actions with a clear beginning or end');
  assert.equal(review().current!.retry!.s, 1, 'the line with the right word in it');
  ask('Pretérito', 'El pretérito', 0, preterite);
  await review().submit('perfect', 'unsure');
  await review().retry('Use the _____ for completed actions with a clear beginning or end');
  assert.equal(review().current!.retry!.s, 0, 'the line it shows');
  // Code can't tell and there's no model: the notes are shown to compare with, with no verdict.
  ask('French Revolution', 'Tax system', 1);
  await review().submit('taxes', 'unsure');
  await review().retry('The clergy and the nobles were mostly exempt from taxes, so the burden fell on the commoners of the Third Estate.');
  assert.equal(review().current!.retry!.s, undefined);
  assert.ok(review().current!.revealed);
});

test('a second try the code can’t decide is checked by the model', async () => {
  const tasks: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content: string }[] };
    const task = /^Task: (\w+)/.exec(body.messages?.at(-1)?.content ?? '')?.[1] ?? '?';
    tasks.push(task);
    const reply =
      task === 'grade' ? { points: [{ n: 1, hit: 'yes', quote: 'the burden fell on the commoners of the Third Estate' }] } : task === 'nudge' ? { nudge: 'Who paid?' } : { skip: true };
    const nd = `${JSON.stringify({ message: { content: JSON.stringify(reply) }, done: false })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`;
    return new Response(nd, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }) as typeof fetch;
  try {
    useAI.setState({ status: 'online', chatModel: 'stub', provider: 'ollama', baseUrl: 'http://stub.invalid', models: [] });
    ask('French Revolution', 'Tax system', 1);
    await review().submit('taxes', 'unsure');
    assert.equal(review().current!.feedback!.verdict, 'wrong');
    await review().retry('The clergy and the nobles were mostly exempt from taxes, so the burden fell on the commoners of the Third Estate.');
    assert.ok(tasks.includes('grade'), `the model was asked (${tasks.join(', ')})`);
    assert.equal(review().current!.retry!.s, 1);
    assert.equal(review().current!.phase, 'feedback', 'the feedback stays on screen while it checks');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('“How sure?” counts when a choice is answered with the number keys', () => {
  const item = ask('Pretérito', 'El pretérito', 0, (it) => it.format === 'mcq', true);
  review().setConf('sure');
  // What 1–4 do: choose, with the pick kept with the question.
  review().choose((item.correct! + 1) % item.choices!.length, review().current!.conf ?? null);
  assert.equal(review().file.states[item.conceptId].recent.at(-1)!.conf, 'sure');
  assert.ok(review().current!.feedback!.hypercorrect, 'sure and wrong');
  // Once answered, the pick no longer changes.
  review().setConf('guess');
  assert.equal(review().current!.conf, 'sure');
});

test('a self-check has no written answer: none is shown or kept', async () => {
  const item = ask('Lecture 4', 'Limit laws', 0, (it) => it.format === 'rate');
  await review().submit('(self-check)', 'sure');
  assert.equal(review().current!.phase, 'self');
  review().selfGrade(0);
  assert.equal(review().current!.answer, undefined);
  assert.deepEqual(review().misconceptions, []);
  assert.equal(review().file.states[item.conceptId].misconception, undefined);
});

test('naming the idea an example shows, and being sure of it, is not a misconception', async () => {
  for (const answer of ['El pretérito', 'the preterite']) {
    const item = ask('Pretérito', 'El pretérito', 2, (it) => it.format === 'apply');
    await review().submit(answer, 'sure');
    // No model: the student compares with the notes.
    assert.equal(review().current!.phase, 'self', answer);
    review().selfGrade(0);
    assert.ok(!review().current!.feedback!.hypercorrect, answer);
    assert.deepEqual(review().misconceptions, [], answer);
    assert.equal(review().file.states[item.conceptId].misconception, undefined, answer);
  }
  // A wrong idea, sure, still is one.
  const item = ask('Pretérito', 'El pretérito', 2, (it) => it.format === 'apply');
  await review().submit('banana', 'sure');
  assert.equal(review().misconceptions.length, 1);
  assert.equal(review().file.states[item.conceptId].misconception, 'banana');
});
