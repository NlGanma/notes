import type { Concept } from './concepts';
import { isDue, isMastered, percent, recall, statusOf, type Confidence, type ConceptState, type Level, type MasteryNeeds } from './mastery';

/**
 * Choosing the next question. Pure and seeded, so sessions are reproducible.
 *
 * - A working set of at most 4 unmastered concepts (3 in a short session);
 *   a new one comes in only as another leaves, and at most 1 new per 3 items.
 * - A miss comes back 3 items later (2 when the student was sure) as a
 *   different item; a third miss ends it for today ("needs study").
 * - Due concepts get one question; right means done for the session.
 * - Never the same concept twice in a row while another can be asked: when
 *   nothing else is due or new, one learned before is reviewed instead.
 * - Mixing classes: never 3 in a row from one class while another has
 *   something to ask; look-alike concepts in a class may follow each other
 *   (that's where telling them apart is learned).
 */

export interface SessionOpts {
  length: number;
  mix: boolean;
  askConfidence: boolean;
}

/** What the scheduler needs to know about a concept. */
export interface PoolEntry {
  id: string;
  /** Class (or folder group) — for interleaving. */
  group: string;
  /** Chapter folder ('' = the class's own notes). */
  chapter: string;
  noteId: string;
  /** Position in the note (earlier ideas first). */
  order: number;
  kind: Concept['kind'];
  exam: boolean;
  cap: Level;
  needs?: MasteryNeeds;
  partners: string[];
}

export interface Reask {
  c: string;
  after: number;
  count: number;
}

export interface SessionState {
  id: string;
  seed: number;
  noteIds: string[];
  opts: SessionOpts;
  index: number;
  working: string[];
  reask: Reask[];
  newSoFar: number;
  misses: Record<string, number>;
  needsStudy: string[];
  /** Due concepts answered right this session (done until next time). */
  doneDue: string[];
  /** Concepts with nothing left to ask this session (their notes changed, or every item was reported). */
  skipped: string[];
  /** Concepts asked at least once this session. */
  asked: string[];
  history: { c: string; key: string; group: string; s: number; conf: Confidence | null; at: number }[];
  startedAt: number;
}

export function newSession(id: string, seed: number, noteIds: string[], opts: SessionOpts, now: number): SessionState {
  return {
    id,
    seed,
    noteIds,
    opts,
    index: 0,
    working: [],
    reask: [],
    newSoFar: 0,
    misses: {},
    needsStudy: [],
    doneDue: [],
    skipped: [],
    asked: [],
    history: [],
    startedAt: now,
  };
}

/** The session without a concept that can't be asked any more. */
export function skipConcept(sess: SessionState, id: string): SessionState {
  return {
    ...sess,
    working: sess.working.filter((c) => c !== id),
    reask: sess.reask.filter((r) => r.c !== id),
    skipped: sess.skipped.includes(id) ? sess.skipped : [...sess.skipped, id],
  };
}

const workingCap = (s: SessionState) => (s.opts.length <= 10 ? 3 : 4);

function confusable(a: PoolEntry, b: PoolEntry | undefined): boolean {
  return !!b && a.chapter === b.chapter && a.group === b.group && a.kind === b.kind && (a.partners.includes(b.id) || b.partners.includes(a.id) || a.noteId === b.noteId);
}

/**
 * The next concept to ask about, or null when the session has nothing left
 * worth asking.
 */
