import type { Concept, Fact } from './concepts';
import { contentWords } from './concepts';
import type { GradedBy, Level } from './mastery';
import { expandProof, findQuote, isSpanOf, normalizeForQuote } from '../ai/quote';
import { novelTokens } from '../ai/verify';
import { tokenize } from '../ai/rag';

/**
 * Review items. Each is built by code from a verbatim fact; the answer key,
 * every key point and every choice is the note's own text. A model may only
 * re-phrase a question, and that is accepted only if it passes the checks in
 * `validateQuestion` — otherwise the item built by code is used.
 */

export type ItemFormat = 'cloze' | 'recall' | 'mcq' | 'explain' | 'apply' | 'connect' | 'rate';

export interface ItemSource {
  noteId: string;
  blockId: string | null;
  title: string;
  section: string;
  /** The passage the item comes from (verbatim note text). */
  text: string;
}

export interface Item {
  /** `${conceptId}:${factId}:${format}` */
  key: string;
  conceptId: string;
  factId: string;
  format: ItemFormat;
  level: Level;
  /** The question (Markdown). */
  prompt: string;
  /** Typed answers: the verbatim answer and alternatives the note itself gives. */
  expected?: string;
  accept?: string[];
  /** Multiple choice. */
  choices?: string[];
  correct?: number;
  /** Rubric: verbatim key points a full answer must contain. */
  points?: string[];
  /** The fact to show as "Your notes say". */
  fact: string;
  source: ItemSource;
  origin: 'template' | 'model';
  graded: GradedBy;
}

/** Deterministic randomness for a session (so a session can be replayed and tested). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clean = (s: string) =>
  s
    .replace(/\*\*|==|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const BLANK = '_____';

/** Alternatives the note gives in the key itself: "daycare / nursery school", "A or B". */
export function alternatives(key: string): string[] {
  const k = clean(key);
  const parts = k.split(/\s+\/\s+|\s+or\s+|\s+o\s+/).map((p) => p.trim());
  return parts.length > 1 && parts.every((p) => p.length >= 3) ? parts : [];
}

/** The fact with its key blanked out (the key's first occurrence). */
export function blankOut(f: Fact): string | null {
  if (!f.key) return null;
  const i = f.text.indexOf(f.key);
  if (i < 0) return null;
  let before = f.text.slice(0, i);
  let after = f.text.slice(i + f.key.length);
  // Keep markdown balanced around the blank: "**-ar**" → "_____".
  if (before.endsWith('**') && after.startsWith('**')) {
    before = before.slice(0, -2);
    after = after.slice(2);
  }
  const rest = clean(`${before} ${after}`);
  // Too little left to know what is asked.
  if (contentWords(rest).length < 3) return null;
  // The blank may hide at most 40% of the fact.
  if (clean(f.key).length > 0.6 * clean(f.text).length) return null;
  return clean(`${before}${BLANK}${after}`);
}

const where = (title: string, section: string) => [title, section].filter(Boolean).join(' › ');

export interface BuildCtx {
  title: string;
  /** Other concepts of the same kind (same chapter first): their keys are the wrong choices. */
  siblings: Concept[];
  /** Keys of items asked recently — pick something else when possible. */
  avoid: string[];
  rng: () => number;
  languageClass?: boolean;
  /** First time this concept is asked (multiple choice is allowed). */
  firstExposure?: boolean;
  /** Text of the concept's passage (for the grounding invariant). */
  chunkText: string;
}

function source(c: Concept, title: string, f: Fact): ItemSource {
  return { noteId: c.noteId, blockId: c.blockId, title, section: c.section, text: f.text };
}

function base(c: Concept, f: Fact, format: ItemFormat, level: Level, ctx: BuildCtx, graded: GradedBy): Omit<Item, 'prompt'> {
  return { key: `${c.id}:${f.id}:${format}`, conceptId: c.id, factId: f.id, format, level, fact: f.text, source: source(c, ctx.title, f), origin: 'template', graded };
}

