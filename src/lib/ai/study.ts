import { parseJSONLoose } from './json';

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
