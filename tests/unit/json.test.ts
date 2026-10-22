import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJSONLoose } from '../../src/lib/ai/json';
import { parseStudyJSON } from '../../src/lib/ai/study';

test('JSON is found inside fences and chatter', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Sure! Here you go: {"a": [1,2]} Hope it helps.'), { a: [1, 2] });
  assert.deepEqual(parseJSONLoose('["x","y"]'), ['x', 'y']);
  assert.equal(parseJSONLoose('no json at all'), null);
});

test('flashcards accept the shapes small models produce', () => {
  const a = parseStudyJSON('flashcards', '{"cards":[{"front":"Q","back":"A","source":2}]}');
  assert.deepEqual(a, { kind: 'flashcards', cards: [{ front: 'Q', back: 'A', source: 2 }] });
  const b = parseStudyJSON('flashcards', '[{"question":"Q","answer":"A"}]');
  assert.equal(b?.kind, 'flashcards');
  assert.equal(parseStudyJSON('flashcards', '{"cards":[{"front":"only front"}]}'), null);
});

test('quiz answers may be indices or letters; invalid questions are dropped', () => {
  const q = parseStudyJSON('quiz', '{"questions":[{"q":"1+1?","choices":["1","2","3"],"answer":"B"},{"q":"bad","choices":["x"],"answer":0}]}');
  assert.equal(q?.kind, 'quiz');
  if (q?.kind === 'quiz') {
    assert.equal(q.questions.length, 1);
    assert.equal(q.questions[0].answer, 1);
  }
});

test('LaTeX backslashes swallowed by JSON escapes are put back', async () => {
  const { parseJSONLoose } = await import('../../src/lib/ai/json');
  // What a model typically writes: single backslashes inside JSON strings.
  const v = parseJSONLoose<{ back: string }>('{"back":"$\\frac{a}{b}$, $\\theta$, $\\nabla f$, $\\beta$, $\\rho$, \\\\sin x"}');
  assert.equal(v?.back, '$\\frac{a}{b}$, $\\theta$, $\\nabla f$, $\\beta$, $\\rho$, \\sin x');
  // Real line breaks and tabs stay.
  assert.equal(parseJSONLoose<{ t: string }>('{"t":"line one\\nequals two\\tnext"}')?.t, 'line one\nequals two\tnext');
});

test('study items are kept only when an excerpt backs the answer', async () => {
  const { verifyStudy } = await import('../../src/lib/ai/study');
  const excerpts = new Map([
    [1, { n: 1, text: 'Mitochondria — site of cellular respiration; make ATP.', title: 'Cells', section: 'Organelles' }],
    [2, { n: 2, text: 'If g ≤ f ≤ h near a and lim g = lim h = L, then lim f = L.', title: 'Lecture 4', section: 'Squeeze theorem' }],
  ]);
  const ctx = { excerpts, context: '', mode: 'explain' as const };
  const v = verifyStudy(
    {
      kind: 'flashcards',
      cards: [
        { front: 'What do mitochondria make?', back: 'ATP, through cellular respiration', source: 2 },
        { front: 'Who discovered mitochondria?', back: 'Richard Altmann in 1890', source: 1 },
      ],
    },
    ctx,
  );
  const cards = JSON.parse(v.json).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].source, 1, 'the card is re-sourced to the excerpt that says it');
  assert.equal(v.dropped, 1);
});
