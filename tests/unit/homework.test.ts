import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, homeworkSources, suggestSources } from '../../src/lib/homework';
import { vault } from './fixtures';

test('linked folders include every non-homework note inside them, but not trash or the homework itself', () => {
  const v = vault();
  const titles = homeworkSources(v.hw, v.notes)
    .map((n) => n.meta.title)
    .sort();
  assert.deepEqual(titles, ['Lecture 4 — Limits & Continuity', 'Lecture 5 — Derivatives']);
});

test('explicit sources are used as given; missing or trashed ones are ignored', () => {
  const v = vault();
  const hw = { ...v.hw, meta: { ...v.hw.meta, homework: { sources: [v.cells.meta.id, 'gone', v.trashed.meta.id], folders: [] } } };
  assert.deepEqual(
    homeworkSources(hw, v.notes).map((n) => n.meta.title),
    ['Cell Structure'],
  );
});

test('a note without homework metadata has no sources', () => {
  const v = vault();
  assert.deepEqual(homeworkSources(v.cells, v.notes), []);
});

test('suggestions find the lecture that covers the homework, not unrelated notes', () => {
  const v = vault();
  const s = suggestSources(v.hw, v.notes, 4, 'Calculus I');
  assert.ok(s.length >= 1);
  assert.equal(s[0].note.meta.title, 'Lecture 4 — Limits & Continuity');
  assert.ok(
    s[0].terms.some((t) => /squeez|continu/.test(t)),
    `reason terms: ${s[0].terms}`,
  );
  assert.ok(!s.some((x) => x.note.meta.title === 'Shopping list'));
  assert.ok(!s.some((x) => x.note.meta.homework));
});

test('due labels', () => {
  const now = new Date(2026, 9, 22, 10).getTime();
  const at = (days: number) => new Date(2026, 9, 22 + days, 23, 59).getTime();
  assert.equal(dueLabel(undefined, now), null);
  assert.equal(dueLabel(at(0), now)?.text, 'Due today');
  assert.equal(dueLabel(at(1), now)?.text, 'Due tomorrow');
  assert.equal(dueLabel(at(-1), now)?.tone, 'overdue');
  assert.equal(dueLabel(at(2), now)?.tone, 'soon');
  assert.equal(dueLabel(at(5), now)?.tone, 'later');
  assert.match(dueLabel(at(20), now)!.text, /^Due /);
});
