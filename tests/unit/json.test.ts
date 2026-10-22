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
