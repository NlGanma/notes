import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicConcepts, notReviewable, type Concept } from '../../src/lib/review/concepts';
import { assertGroundedItem, blankOut, buildItem, mulberry32, validateQuestion, type BuildCtx } from '../../src/lib/review/items';
import { gradeShort, isDontKnow, normalizeTex, quickRubric, scoreRubric } from '../../src/lib/review/grade';
import { chunkNote } from '../../src/lib/ai/rag';
import { DAY, freshState, isMastered, recordAnswer } from '../../src/lib/review/mastery';
import { buildSeedNotes } from '../../src/lib/vault/seed';

const seed = buildSeedNotes();
const byTitle = (t: string) => seed.find((n) => n.meta.title.startsWith(t))!;
const vocabNote = byTitle('Vocabulario');
const pretNote = byTitle('Pretérito');
const calcNote = byTitle('Lecture 4');
const vocab = heuristicConcepts(vocabNote, { languageClass: true });
const pret = heuristicConcepts(pretNote, { languageClass: true });
const calc = heuristicConcepts(calcNote);
const chunkOf = (noteId: string, c: Concept) =>
  chunkNote(seed.find((n) => n.meta.id === noteId)!).find((ch) => ch.hash === c.chunkHash)!.text;
const ctxFor = (c: Concept, siblings: Concept[], o: Partial<BuildCtx> = {}): BuildCtx => ({
  title: 'Notes',
  siblings,
  avoid: [],
  rng: mulberry32(1),
  chunkText: chunkOf(c.noteId, c),
  ...o,
});

test('ideas are read from the note’s own structure, with the note’s words as keys', () => {
  const ninez = vocab.find((c) => c.name === 'la niñez')!;
  assert.equal(ninez.kind, 'vocab');
  assert.deepEqual(
    ninez.facts.map((f) => f.key),
    ['la niñez', 'childhood'],
  );
  const preterite = pret.find((c) => c.name === 'El pretérito')!;
  assert.equal(preterite.kind, 'rule');
  assert.ok(preterite.facts.some((f) => f.example), 'an example sentence is kept as an example');
  assert.ok(preterite.facts.some((f) => f.key === '-é, -aste, -ó, -amos, -aron'));
  assert.ok(calc.find((c) => c.name === 'Squeeze theorem')?.exam, 'what the teacher flagged for the exam is marked');
  // Every fact is a span of the note itself.
  for (const c of [...vocab, ...pret, ...calc]) for (const f of c.facts) assert.ok(chunkOf(c.noteId, c).includes(f.text.slice(0, 20)) || f.fromInk, `${c.name}: ${f.text}`);
});

test('handwriting that is not transcribed yet is not reviewable (nothing to check answers against)', () => {
  assert.deepEqual(notReviewable(calcNote), ['Worked example (in class)']);
  assert.ok(!calc.some((c) => c.facts.some((f) => /not transcribed/.test(f.text))));
});

test('a vocabulary item asks for the note’s own word and accepts the note’s own alternatives', () => {
  const guarderia = vocab.find((c) => c.name === 'la guardería')!;
  const toSpanish = buildItem(guarderia, 0, ctxFor(guarderia, vocab, { firstExposure: false }));
  assert.equal(toSpanish.format, 'recall');
  assert.match(toSpanish.prompt, /daycare \/ nursery school/);
  assert.equal(toSpanish.expected, 'la guardería');
  // Asked again, the other direction.
  const toEnglish = buildItem(guarderia, 0, ctxFor(guarderia, vocab, { firstExposure: false, avoid: [toSpanish.key] }));
  assert.equal(toEnglish.expected, 'daycare / nursery school');
  assert.deepEqual(toEnglish.accept, ['daycare', 'nursery school']);
  for (const item of [toSpanish, toEnglish]) assert.ok(assertGroundedItem(item, chunkOf(guarderia.noteId, guarderia)));
  // Two different questions, so a word can be mastered (mastery needs two different items right).
  assert.notEqual(toSpanish.key, toEnglish.key);
  let st = freshState(0);
  for (const [i, it] of [toSpanish, toEnglish, toSpanish].entries())
    st = recordAnswer(st, { s: 1, graded: 'typed', level: it.level, key: it.key, conf: 'sure' }, guarderia.cap, i * DAY * 2);
  assert.ok(isMastered(st, guarderia.cap));
});