export function pickNext(
  sess: SessionState,
  pool: PoolEntry[],
  states: Record<string, ConceptState | undefined>,
  now: number,
  rng: () => number,
): string | null {
  const byId = new Map(pool.map((p) => [p.id, p]));
  const last = sess.history.at(-1);
  const lastEntry = last && byId.get(last.c);
  const gone = new Set([...sess.needsStudy, ...sess.doneDue, ...sess.skipped]);
  const isNew = (p: PoolEntry) => !states[p.id]?.attempts && !sess.working.includes(p.id);
  const mastered = (p: PoolEntry) => !!states[p.id] && isMastered(states[p.id]!, p.cap, p.needs);

  // Mixing classes: after two in a row from one class, the next comes from another if possible.
  const lastTwo = sess.history.slice(-2);
  const tooMany = sess.opts.mix && lastTwo.length === 2 && lastTwo[0].group === lastTwo[1].group ? lastTwo[0].group : null;
  const allowed = (p: PoolEntry) => p.group !== tooMany;

  // The next new concept: exam-flagged first, then note order, taking turns between classes and chapters.
  const groupsAsked = new Map<string, number>();
  for (const h of sess.history) groupsAsked.set(h.group, (groupsAsked.get(h.group) ?? 0) + 1);
  const fresh = pool
    .filter((p) => isNew(p) && !gone.has(p.id))
    .sort(
      (a, b) =>
        Number(b.exam) - Number(a.exam) ||
        (groupsAsked.get(a.group) ?? 0) - (groupsAsked.get(b.group) ?? 0) ||
        a.chapter.localeCompare(b.chapter) ||
        a.order - b.order,
    );
  const nextNew = fresh.find(allowed) ?? fresh[0];

  const reaskOf = (p: PoolEntry) => sess.reask.find((r) => r.c === p.id);
  const ready = (p: PoolEntry) => !reaskOf(p) || reaskOf(p)!.after <= sess.index;
  const known = pool.filter((p) => {
    if (gone.has(p.id)) return false;
    if (sess.working.includes(p.id)) return !mastered(p);
    if (reaskOf(p)) return true;
    return !!states[p.id]?.attempts && isDue(states[p.id], now) && !sess.asked.includes(p.id);
  });
  // At most one new idea per three questions while there's other work to do; always when there isn't
  // (a missed idea waiting to come back, or the class that's had two turns, doesn't count).
  const room = sess.working.length < workingCap(sess);
  const quota = sess.newSoFar < Math.ceil((sess.index + 1) / 3);
  const otherWork = known.some((p) => p.id !== last?.c && ready(p) && allowed(p));
  const candidates = nextNew && ((room && quota) || !otherWork) ? [...known, nextNew] : known;
  if (!candidates.length) return null;

  // Hard rules: not the same concept twice in a row; not three in a row from one class.
  let pickable = candidates.filter((p) => p.id !== last?.c);
  // Nothing else is due or new: review an idea learned before (one not asked yet this session first)
  // rather than ask the same one again at once. It's asked once, like a due one, and an early review
  // earns no longer interval. Only when every other idea is done for today is one asked twice in a row.
  if (!pickable.length) {
    const spare = pool.filter((p) => p.id !== last?.c && !gone.has(p.id) && !!states[p.id]?.attempts);
    pickable = spare.filter((p) => !sess.asked.includes(p.id));
    if (!pickable.length) pickable = spare;
  }
  if (!pickable.length) pickable = candidates;
  if (tooMany && pickable.some(allowed)) pickable = pickable.filter(allowed);

  let best: { id: string; score: number } | null = null;
  for (const p of pickable) {
    const st = states[p.id];
    const reask = sess.reask.find((r) => r.c === p.id);
    const ready = !!reask && reask.after <= sess.index;
    if (reask && !ready && !sess.working.includes(p.id)) continue;
    let score = 0;
    score += ready ? 3 : 0;
    score += st && isDue(st, now) && !sess.working.includes(p.id) ? 1.5 : 0;
    score += 1 - (st?.attempts ? recall(st, now) : 0.2);
    score += isNew(p) ? 0.6 : 0;
    score += confusable(p, lastEntry) ? 0.4 : 0;
    if (sess.opts.mix && lastEntry) {
      if (p.group === lastEntry.group) score -= 0.8;
      if (p.chapter === lastEntry.chapter && p.group === lastEntry.group && !confusable(p, lastEntry)) score -= 0.3;
    }
    // A re-ask that isn't ready yet should wait.
    if (reask && !ready) score -= 2;
    score += 0.05 * rng();
    if (!best || score > best.score) best = { id: p.id, score };
  }
  return best?.id ?? pickable[0]?.id ?? null;
}

/** Bookkeeping after an answer: the working set, re-asks and the "needs study" list. */
export function requeue(
  sess: SessionState,
  entry: PoolEntry,
  a: { key: string; s: number; conf: Confidence | null; mastered: boolean; wasDue: boolean },
  now: number,
): SessionState {
  const next: SessionState = {
    ...sess,
    index: sess.index + 1,
    working: [...sess.working],
    reask: sess.reask.filter((r) => r.c !== entry.id),
    misses: { ...sess.misses },
    needsStudy: [...sess.needsStudy],
    doneDue: [...sess.doneDue],
    asked: sess.asked.includes(entry.id) ? sess.asked : [...sess.asked, entry.id],
    history: [...sess.history, { c: entry.id, key: a.key, group: entry.group, s: a.s, conf: a.conf, at: now }],
  };
  const inWorking = next.working.includes(entry.id);
  if (!inWorking && !a.wasDue) {
    next.working.push(entry.id);
    next.newSoFar++;
  }
  const prevCount = sess.reask.find((r) => r.c === entry.id)?.count ?? 0;
  if (a.s < 0.5) {
    next.misses[entry.id] = (next.misses[entry.id] ?? 0) + 1;
    if (next.misses[entry.id] >= 3) {
      next.needsStudy.push(entry.id);
      next.working = next.working.filter((c) => c !== entry.id);
      return next;
    }
    if (!next.working.includes(entry.id)) next.working.push(entry.id);
    next.reask.push({ c: entry.id, after: next.index + (a.conf === 'sure' ? 2 : 3) - 1, count: prevCount + 1 });
  } else if (a.s < 0.8) {
    if (!next.working.includes(entry.id)) next.working.push(entry.id);
    next.reask.push({ c: entry.id, after: next.index + 4 - 1, count: prevCount + 1 });
  } else if (a.wasDue && !inWorking) {
    next.doneDue.push(entry.id);
  }
  if (a.mastered) next.working = next.working.filter((c) => c !== entry.id);
  return next;
}

