import type { JSONContent } from '@tiptap/core';
import type { FolderMeta, NoteDoc } from '../../lib/vault/types';
import type { Scope } from '../../lib/ai/rag';
import type { StudyTool } from '../../lib/ai/prompts';
import type { SourceSelection } from '../homework/sources';
import { classInfo } from '../../lib/classes';
import { displayTitle } from '../../lib/displayTitle';
import { plural } from '../../lib/util';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { toast } from '../common/toast';
import { friendlyError } from '../../lib/ai/errors';

/** A set of notes Ask your notes reads from as a whole: every note, or one class or folder. */
export type Notebook = { kind: 'all' } | { kind: 'folder'; path: string };

/** Same rules as chunkVault for these scopes: no trash, no homework, nothing the AI wrote, no class Homework/ folder. */
function inNotebook(n: NoteDoc, nb: Notebook): boolean {
  if (n.meta.trashed || n.meta.homework || n.meta.generated) return false;
  if (nb.kind === 'all') return true;
  const f = n.meta.folder;
  if (!(f === nb.path || f.startsWith(nb.path + '/'))) return false;
  const rel = f.slice(nb.path.length + 1);
  return rel !== 'Homework' && !rel.startsWith('Homework/');
}

export function notebookNotes(notes: Record<string, NoteDoc>, nb: Notebook): NoteDoc[] {
  return Object.values(notes)
    .filter((n) => inNotebook(n, nb))
    .sort((a, b) => a.meta.folder.localeCompare(b.meta.folder) || displayTitle(a).localeCompare(displayTitle(b), undefined, { numeric: true }));
}

/** The notes a scope reads from (a picked note that's gone since no longer counts). */
export function scopeNotes(scope: Scope, notes: Record<string, NoteDoc>): NoteDoc[] {
  switch (scope.kind) {
    case 'folder':
      return notebookNotes(notes, { kind: 'folder', path: scope.path });
    case 'note':
      return notes[scope.id] && !notes[scope.id].meta.trashed ? [notes[scope.id]] : [];
    case 'notes':
      return scope.ids.map((id) => notes[id]).filter((n) => n && !n.meta.trashed);
    default:
      return notebookNotes(notes, { kind: 'all' });
  }
}

/** What the scope chip and the page call a scope: All notes, a class or folder, one note's name, or "3 notes". */
export function scopeName(scope: Scope, notes: Record<string, NoteDoc>, folderMeta: Record<string, FolderMeta>): string {
  switch (scope.kind) {
    case 'folder':
      return folderMeta[scope.path]?.kind === 'class' ? classInfo(scope.path, folderMeta[scope.path]).name : scope.path.split('/').pop()!;
    case 'note':
    case 'notes': {
      const list = scopeNotes(scope, notes);
      return list.length === 1 ? displayTitle(list[0]) : plural(list.length, 'note');
    }
    default:
      return 'All notes';
  }
}

/** The Choose notes… picker's starting ticks for a scope. */
export function selectionFor(scope: Scope): SourceSelection {
  if (scope.kind === 'folder') return { sources: [], folders: [scope.path] };
  if (scope.kind === 'note') return { sources: [scope.id], folders: [] };
  if (scope.kind === 'notes') return { sources: [...scope.ids], folders: [] };
  return { sources: [], folders: [] };
}

/**
 * What Choose notes… picked, as a scope: one folder on its own stays that folder (new notes in it count);
 * anything else becomes the list of notes, with each picked folder read the way a notebook is, so homework
 * and notes the AI wrote never become something an answer cites as "your notes".
 */
export function scopeFromPick(sel: SourceSelection, notes: Record<string, NoteDoc>): Scope {
  const inPicked = (n: NoteDoc) => sel.folders.some((f) => n.meta.folder === f || n.meta.folder.startsWith(f + '/'));
  const loose = sel.sources.map((id) => notes[id]).filter((n) => n && !inPicked(n) && inNotebook(n, { kind: 'all' }));
  if (sel.folders.length === 1 && !loose.length) return { kind: 'folder', path: sel.folders[0] };
  const ids = new Set(loose.map((n) => n.meta.id));
  for (const f of sel.folders) for (const n of notebookNotes(notes, { kind: 'folder', path: f })) ids.add(n.meta.id);
  return ids.size ? { kind: 'notes', ids: [...ids] } : { kind: 'all' };
}

/** How each study tool is named. */
export const TOOL_LOOK: Record<StudyTool | 'review', { name: string; noun: string }> = {
  summary: { name: 'Summary', noun: 'summary' },
  guide: { name: 'Study guide', noun: 'study guide' },
  terms: { name: 'Key terms', noun: 'key terms' },
  flashcards: { name: 'Flashcards', noun: 'flashcards' },
  quiz: { name: 'Quiz', noun: 'quiz' },
  review: { name: 'Review', noun: 'review' },
};

/** Saves Markdown (an answer, a study guide) as a note in the notebook's class; the AI wrote it, so it's never cited back. */
export async function saveMarkdownNote(title: string, md: string, folder: string, tags: string[] = []): Promise<string | null> {
  try {
    const [{ generateJSON }, { buildExtensions }, { normalizeDocJSON }, { markdownToEditorHTML }] = await Promise.all([
      import('@tiptap/core'),
      import('../../editor/extensions'),
      import('../../editor/extensions/blockAttrs'),
      import('../../lib/ai/markdown'),
    ]);
    const html = markdownToEditorHTML(md, { stripCitations: true });
    const content = normalizeDocJSON(generateJSON(html, buildExtensions()) as never) as JSONContent;
    const doc = useVault.getState().createNote({ folder, title, content, tags, generated: true });
    toast.info('Saved as a note', title, { label: 'Open', run: () => useUI.getState().openNote(doc.meta.id) });
    return doc.meta.id;
  } catch (e) {
    toast.error('Couldn’t save the note', friendlyError(e));
    return null;
  }
}
