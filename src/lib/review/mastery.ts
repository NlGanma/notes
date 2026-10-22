/**
 * The learner model behind Review: Bayesian Knowledge Tracing per concept,
 * plus spacing for the next review. Pure functions, so they're unit-tested.
 *
 *   p   probability the student knows the concept
 *   T   chance of learning it from one practice item (more right after a re-teach)
 *   S   slip: knows it but answers wrong
 *   G   guess: doesn't know it but answers right
 *
 * S and G depend on how the answer was graded (a typed answer checked by code
 * is strong evidence; four-choice multiple choice can be guessed; a model's
 * rubric grade is noisier) and on how sure the student said they were.
 * Partial credit is soft evidence: the two posteriors are blended.
 */

export type Level = 0 | 1 | 2 | 3;
/** Bloom-style ladder: recall → explain → apply → connect. */
export const LEVELS = ['Recall', 'Explain', 'Apply', 'Connect'] as const;

export type Confidence = 'sure' | 'unsure' | 'guess';
/** How an answer was graded. */
export type GradedBy = 'typed' | 'mcq' | 'rubric' | 'self';

export const BKT = { init: 0.2, learn: 0.15, learnAfterReteach: 0.25 };
export const FORMAT_SG: Record<GradedBy, { S: number; G: number }> = {
  typed: { S: 0.08, G: 0.05 },
  mcq: { S: 0.08, G: 0.25 },
  rubric: { S: 0.12, G: 0.12 },
  self: { S: 0.15, G: 0.2 },
};
/** Guessing makes a right answer weaker evidence; a sure wrong answer is a misconception, not a slip. */
const G_CONF: Record<Confidence, number> = { guess: 2.0, unsure: 1.0, sure: 0.5 };
const S_CONF: Record<Confidence, number> = { guess: 1.5, unsure: 1.0, sure: 0.5 };

/** A concept counts as mastered at this probability (the usual mastery-learning threshold)… */
export const MASTERY_P = 0.95;
/** …once it has been answered at the "apply" level (or as high as the notes allow). */
export const MASTERY_LEVEL = 2;
/** Mastery reached in one sitting is confirmed by a correct answer at least this much later. */
export const DURABLE_AFTER = 20 * 3_600_000;

export const DAY = 86_400_000;
const IN_SESSION = 10 * 60_000;

export interface Attempt {
  at: number;
  key: string;
  graded: GradedBy;
  level: Level;
  s: number;
  conf: Confidence | null;
  hint: boolean;
  overridden?: boolean;
}

export interface ConceptState {
  p: number;
  attempts: number;
  correct: number;
  /** Consecutive correct answers. */
  streak: number;
  /** Highest level answered correctly (-1 = none). */
  best: number;
  /** The level the next question is asked at. */
  level: Level;
  missesAtLevel: number;
  last: number;
  due: number;
  /** Days between reviews once mastered (0 = not mastered). */
  interval: number;
  lapses: number;
  /** Correct answers graded by code (typed or multiple choice) — one is needed to master. */
  codeCorrect: number;
  /** Distinct items answered correctly — two are needed to master. */
  correctKeys: string[];
  masteredAt?: number;
  /** Mastery confirmed by a correct answer at least 20 h later. */
  durable: boolean;
  /** What the student wrote when they were sure and wrong (their own words). */
  misconception?: string;
  /** A re-teach happened since the last attempt: the next update learns more. */
  retaught?: boolean;
  recent: Attempt[];
}