/** The level-0 items a fact allows. */
function recallItems(c: Concept, f: Fact, ctx: BuildCtx): Item[] {
  const out: Item[] = [];
  const key = f.key ? clean(f.key) : '';
  if (c.kind === 'vocab' && f.key) {
    const isTerm = clean(f.key) === clean(c.name);
    const other = clean(f.text.replace(/^\*\*[^*]+\*\*\s*(?:—|–|-|:)\s*/, ''));
    out.push({
      ...base(c, f, 'recall', 0, ctx, 'typed'),
      prompt: isTerm ? `How do you say **“${other}”**, according to your notes?` : `What does **${clean(c.name)}** mean?`,
      expected: isTerm ? clean(c.name) : other,
      accept: alternatives(isTerm ? c.name : other),
    });
    return out;
  }
  if ((c.kind === 'definition' || c.kind === 'event') && f.key && clean(f.key) === clean(c.name)) {
    const body = clean(f.text.replace(/^\*\*[^*]+\*\*\s*:?\s*(?:—|–|-|:)?\s*/, '').replace(/^\*\*[^*]+:\*\*\s*/, ''));
    if (contentWords(body).length >= 2)
      out.push({
        ...base(c, f, 'recall', 0, ctx, 'typed'),
        prompt: c.kind === 'event' ? `When did this happen, according to your notes?\n\n> ${body}` : `Which term do your notes define as:\n\n> ${body}`,
        expected: key,
        accept: alternatives(key),
      });
    return out;
  }
  if (/^\$\$/.test(f.text.trim())) {
    // Formulas are written out, then compared by the student.
    out.push({ ...base(c, f, 'rate', 0, ctx, 'self'), prompt: `Write down the formula your notes give for **${clean(c.name)}**, then check it.` });
    return out;
  }
  const blanked = blankOut(f);
  if (blanked) {
    out.push({
      ...base(c, f, 'cloze', 0, ctx, 'typed'),
      prompt: `Fill in the blank (from ${where(ctx.title, c.section)}):\n\n> ${blanked}`,
      expected: key,
      accept: alternatives(key),
    });
    // Multiple choice on first exposure, when the notes have enough look-alike keys.
    const pool = [...new Set(ctx.siblings.flatMap((s) => s.facts.map((x) => (x.key ? clean(x.key) : ''))).filter((k) => k && k !== key && k.length <= 120))];
    if (ctx.firstExposure && pool.length >= 3) {
      const wrong = shuffle(pool, ctx.rng).slice(0, 3);
      const choices = shuffle([key, ...wrong], ctx.rng);
      out.push({
        ...base(c, f, 'mcq', 0, ctx, 'mcq'),
        prompt: `Which completes this line from ${where(ctx.title, c.section)}?\n\n> ${blanked}`,
        choices,
        correct: choices.indexOf(key),
        expected: key,
      });
    }
  }
  return out;
}

