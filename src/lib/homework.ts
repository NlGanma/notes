import type { HomeworkMeta, NoteDoc } from './vault/types';
import { chunkNote, buildBm25, bm25Scores, tokenize } from './ai/rag';
import { docToText } from './ai/context';
import { HOMEWORK_SUBFOLDER } from './classes';

/** Homework: assignments whose AI help is grounded strictly in linked notes. */

export function isHomework(n: NoteDoc | undefined | null): boolean {
  return !!n?.meta.homework;
}

export function emptyHomework(): HomeworkMeta {
  return { sources: [], folders: [] };
}

/** Every note that counts as a source for this homework (explicit notes + notes in linked folders). */
export function homeworkSources(hw: NoteDoc, notes: Record<string, NoteDoc>): NoteDoc[] {
  const meta = hw.meta.homework;
  if (!meta) return [];
  const out = new Map<string, NoteDoc>();
  for (const id of meta.sources) {
    const n = notes[id];
    if (n && !n.meta.trashed && n.meta.id !== hw.meta.id) out.set(id, n);
  }
  for (const f of meta.folders) {
    for (const n of Object.values(notes)) {
      if (n.meta.trashed || n.meta.homework || n.meta.id === hw.meta.id) continue;
      if (!(n.meta.folder === f || n.meta.folder.startsWith(f + '/'))) continue;
      // Anything filed in the linked folder's Homework/ is the student's work, not class material.
      const rel = n.meta.folder.slice(f.length + 1);
      if (rel === HOMEWORK_SUBFOLDER || rel.startsWith(HOMEWORK_SUBFOLDER + '/')) continue;
      out.set(n.meta.id, n);
    }
  }
  return [...out.values()];
}

/** Notes filed in some folder's Homework/ (the student's own work, never a source). */
export function inHomeworkFolder(n: NoteDoc): boolean {
  return n.meta.folder.split('/').includes(HOMEWORK_SUBFOLDER);
}

export interface SourceSuggestion {
  note: NoteDoc;
  score: number;
  /** Words the homework and the note share — shown as the reason. */
  terms: string[];
}

/**
 * Suggests which notes cover a homework, by matching the homework's text (typed
 * questions, PDF text, transcripts and title) against every note.
 */
/** Words every assignment uses (and LaTeX commands) — they say nothing about the topic. */
const GENERIC = new Set(
  'problem problems question questions exercise exercises show work use using find evaluate explain answer answers method methods lecture lectures note notes page pages homework assignment due part parts step steps solve solution write given following each kind what where when true false prove justify compute calculate determine describe discuss frac lim left right cdot text mathrm mathbf sqrt infty times quad le ge leq geq neq approx sum int dx dy'.split(
    ' ',
  ),
);

export function suggestSources(hw: NoteDoc, notes: Record<string, NoteDoc>, k = 4, classPath?: string | null): SourceSuggestion[] {
  const raw = `${hw.meta.title} ${docToText(hw.content)}`.slice(0, 4000);
  const qTokens = new Set(tokenize(raw).filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t)));
  if (!qTokens.size) return [];
  const query = [...qTokens].join(' ');
  const candidates = Object.values(notes).filter(
    (n) => !n.meta.trashed && !n.meta.homework && !n.meta.generated && n.meta.id !== hw.meta.id && !n.meta.tags.includes('guide') && !inHomeworkFolder(n),
  );
  const chunks = candidates.flatMap(chunkNote);
  if (!chunks.length) return [];
  const scores = bm25Scores(buildBm25(chunks), query);
  const best = new Map<string, number>();
  // A note's score is its best section plus a little for every other matching section;
  // notes from the homework's own class get a boost.
  chunks.forEach((c, i) => {
    const boost = classPath && (c.folder === classPath || c.folder.startsWith(classPath + '/')) ? 1.35 : 1;
    best.set(c.noteId, Math.max(best.get(c.noteId) ?? 0, scores[i] * boost) + scores[i] * 0.15);
  });
  const top = Math.max(0, ...best.values());
  return [...best.entries()]
    .filter(([, s]) => s > 0.8 && s >= top * 0.35)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => {
      const note = notes[id];
      const noteTokens = new Set(tokenize(`${note.meta.title} ${docToText(note.content)}`));
      const terms = [...qTokens].filter((t) => noteTokens.has(t) && t.length > 3).slice(0, 4);
      return { note, score, terms };
    });
}

/**
 * Days from today to a due date's day: 0 today, 1 tomorrow, negative once past. Counted midnight to
 * midnight, so a clock change in between (a 23 or 25 hour day) can't shift a deadline by a day.
 */
export function daysFrom(due: number, now = Date.now()): number {
  return Math.round((new Date(due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
}

/** A due date in words: 'Today', 'Tomorrow', the weekday within a week, else 'Oct 28'. */
export function dueDay(due: number, now = Date.now(), weekday: 'long' | 'short' = 'long'): string {
  const days = daysFrom(due, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return new Date(due).toLocaleDateString(undefined, { weekday });
  return new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The due time, unless it's the default end of day (Google hides 11:59 PM). */
export function dueTime(due: number): string {
  const d = new Date(due);
  if (d.getHours() === 23 && d.getMinutes() >= 59) return '';
  if (d.getHours() === 0 && d.getMinutes() === 0) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Past its due date and not done: Classroom's "Missing". */
export function isMissing(hw: { done?: boolean; due?: number } | undefined, now = Date.now()): boolean {
  if (!hw || hw.done || !hw.due) return false;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  return hw.due < startToday.getTime();
}

export function dueLabel(due?: number, now = Date.now()): { text: string; tone: 'overdue' | 'soon' | 'later' } | null {
  if (!due) return null;
  const days = daysFrom(due, now);
  if (days < 0) return { text: `Overdue · ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (days < 7) return { text: `Due ${new Date(due).toLocaleDateString(undefined, { weekday: 'long' })}`, tone: days < 3 ? 'soon' : 'later' };
  return { text: `Due ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, tone: 'later' };
}