export function freshState(now: number): ConceptState {
  return {
    p: BKT.init,
    attempts: 0,
    correct: 0,
    streak: 0,
    best: -1,
    level: 0,
    missesAtLevel: 0,
    last: 0,
    due: now,
    interval: 0,
    lapses: 0,
    codeCorrect: 0,
    correctKeys: [],
    durable: false,
    recent: [],
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Slip and guess for one answer. */
export function slipGuess(graded: GradedBy, conf: Confidence | null): { S: number; G: number } {
  const base = FORMAT_SG[graded];
  const c = conf ?? 'unsure';
  return { S: clamp(base.S * S_CONF[c], 0.01, 0.3), G: clamp(base.G * G_CONF[c], 0.01, 0.5) };
}

/** P(knows it | evidence s ∈ [0,1]). */
export function bktPosterior(p: number, s: number, S: number, G: number): number {
  const right = (p * (1 - S)) / (p * (1 - S) + (1 - p) * G);
  const wrong = (p * S) / (p * S + (1 - p) * (1 - G));
  return s * right + (1 - s) * wrong;
}

export function bktUpdate(p: number, s: number, sg: { S: number; G: number }, learn = BKT.learn): number {
  const post = bktPosterior(p, s, sg.S, sg.G);
  return clamp(post + (1 - post) * learn, 0.001, 0.999);
}

/** Predicted recall now: knowledge fades towards the prior; 0.9 of it is left on the due date. */
export function retention(s: ConceptState, now: number): number {
  if (!s.last) return 1;
  const I = Math.max(s.interval, 0.5);
  return Math.pow(0.9, Math.max(0, now - s.last) / DAY / I);
}

export function recall(s: ConceptState, now: number): number {
  return BKT.init + (s.p - BKT.init) * retention(s, now);
}

/**
 * Mastered: probable enough, shown at the level the notes allow, the last
 * answer was right, right on two different items, and at least once graded
 * by code (so one lenient model grade can never master a concept).
 */
export function isMastered(s: ConceptState, cap: Level = 3): boolean {
  return s.p >= MASTERY_P && s.best >= Math.min(MASTERY_LEVEL, cap) && s.streak >= 1 && s.correctKeys.length >= 2 && s.codeCorrect >= 1;
}

export function isDue(s: ConceptState | undefined, now: number): boolean {
  return !!s && s.attempts > 0 && now >= s.due;
}

export interface Answer {
  /** Score in [0, 1] (partial credit allowed). */
  s: number;
  graded: GradedBy;
  level: Level;
  key: string;
  conf: Confidence | null;
  hint?: boolean;
  /** What the student wrote (kept only as a misconception, in their own words). */
  answer?: string;
  /** The first item about this concept in the session (forgetting is applied first). */
  firstInSession?: boolean;
}

/** Applies one graded answer. `cap` is the highest level the notes support for this concept. */
export function recordAnswer(prev: ConceptState, a: Answer, cap: Level, now: number): ConceptState {
  const wasMastered = isMastered(prev, cap);
  let p = prev.p;
  if (a.firstInSession && prev.last) p = recall(prev, now);
  const s = a.hint ? Math.min(a.s, 0.6) : a.s;
  p = bktUpdate(p, s, slipGuess(a.graded, a.conf), prev.retaught ? BKT.learnAfterReteach : BKT.learn);
  const right = s >= 0.8;
  const code = a.graded === 'typed' || a.graded === 'mcq';
  const next: ConceptState = {
    ...prev,
    p,
    attempts: prev.attempts + 1,
    correct: prev.correct + (right ? 1 : 0),
    streak: right ? prev.streak + 1 : 0,
    best: right ? Math.max(prev.best, a.level) : prev.best,
    codeCorrect: prev.codeCorrect + (right && code ? 1 : 0),
    correctKeys: right && !prev.correctKeys.includes(a.key) ? [...prev.correctKeys, a.key].slice(-8) : prev.correctKeys,
    missesAtLevel: s < 0.5 ? prev.missesAtLevel + 1 : 0,
    last: now,
    retaught: false,
    misconception: !right && a.conf === 'sure' && a.answer ? a.answer.slice(0, 80) : right ? undefined : prev.misconception,
    recent: [...prev.recent, { at: now, key: a.key, graded: a.graded, level: a.level, s, conf: a.conf, hint: !!a.hint }].slice(-12),
  };
  next.level = nextLevel(prev, next, a, cap);
  return schedule(prev, next, a, cap, wasMastered, now);
}

/** Up a rung after a right answer (once it's likely known), down one after two misses at a rung. */
function nextLevel(prev: ConceptState, next: ConceptState, a: Answer, cap: Level): Level {
  let level = prev.level;
  if (a.s >= 0.8 && a.conf !== 'guess' && (next.p >= 0.6 || next.streak >= 2)) level = Math.min(3, level + 1) as Level;
  else if (next.missesAtLevel >= 2) {
    level = Math.max(0, level - 1) as Level;
    next.missesAtLevel = 0;
  }
  return Math.min(level, cap) as Level;
}

/**
 * When to see the concept again. Not mastered: later this session after a
 * miss, tomorrow after a right answer. Mastered: 1, 3, 7, 16, 36, 80, 120
 * days — longer when sure, no growth when guessing, no credit for reviewing
 * early, and a lapse shrinks the interval.
 */
function schedule(prev: ConceptState, next: ConceptState, a: Answer, cap: Level, wasMastered: boolean, now: number): ConceptState {
  const mastered = isMastered(next, cap);
  const right = a.s >= 0.8;
  if (wasMastered && !right) {
    // Lapse: mastery is lost until earned again.
    const interval = Math.max(1, Math.round(prev.interval * 0.3));
    return { ...next, lapses: prev.lapses + 1, durable: false, masteredAt: undefined, interval, due: now + IN_SESSION };
  }
  if (!mastered) return { ...next, due: now + (next.streak > 0 ? DAY : IN_SESSION) };
  const masteredAt = next.masteredAt ?? now;
  const durable = next.durable || (!!prev.masteredAt && right && !!a.firstInSession && now - prev.masteredAt >= DURABLE_AFTER);
  let interval = prev.interval;
  const early = prev.interval && prev.last && now - prev.last < 0.5 * prev.interval * DAY;
  if (!early) {
    interval = prev.interval ? Math.min(120, Math.round(prev.interval * 2.2 + 0.4)) : 1;
    if (a.conf === 'sure') interval = Math.round(interval * 1.15);
    if (a.conf === 'guess') interval = Math.max(1, prev.interval);
  }
  return { ...next, masteredAt, durable, interval, due: now + interval * DAY };
}

/** A 0–100 mastery figure for the UI. */
export function percent(s: ConceptState | undefined, now: number): number {
  if (!s || !s.attempts) return 0;
  return Math.round(Math.min(1, recall(s, now) / MASTERY_P) * 100);
}

export type Status = 'new' | 'learning' | 'mastered' | 'solid' | 'needs-study';

export function statusOf(s: ConceptState | undefined, cap: Level, needsStudy = false): Status {
  if (!s || !s.attempts) return 'new';
  if (needsStudy) return 'needs-study';
  if (isMastered(s, cap)) return s.durable ? 'solid' : 'mastered';
  return 'learning';
}