/** Whether the session is over: its length reached, or nothing left to ask. */
export function sessionDone(sess: SessionState, nextId: string | null): boolean {
  return sess.index >= sess.opts.length || !nextId;
}

// ------------------------------------------------------------------ summary

export interface SessionSummary {
  id: string;
  at: number;
  durationMs: number;
  label: string;
  items: number;
  correct: number;
  byClass: { key: string; name: string; color?: string; mastered: number; learning: number; newCount: number; total: number; percent: number; nextDue: number | null }[];
  masteredToday: string[];
  improved: { id: string; before: number; after: number }[];
  needsStudy: string[];
  thin: string[];
  notReviewable: string[];
  calibration: { conf: Confidence; n: number; correct: number }[];
  misconceptions: { conceptId: string; wrote: string; notesSay: string }[];
  overrides: number;
}

export function summarize(
  sess: SessionState,
  pool: (PoolEntry & { name: string; groupName: string; color?: string; thin: boolean })[],
  before: Record<string, ConceptState | undefined>,
  after: Record<string, ConceptState | undefined>,
  extra: { label: string; notReviewable: string[]; misconceptions: SessionSummary['misconceptions']; overrides: number },
  now: number,
): SessionSummary {
  const touched = new Set(sess.history.map((h) => h.c));
  const groups = new Map<string, SessionSummary['byClass'][number]>();
  for (const p of pool) {
    const g = groups.get(p.group) ?? { key: p.group, name: p.groupName, color: p.color, mastered: 0, learning: 0, newCount: 0, total: 0, percent: 0, nextDue: null };
    const st = after[p.id];
    const status = statusOf(st, p.cap, sess.needsStudy.includes(p.id), p.needs);
    g.total++;
    if (status === 'mastered' || status === 'solid') g.mastered++;
    else if (status === 'new') g.newCount++;
    else g.learning++;
    g.percent += percent(st, now);
    if (st?.attempts && (g.nextDue === null || st.due < g.nextDue)) g.nextDue = st.due;
    groups.set(p.group, g);
  }
  for (const g of groups.values()) g.percent = Math.round(g.percent / Math.max(1, g.total));
  const calibration = (['sure', 'unsure', 'guess'] as Confidence[]).map((conf) => {
    const hs = sess.history.filter((h) => h.conf === conf);
    return { conf, n: hs.length, correct: hs.filter((h) => h.s >= 0.8).length };
  });
  return {
    id: sess.id,
    at: now,
    durationMs: now - sess.startedAt,
    label: extra.label,
    items: sess.history.length,
    correct: sess.history.filter((h) => h.s >= 0.8).length,
    byClass: [...groups.values()],
    masteredToday: pool
      .filter((p) => touched.has(p.id) && after[p.id] && isMastered(after[p.id]!, p.cap, p.needs) && !(before[p.id] && isMastered(before[p.id]!, p.cap, p.needs)))
      .map((p) => p.id),
    improved: pool
      .filter((p) => touched.has(p.id))
      .map((p) => ({ id: p.id, before: percent(before[p.id], now), after: percent(after[p.id], now) }))
      .filter((x) => x.after > x.before),
    needsStudy: sess.needsStudy,
    thin: pool.filter((p) => p.thin).map((p) => p.id),
    notReviewable: extra.notReviewable,
    calibration,
    misconceptions: extra.misconceptions,
    overrides: extra.overrides,
  };
}

/** One line on how well confidence matched accuracy. */
export function calibrationMessage(c: SessionSummary['calibration']): string | null {
  const sure = c.find((x) => x.conf === 'sure');
  const guess = c.find((x) => x.conf === 'guess');
  if (sure && sure.n >= 3 && sure.correct / sure.n < 0.75) return 'You were often sure and wrong — slow down on those.';
  if (guess && guess.n >= 3 && guess.correct / guess.n > 0.7) return 'You know more than you think.';
  if (c.some((x) => x.n)) return 'Your confidence matches your accuracy.';
  return null;
}
