import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewTree, selectionLabel } from '../../src/lib/review/tree';
import { BKT, bktUpdate, DAY, freshState, isMastered, percent, recall, recordAnswer, retention, slipGuess, type Answer, type Level } from '../../src/lib/review/mastery';
import { byId, CLASSES, note, p, vault } from './fixtures';

const FOLDERS = ['Biology', 'Calculus I', 'Calculus I/Homework', 'Calculus I/Unit 2', 'Old Class', 'Drafts'];

test('review material is grouped class › chapter › note, without homework, trash or guides', () => {
  const v = vault();
  const guide = note('Welcome', '', [p('How to use the app.')], { tags: ['guide'] });
  const old = note('Archived lecture', 'Old Class', [p('Something taught last year.')]);
  const draft = note('Idea', 'Drafts/Ideas', [p('A loose idea.')]);
  const tree = buildReviewTree(byId([...v.list, guide, old, draft]), FOLDERS, CLASSES);
  assert.deepEqual(
    tree.map((g) => g.name),
    ['Biology', 'Calculus I', 'Drafts', 'Old Class', 'Unfiled'],
  );
  const calc = tree.find((g) => g.name === 'Calculus I')!;
  assert.deepEqual(
    calc.chapters.map((c) => [c.name, c.notes.map((n) => n.meta.title)]),
    [
      ['General', ['Lecture 4 — Limits & Continuity']],
      ['Unit 2', ['Lecture 5 — Derivatives']],
    ],
  );
  const all = tree.flatMap((g) => g.chapters.flatMap((c) => c.notes.map((n) => n.meta.title)));
  assert.ok(!all.includes('Problem Set 4'), 'homework is not review material');
  assert.ok(!all.includes('Old lecture'), 'trashed notes are left out');
  assert.ok(!all.includes('Welcome'), 'guide notes are left out');
  assert.equal(tree.find((g) => g.name === 'Drafts')!.chapters[0].name, 'Ideas');
});

test('a selection across classes is described by class', () => {
  const v = vault();
  const tree = buildReviewTree(v.notes, FOLDERS, CLASSES);
  assert.equal(selectionLabel(tree, new Set([v.lecture4.meta.id, v.cells.meta.id])), 'Biology + Calculus I · 2 notes');
  assert.equal(selectionLabel(tree, new Set([v.lecture5.meta.id])), 'Calculus I · 1 note');
});

const run = (steps: Partial<Answer>[], cap: Level = 3, now = 1000 * DAY) => {
  let st = freshState(now);
  const ps: number[] = [];
  steps.forEach((a, i) => {
    st = recordAnswer(st, { s: 1, graded: 'typed', level: st.level, key: `k${i}`, conf: 'unsure', ...a }, cap, now);
    ps.push(Number(st.p.toFixed(3)));
  });
  return { st, ps };
};

test('BKT: typed, rubric and multiple-choice answers move mastery as calibrated', () => {
  assert.deepEqual(run([{ graded: 'typed' }, { graded: 'rubric' }, { graded: 'mcq' }]).ps, [0.848, 0.98, 0.995]);
  assert.deepEqual(run([{ graded: 'mcq' }, { graded: 'mcq' }, { graded: 'mcq' }]).ps, [0.557, 0.849, 0.961]);
  // A miss after a right answer, when sure: a misconception, not a slip.
  const { ps, st } = run([{ graded: 'typed' }, { graded: 'typed', s: 0, conf: 'sure', answer: 'hablo' }]);
  assert.deepEqual(ps, [0.848, 0.309]);
  assert.equal(st.misconception, 'hablo');
  // Partial credit lands between a miss and a hit.
  const sg = slipGuess('rubric', 'unsure');
  const mid = bktUpdate(0.5, 0.5, sg);
  assert.ok(bktUpdate(0.5, 0, sg) < mid && mid < bktUpdate(0.5, 1, sg));
});

test('guessing right counts for less than knowing it', () => {
  const sure = run([{ conf: 'sure' }]).st.p;
  const guessed = run([{ conf: 'guess' }]).st.p;
  assert.equal(Number(sure.toFixed(3)), 0.92);
  assert.equal(Number(guessed.toFixed(3)), 0.734);
});

test('mastery needs p ≥ 0.95, the apply level, two different items and one code-graded answer', () => {
  // Three model-graded right answers: p is high, but it isn't mastered (two keys rule).
  const rubricOnly = run([{ graded: 'rubric' }, { graded: 'rubric' }, { graded: 'rubric' }]);
  assert.ok(rubricOnly.st.p > 0.95);
  assert.ok(!isMastered(rubricOnly.st), 'model grades alone never master a concept');
  // Recall, then explain, then apply — with a typed answer among them.
  const { st } = run([{ level: 0 }, { level: 1, graded: 'rubric' }, { level: 2, graded: 'rubric' }]);
  assert.ok(isMastered(st));
  assert.equal(st.interval, 1);
  // The same item twice doesn't count as two.
  const same = run([{ key: 'x' }, { key: 'x', level: 1 }, { key: 'x', level: 2 }]);
  assert.ok(!isMastered(same.st));
  // Vocabulary can only be recalled (cap 0): two code-graded recalls master it.
  assert.ok(isMastered(run([{ level: 0 }, { level: 0 }], 0).st, 0));
});

test('levels climb after right answers and drop after two misses', () => {
  const { st } = run([{ s: 1 }, { s: 1 }]);
  assert.equal(st.level, 2);
  const down = run([{ s: 1 }, { s: 1 }, { s: 0 }, { s: 0 }]);
  assert.equal(down.st.level, 1);
});

test('a lapse loses mastery and shortens the interval; reviews come back at growing intervals', () => {
  let now = 10 * DAY;
  let st = freshState(now);
  const answer = (a: Partial<Answer>) => {
    st = recordAnswer(st, { s: 1, graded: 'typed', level: st.level, key: `k${st.attempts}`, conf: 'unsure', firstInSession: true, ...a }, 3, now);
  };
  answer({});
  answer({ firstInSession: false, graded: 'rubric' });
  answer({ firstInSession: false, graded: 'rubric' });
  assert.ok(isMastered(st));
  const intervals = [st.interval];
  for (let i = 0; i < 3; i++) {
    now = st.due;
    answer({ level: 2 });
    intervals.push(st.interval);
  }
  assert.deepEqual(intervals, [1, 3, 7, 16]);
  assert.ok(st.durable, 'a correct answer a day later confirms mastery');
  now = st.due;
  answer({ s: 0, conf: 'sure', answer: 'wrong' });
  assert.ok(!isMastered(st));
  assert.equal(st.interval, 5);
  assert.equal(st.lapses, 1);
});

test('reviewing early earns no extra interval; recall is 0.9 on the due date', () => {
  const now = 50 * DAY;
  const { st } = run([{ level: 0 }, { level: 1, graded: 'rubric' }, { level: 2, graded: 'rubric' }], 3, now);
  const early = recordAnswer(st, { s: 1, graded: 'typed', level: 2, key: 'z', conf: 'unsure' }, 3, now + 0.2 * DAY);
  assert.equal(early.interval, st.interval);
  assert.equal(Number(retention({ ...st, interval: 7, last: now }, now + 7 * DAY).toFixed(3)), 0.9);
  assert.ok(recall(st, now + 30 * DAY) < recall(st, now + DAY), 'memory fades');
  assert.equal(percent(st, now), 100);
  assert.equal(percent(undefined, now), 0);
  assert.equal(BKT.init, 0.2);
});
