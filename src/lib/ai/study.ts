import { parseJSONLoose } from './json';
import { checkStatement, idfSupport, novelTokens, type VerifyCtx } from './verify';

/** Parsing for the JSON study tools (flashcards, quiz) — tolerant of the shapes small models produce. */

export interface Card {
  front: string;
  back: string;
  source?: number;
}

export interface QuizQ {
  q: string;
  choices: string[];
  answer: number;
  explain?: string;
  source?: number;
}

export function parseStudyJSON(tool: string, text: string): { kind: 'flashcards'; cards: Card[] } | { kind: 'quiz'; questions: QuizQ[] } | null {
  const obj = parseJSONLoose<Record<string, unknown>>(text);
  if (!obj) return null;
  if (tool === 'flashcards') {
    const raw = (Array.isArray(obj) ? obj : (obj.cards as unknown[])) ?? [];
    const cards = (raw as Record<string, unknown>[])
      .map((c) => ({ front: String(c.front ?? c.q ?? c.question ?? ''), back: String(c.back ?? c.a ?? c.answer ?? ''), source: Number(c.source) || undefined }))
      .filter((c) => c.front && c.back);
    return cards.length ? { kind: 'flashcards', cards } : null;
  }
  const raw = (Array.isArray(obj) ? obj : (obj.questions as unknown[])) ?? [];
  const questions = (raw as Record<string, unknown>[])
    .map((q) => ({
      q: String(q.q ?? q.question ?? ''),
      choices: Array.isArray(q.choices) ? (q.choices as unknown[]).map(String).slice(0, 5) : [],
      answer:
        typeof q.answer === 'number'
          ? q.answer
          : Math.max(
              0,
              ['a', 'b', 'c', 'd', 'e'].indexOf(
                String(q.answer ?? '')
                  .toLowerCase()
                  .slice(0, 1),
              ),
            ),
      explain: q.explain ? String(q.explain) : undefined,
      source: Number(q.source) || undefined,
    }))
    .filter((q) => q.q && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length);
  return questions.length ? { kind: 'quiz', questions } : null;
}

/**
 * Keeps only the cards and questions an excerpt backs. The answer — a card's
 * back, a question's correct choice — must be supported by its source excerpt
 * (re-sourced when the model named the wrong one); the question side may not
 * invent names or numbers. A wrong choice identical to the key makes a
 * question unfair, so it is dropped.
 */
export function verifyStudy(
  parsed: { kind: 'flashcards'; cards: Card[] } | { kind: 'quiz'; questions: QuizQ[] },
  ctx: VerifyCtx,
): { json: string; dropped: number } {
  const allNotes = [...ctx.excerpts.values()].map((e) => `${e.title ?? ''} ${e.section ?? ''}\n${e.text}`).join('\n');
  const backed = (answer: string, ask: string, source?: number) => {
    if (novelTokens(ask, allNotes).length) return null;
    const c = checkStatement(answer, source ? [source] : [], { ...ctx, context: '' });
    // Shown without a caution label, so it must be fully backed (loosely matched isn't enough).
    if (c.verdict !== 'supported') return null;
    const n = c.repaired ?? source ?? c.cites[0];
    // …and the question must be about what that passage says: a true line under the wrong question is no card.
    const e = n ? ctx.excerpts.get(n) : undefined;
    return e && idfSupport(ask, `${e.title ?? ''} ${e.section ?? ''}\n${e.text}`, ctx.idf).support >= 0.5 ? n : null;
  };
  if (parsed.kind === 'flashcards') {
    const cards = parsed.cards.flatMap((c) => {
      const src = backed(c.back, c.front, c.source);
      return src ? [{ ...c, source: src }] : [];
    });
    return { json: JSON.stringify({ cards }), dropped: parsed.cards.length - cards.length };
  }
  const questions = parsed.questions.flatMap((q) => {
    const src = backed(q.choices[q.answer], q.q, q.source);
    if (!src) return [];
    const key = q.choices[q.answer].trim().toLowerCase();
    if (q.choices.some((ch, i) => i !== q.answer && ch.trim().toLowerCase() === key)) return [];
    // The explanation is shown as from the notes too: keep it only if it is.
    const explain = q.explain && checkStatement(q.explain, [src], { ...ctx, context: '' }).verdict === 'supported' ? q.explain : undefined;
    return [{ ...q, source: src, explain }];
  });
  return { json: JSON.stringify({ questions }), dropped: parsed.questions.length - questions.length };
}
