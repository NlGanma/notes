import type { HomeworkMeta, NoteDoc } from './vault/types';
import { chunkNote, buildBm25, bm25Scores, tokenize } from './ai/rag';
import { docToText } from './ai/context';

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
      if (n.meta.folder === f || n.meta.folder.startsWith(f + '/')) out.set(n.meta.id, n);
    }
  }
  return [...out.values()];
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
  const candidates = Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && n.meta.id !== hw.meta.id && !n.meta.tags.includes('guide'));
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

export function dueLabel(due?: number, now = Date.now()): { text: string; tone: 'overdue' | 'soon' | 'later' } | null {
  if (!due) return null;
  const day = 86_400_000;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const days = Math.floor((due - startToday.getTime()) / day);
  if (days < 0) return { text: `Overdue · ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (days < 7) return { text: `Due ${new Date(due).toLocaleDateString(undefined, { weekday: 'long' })}`, tone: days < 3 ? 'soon' : 'later' };
  return { text: `Due ${new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, tone: 'later' };
}