test('multiple choice on first exposure: every choice is a key from the notes', () => {
  const c = vocab.find((x) => x.name === 'el juguete')!;
  const siblings = vocab.filter((x) => x !== c);
  const sibTexts = siblings.flatMap((s) => s.facts.map((f) => f.text));
  for (const first of [true, false]) {
    const item = buildItem(c, 0, ctxFor(c, siblings, { firstExposure: first }));
    assert.ok(assertGroundedItem(item, chunkOf(c.noteId, c), sibTexts), `${item.format} is grounded`);
    if (item.choices) {
      assert.equal(item.choices.length, 4);
      assert.ok(item.choices.includes(item.expected!));
      assert.equal(item.choices[item.correct!], item.expected);
    }
  }
});

test('the grounding invariant rejects an item whose answer the notes don’t contain', () => {
  const c = vocab.find((x) => x.name === 'el juguete')!;
  const item = buildItem(c, 0, ctxFor(c, vocab, { firstExposure: false }));
  const text = chunkOf(c.noteId, c);
  assert.ok(assertGroundedItem(item, text));
  assert.ok(!assertGroundedItem({ ...item, expected: 'a wooden toy train' }, text), 'an invented answer key');
  assert.ok(!assertGroundedItem({ ...item, fact: 'Toys were invented in 1850.' }, text), 'an invented “your notes say”');
  assert.ok(!assertGroundedItem({ ...item, choices: ['toy', 'Napoleon'] }, text), 'an invented choice');
});

test('a blank never hides most of a line, and leaves enough to know what is asked', () => {
  const f = { id: 'f', text: 'The **imperfect** describes ongoing or repeated past actions.', key: 'imperfect', example: false, fromInk: false, item: false };
  assert.equal(blankOut(f), 'The _____ describes ongoing or repeated past actions.');
  assert.equal(blankOut({ ...f, text: 'Imperfect tense here.', key: 'Imperfect tense here' }), null);
  assert.equal(blankOut({ ...f, text: 'The imperfect.', key: 'imperfect' }), null);
  assert.equal(blankOut({ ...f, key: 'not in the line' }), null);
});

test('higher levels come from the notes too: explain, apply with the note’s example, capped by what the notes hold', () => {
  const c = pret.find((x) => x.name === 'El pretérito')!;
  const explain = buildItem(c, 1, ctxFor(c, pret));
  assert.equal(explain.format, 'explain');
  assert.ok(explain.points!.length >= 1);
  const apply = buildItem(c, 2, ctxFor(c, pret));
  assert.equal(apply.format, 'apply');
  assert.match(apply.prompt, /Your notes give this example/);
  for (const it of [explain, apply]) assert.ok(assertGroundedItem(it, chunkOf(c.noteId, c), pret.flatMap((s) => s.facts.map((f) => f.text))), it.format);
  // Vocabulary is capped at recall: asking for level 3 still gives a level-0 item.
  const v = vocab[0];
  assert.equal(buildItem(v, 3, ctxFor(v, vocab)).level, 0);
});

