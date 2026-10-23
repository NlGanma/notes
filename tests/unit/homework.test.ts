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

test('the Homework list groups by days from today, whatever the weekday, and leaves done homework out', async () => {
  const { dueGroup, dueInGroup, groupHomework } = await import('../../src/components/homework/sources');
  const { note } = await import('./fixtures');
  const DAY = 86_400_000;
  // Every weekday: the groups must not depend on where the week starts (it once hid a deadline two days out).
  for (let wd = 0; wd < 7; wd++) {
    const now = new Date(2026, 9, 18 + wd, 10, 0).getTime();
    const eod = (d: number) => new Date(2026, 9, 18 + wd + d, 23, 59).getTime();
    assert.equal(dueGroup(eod(-1), now), 'overdue');
    assert.equal(dueGroup(eod(0), now), 'today');
    assert.equal(dueGroup(eod(1), now), 'tomorrow');
    assert.equal(dueGroup(eod(2), now), 'week');
    assert.equal(dueGroup(eod(6), now), 'week');
    assert.equal(dueGroup(eod(7), now), 'later');
    assert.equal(dueGroup(undefined, now), 'none');
  }
  const now = new Date(2026, 9, 22, 10, 0).getTime();
  const hw = (title: string, due: number | undefined, done = false, created = 1) => note(title, 'Calculus I/Homework', [], { created, homework: { sources: [], folders: [], due, done } });
  const groups = groupHomework(
    [
      hw('later', now + 20 * DAY),
      hw('no date, older', undefined, false, 1),
      hw('no date, newer', undefined, false, 2),
      hw('overdue', now - 2 * DAY),
      hw('done', now - 5 * DAY, true),
      hw('in three days', now + 3 * DAY),
    ],
    now,
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((n) => n.meta.title)]),
    [
      ['Overdue', ['overdue']],
      ['This week', ['in three days']],
      ['Later', ['later']],
      ['No due date', ['no date, newer', 'no date, older']],
    ],
  );
  // A row says only what its group doesn't: nothing for "today" at the end of the day, the date when overdue.
  assert.equal(dueInGroup(new Date(2026, 9, 22, 23, 59).getTime(), now), null);
  assert.equal(dueInGroup(new Date(2026, 9, 22, 15, 0).getTime(), now)?.text.replace(/\s/g, ' '), new Date(2026, 9, 22, 15, 0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' '));
  assert.equal(dueInGroup(now - 2 * DAY, now)?.overdue, true);
  // Homework ticked a moment ago stays in its group until it's let go.
  const ticked = hw('just ticked', now + 3 * DAY, true);
  const list = [hw('in three days', now + 3 * DAY), ticked];
  assert.deepEqual(groupHomework(list, now)[0].items.map((n) => n.meta.title), ['in three days']);
  assert.deepEqual(
    groupHomework(list, now, new Set([ticked.meta.id]))[0].items.map((n) => n.meta.title),
    ['in three days', 'just ticked'],
  );
});

test('cards and the Homework list count days the same way, across a clock change', async () => {
  const { dueGroup } = await import('../../src/components/homework/sources');
  const agree = (due: number, now: number) => {
    const label = dueLabel(due, now)!;
    const group = dueGroup(due, now);
    assert.equal(label.text === 'Due today', group === 'today', `${new Date(now)} → ${new Date(due)}`);
    assert.equal(label.text === 'Due tomorrow', group === 'tomorrow', `${new Date(now)} → ${new Date(due)}`);
    assert.equal(label.tone === 'overdue', group === 'overdue', `${new Date(now)} → ${new Date(due)}`);
  };
  // Whatever this machine's time zone: a year of mornings and evenings, deadlines a day back to a week out.
  for (let day = 0; day < 370; day++) {
    for (const hour of [0, 9, 23]) {
      const now = new Date(2026, 0, 1 + day, hour, 30).getTime();
      for (let d = -1; d <= 7; d++) agree(new Date(2026, 0, 1 + day + d, 23, 59).getTime(), now);
    }
  }
  // And in a zone that changes its clocks: New York falls back on the night of Oct 31 to Nov 1, 2026.
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const now = new Date(2026, 9, 31, 10, 0).getTime();
    const due = new Date(2026, 10, 1, 23, 59).getTime();
    assert.equal(dueLabel(due, now)?.text, 'Due tomorrow');
    assert.equal(dueGroup(due, now), 'tomorrow');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