function shuffle<T>(list: T[], rng: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const EXPLAIN: Record<string, (n: string) => string> = {
  definition: (n) => `In your own words: what is **${n}**, according to your notes?`,
  rule: (n) => `In your own words: when and how do you use **${n}**, according to your notes?`,
  procedure: (n) => `What are the steps for **${n}**, according to your notes?`,
  formula: (n) => `In your own words: what does **${n}** say, according to your notes?`,
  event: (n) => `What happened in **${n}**, according to your notes?`,
  fact: (n) => `What do your notes say about **${n}**?`,
  vocab: (n) => `What does **${n}** mean?`,
};

/** Builds the item for a concept at a level, falling back down the ladder when the notes don't allow it. */
export function buildItem(c: Concept, level: Level, ctx: BuildCtx): Item {
  const lvl = Math.min(level, c.cap) as Level;
  const facts = c.facts.filter((f) => !f.fromInk || f.text.length > 0);
  const plain = facts.filter((f) => !f.example);
  const pick = <T extends { key: string }>(items: T[]): T | undefined => items.find((i) => !ctx.avoid.includes(i.key)) ?? items[0];
  if (lvl >= 3 && c.partners.length) {
    const partner = ctx.siblings.find((s) => c.partners.includes(s.id));
    if (partner) {
      const both = [...facts, ...partner.facts].filter((f) => mentions(f.text, c.name) && mentions(f.text, partner.name));
      const points = (both.length ? both : [plain[0] ?? facts[0], partner.facts[0]]).filter(Boolean).slice(0, 3);
      const f = points[0];
      return {
        ...base(c, f, 'connect', 3, ctx, 'rubric'),
        key: `${c.id}:${partner.id}:connect`,
        prompt: `How are **${clean(c.name)}** and **${clean(partner.name)}** related, according to your notes?`,
        points: points.map((p) => clean(p.text)),
      };
    }
  }
  if (lvl >= 2) {
    const ex = facts.find((f) => f.example);
    if (ex) {
      const rules = plain.slice(0, 2);
      return {
        ...base(c, ex, 'apply', 2, ctx, 'rubric'),
        // The answer shown afterwards is the idea, not the example the student was just shown.
        fact: rules[0]?.text ?? ex.text,
        prompt: `Your notes give this example:\n\n> ${clean(ex.text)}\n\nWhich idea from your notes does it show, and why?`,
        points: [clean(c.name), ...rules.map((r) => clean(r.text))].slice(0, 3),
      };
    }
    const steps = plain.filter((f) => f.item);
    if (steps.length >= 2) {
      return {
        ...base(c, steps[0], 'apply', 2, ctx, 'rubric'),
        prompt: EXPLAIN[c.kind === 'rule' ? 'rule' : 'procedure'](clean(c.name)),
        points: steps.slice(0, 3).map((s) => clean(s.text)),
      };
    }
  }
  if (lvl >= 1 && plain.length) {
    const f = plain[0];
    return {
      ...base(c, f, 'explain', 1, ctx, 'rubric'),
      prompt: (EXPLAIN[c.kind] ?? EXPLAIN.fact)(clean(c.name)),
      points: plain.slice(0, 3).map((p) => clean(p.text)),
    };
  }
  const candidates = facts.flatMap((f) => recallItems(c, f, ctx));
  const preferred = ctx.firstExposure ? candidates.filter((i) => i.format === 'mcq') : candidates.filter((i) => i.format !== 'mcq');
  const item = pick(preferred.length ? preferred : candidates);
  if (item) return item;
  // Nothing to blank or recall: show the fact and let the student say how well they knew it.
  const f = facts[0];
  return { ...base(c, f, 'rate', 0, ctx, 'self'), prompt: `What do your notes say about **${clean(c.name)}**? Think of your answer, then check.` };
}

function mentions(text: string, name: string): boolean {
  const n = tokenize(name);
  const t = new Set(tokenize(text));
  return n.length > 0 && n.every((w) => t.has(w));
}

/**
 * The grounding invariant, checked before an item is shown: every answer,
 * key point and choice is the note's own text (wrong choices are other
 * concepts' note text). An item that fails is never shown.
 */
export function assertGroundedItem(item: Item, chunkText: string, siblingTexts: string[] = []): boolean {
  const inNote = (s: string) => isSpanOf(s, chunkText) || siblingTexts.some((t) => isSpanOf(s, t));
  if (!isSpanOf(clean(item.fact), clean(chunkText))) return false;
  if (item.expected && !inNote(item.expected)) return false;
  if (item.accept?.some((a) => !inNote(a))) return false;
  if (item.points?.some((p) => !inNote(p) && !isSpanOf(p, chunkText))) return false;
  if (item.choices?.some((ch) => !inNote(ch))) return false;
  return true;
}

export interface ModelQuestion {
  question: string;
  proof: string;
  keyPoints: string[];
}

const QUESTION_START = /^(?:explain|state|write|redo|name|describe|give|list|compare|in your own words|how|what|why|when|which|who|where|according)/i;

/**
 * A question the model phrased, accepted only if it is answered by the
 * passage, doesn't give its answer away and says nothing the notes don't.
 * Returns the item with the note's own text as the answer, or null.
 */
export function validateQuestion(raw: ModelQuestion, item: Item, chunkText: string, conceptName: string): Item | null {
  const q = (raw.question ?? '').trim();
  if (q.length < 12 || q.length > 300) return null;
  if (!/\?\s*$/.test(q) && !QUESTION_START.test(q)) return null;
  const proofSpan = expandProof(raw.proof ?? '', chunkText);
  if (!proofSpan) return null;
  let points = (raw.keyPoints ?? []).map((p) => findQuote(String(p), chunkText)).filter((p): p is string => !!p);
  if (!points.length)
    points = clean(proofSpan)
      .split(/[;:,]|\s+and\s+|\s+y\s+/)
      .map((p) => p.trim())
      .filter((p) => contentWords(p).length >= 3)
      .slice(0, 3);
  if (!points.length) points = [clean(proofSpan)];
  // No leaks: the question must not contain an answer.
  const qn = normalizeForQuote(q);
  for (const p of points) {
    const pw = contentWords(p);
    const inQ = pw.filter((w) => tokenize(q).includes(w)).length;
    if (pw.length && inQ / pw.length >= 0.6) return null;
  }
  if (item.expected && qn.includes(normalizeForQuote(item.expected))) return null;
  // Nothing the notes don't have (no false premises).
  if (novelTokens(q, `${chunkText}\n${conceptName}`).length) return null;
  // It must be about this idea: it names it, or (applying it) quotes the note's example — whose idea is the answer.
  const nameWords = tokenize(conceptName);
  const covered = nameWords.filter((w) => tokenize(`${q} ${proofSpan}`).includes(w)).length;
  const exampleWords = item.format === 'apply' ? contentWords(item.source.text) : [];
  const quotesExample = exampleWords.length > 0 && exampleWords.filter((w) => tokenize(q).includes(w)).length / exampleWords.length >= 0.6;
  if (nameWords.length && covered / nameWords.length < 0.5 && !quotesExample) return null;
  // Applying an idea, the student is shown the example; the notes' answer is the idea itself.
  const fact = item.format === 'apply' && quotesExample ? item.fact : proofSpan;
  return { ...item, prompt: q, points: points.map(clean).slice(0, 3), fact, origin: 'model' };
}