test('a model-phrased question is used only if the passage answers it, it gives nothing away and adds nothing', () => {
  const c = pret.find((x) => x.name === 'El pretérito')!;
  const text = chunkOf(c.noteId, c);
  const item = buildItem(c, 1, ctxFor(c, pret));
  const line = text.split('\n').find((l) => /-é, -aste/.test(l))!;
  const proof = line.replace(/^[-*]\s+/, '').split(/\s+/).slice(0, 8).join(' ');
  const good = validateQuestion({ question: 'In your own words, when do your notes say to use El pretérito?', proof, keyPoints: [] }, item, text, c.name);
  assert.ok(good, 'a fair question is accepted');
  assert.equal(good!.origin, 'model');
  assert.ok(text.replace(/\*\*/g, '').includes(good!.fact.replace(/\*\*/g, '').slice(0, 30)), 'the answer shown is the note’s own line');
  const bad = (question: string, p = proof) => validateQuestion({ question, proof: p, keyPoints: [] }, item, text, c.name);
  assert.equal(bad('What did Napoleon say about El pretérito in 1805?'), null, 'a false premise (a name and a year the notes don’t have)');
  assert.equal(bad('In your own words, what does El pretérito mean?', 'Plants turn sunlight into sugar using chlorophyll'), null, 'a proof that is not in the passage');
  assert.equal(bad('Why do the endings matter here?'), null, 'a question about something other than the idea');
  assert.equal(bad('ok?'), null, 'too short to be a question');
  // Applying the idea: the question quotes the note's example (the idea's name would be the answer).
  const apply = buildItem(c, 2, ctxFor(c, pret));
  const example = apply.source.text.replace(/\*\*/g, '');
  const ok = validateQuestion({ question: `Which idea from your notes does this example show, and why? “${example}”`, proof, keyPoints: [] }, apply, text, c.name);
  assert.ok(ok, 'an apply question that quotes the example is accepted');
  assert.equal(ok!.fact, apply.fact, '…and the answer shown is the idea, not the example');
  assert.notEqual(apply.fact, apply.source.text);
});

test('short answers: accents, articles and spelling get a note, not a zero', () => {
  assert.deepEqual(gradeShort('veia', 'veía', { language: true }), { s: 0.8, note: 'Check the accent: “veía”' });
  assert.deepEqual(gradeShort('juguete', 'el juguete', { language: true }), { s: 0.8, note: 'Include the article: “el juguete”' });
  assert.equal(gradeShort('mitocondria', 'Mitochondria').s, 1);
  assert.equal(gradeShort('-aron, -amos, -é, -aste, -ó', '-é, -aste, -ó, -amos, -aron', { language: true }).s, 1, 'a list in another order');
  assert.equal(gradeShort('-é, -aste', '-é, -aste, -ó, -amos, -aron', { language: true }).s, 0.4, 'part of a list');
  assert.equal(gradeShort('nursery school', 'daycare / nursery school', { accept: ['daycare', 'nursery school'] }).s, 1);
  assert.equal(gradeShort('banana', 'el juguete', { language: true }).s, 0);
  assert.equal(normalizeTex('\\dfrac{a}{ b }'), normalizeTex('\\frac a b'));
  assert.equal(gradeShort('$\\dfrac{x}{ 2 }$', '$\\frac{x}{2}$').s, 1);
});

test('“I don’t know” is an answer, not a guess to grade', () => {
  for (const a of ['', 'idk', 'I don’t know', "i don't know.", 'no sé', 'no lo sé', 'not sure', '?']) assert.ok(isDontKnow(a), a);
  assert.ok(!isDontKnow('the imperfect'));
});

test('free answers are scored against the note’s key points; the grader must quote the student', () => {
  const points = ['the imperfect sets the scene'];
  const fact = 'the imperfect sets the scene and the preterite interrupts it';
  assert.equal(quickRubric('If g is less than f and f less than h near a and lim g equals lim h equals L then lim f = L', ['If g(x) ≤ f(x) ≤ h(x) near a and lim g = lim h = L, then lim f = L.'])?.s, 1);
  // A "yes" backed by words that have nothing to do with the point proves nothing.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'bananas are yellow' }] }, points, 'bananas are yellow fruit', fact).s, 0);
  // A "yes" with no quote from the answer counts half.
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: '' }] }, points, 'the imperfect is for scenes', fact).s, 0.5);
  assert.equal(scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'imperfect sets the scene' }] }, points, 'The imperfect sets the scene.', fact).s, 1);
  // Contradicting the notes costs.
  assert.equal(
    scoreRubric({ points: [{ n: 1, hit: 'yes', quote: 'imperfect sets the scene' }], contradicts: 'the preterite sets the scene too' }, points, 'The imperfect sets the scene, the preterite sets the scene too.', fact).s,
    0.75,
  );
});
