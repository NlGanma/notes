import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, pickNext, requeue, summarize, type PoolEntry, type SessionState } from '../../src/lib/review/session';
import { freshState, isMastered, recordAnswer, DAY, type ConceptState } from '../../src/lib/review/mastery';
import { mulberry32 } from '../../src/lib/review/items';

const pool: PoolEntry[] = [
  ...['Limits', 'Squeeze', 'Continuity', 'IVT', 'Laws'].map((n, i) => ({ id: `m${i}`, group: 'Calculus I', chapter: '', noteId: 'calc', order: i, kind: 'rule' as const, exam: n === 'Squeeze', cap: 2 as const, partners: [] })),
  ...['Pretérito', 'Imperfecto', 'niñez', 'juguete', 'vecindario'].map((n, i) => ({ id: `s${i}`, group: 'Spanish II', chapter: 'Unidad 3', noteId: i < 2 ? 'pret' : 'vocab', order: i, kind: i < 2 ? ('rule' as const) : ('vocab' as const), exam: false, cap: i < 2 ? (2 as const) : (0 as const), partners: [] })),
];

/** Runs a session where the student answers by a fixed pattern. */
function simulate(answer: (c: string, i: number) => number, opts = { length: 25, mix: true, askConfidence: true }, seed = 7) {
  const now = 100 * DAY;
  const rng = mulberry32(seed);
  let sess: SessionState = newSession('t', seed, ['calc', 'pret', 'vocab'], opts, now);
  const states: Record<string, ConceptState> = {};
  const asked: { c: string; key: string; s: number }[] = [];
  for (let i = 0; i < opts.length; i++) {
    const c = pickNext(sess, pool, states, now, rng);
    if (!c) break;
    const entry = pool.find((p) => p.id === c)!;
    const st = states[c] ?? freshState(now);
    const s = answer(c, i);
    const key = `${c}:f${st.attempts % 3}`;
    states[c] = recordAnswer(st, { s, graded: 'typed', level: st.level, key, conf: 'unsure' }, entry.cap, now);
    sess = requeue(sess, entry, { key, s, conf: 'unsure', mastered: isMastered(states[c], entry.cap), wasDue: false }, now);
    asked.push({ c, key, s });
  }
  return { sess, states, asked };
}

test('never the same concept twice in a row, never three in a row from one class', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { asked } = simulate((c, i) => ((i * 7 + c.length) % 3 === 0 ? 0 : 1), undefined, seed);
    // A repeat only happens when nothing else is left to ask.
    const firstRepeat = asked.findIndex((a, i) => i > 0 && a.c === asked[i - 1].c);
    if (firstRepeat > 0) assert.ok(asked.slice(firstRepeat - 1).every((a) => a.c === asked[firstRepeat].c), `seed ${seed}: repeat at ${firstRepeat}`);
    for (let i = 2; i < asked.length; i++) {
      const g = (c: string) => c[0];
      assert.ok(!(g(asked[i].c) === g(asked[i - 1].c) && g(asked[i].c) === g(asked[i - 2].c)), `seed ${seed}: three in a row from one class at ${i}`);
    }
  }
});

test('at most one new idea per three questions and a small working set', () => {
  const { sess, asked } = simulate(() => 0.5);
  const firstSeen: number[] = [];
  const seen = new Set<string>();
  asked.forEach((a, i) => {
    if (!seen.has(a.c)) {
      seen.add(a.c);
      firstSeen.push(i);
    }
  });
  // Never more than one new idea ahead of the one-per-three pace.
  firstSeen.forEach((at, k) => assert.ok(k <= Math.ceil((at + 1) / 3) + 1, `new idea #${k + 1} at item ${at}`));
  assert.ok(sess.working.length <= 4);
});

test('a miss comes back three items later (as a different item); a third miss means "needs study"', () => {
  const { asked, sess } = simulate((c) => (c === 'm1' ? 0 : 1));
  const at = asked.map((a, i) => (a.c === 'm1' ? i : -1)).filter((i) => i >= 0);
  assert.ok(at.length >= 2);
  assert.ok(at[1] - at[0] >= 3 && at[1] - at[0] <= 5, `came back after ${at[1] - at[0]} items`);
  assert.notEqual(asked[at[0]].key, asked[at[1]].key);
  assert.ok(sess.needsStudy.includes('m1'));
  assert.equal(at.length, 3, 'not asked again after the third miss');
});

test('a session ends early when everything in it is mastered', () => {
  const { asked, states } = simulate(() => 1, { length: 200, mix: true, askConfidence: false });
  assert.ok(asked.length < 200);
  for (const p of pool) assert.ok(isMastered(states[p.id], p.cap), p.id);
});

test('the summary counts mastered ideas per class and calibration', () => {
  const { sess, states } = simulate(() => 1, { length: 200, mix: true, askConfidence: false });
  const rich = pool.map((p) => ({ ...p, name: p.id, groupName: p.group, thin: false }));
  const sum = summarize(sess, rich, {}, states, { label: 'x', notReviewable: [], misconceptions: [], overrides: 0 }, 100 * DAY);
  assert.deepEqual(
    sum.byClass.map((c) => [c.name, c.mastered, c.total]),
    [
      ['Calculus I', 5, 5],
      ['Spanish II', 5, 5],
    ],
  );
  assert.equal(sum.masteredToday.length, 10);
  assert.equal(sum.calibration.find((c) => c.conf === 'unsure')!.n, sum.items);
});
