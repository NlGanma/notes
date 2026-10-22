import type { JSONContent } from '@tiptap/core';
import type { FolderMeta, NoteDoc } from '../../lib/vault/types';
import type { Chunk, Scope } from '../../lib/ai/rag';
import type { StudyTool } from '../../lib/ai/prompts';
import { classForFolder, classInfo, type ClassInfo } from '../../lib/classes';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { toast } from '../common/toast';

/**
 * "Ask your notes" works like a NotebookLM notebook: a set of notes (all of
 * them, or one class or folder) shown in the Sources panel, each with a
 * checkbox. The ticked ones are the `Scope` the chat and the study tools use.
 */
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
    .sort((a, b) => a.meta.folder.localeCompare(b.meta.folder) || (a.meta.title || 'Untitled').localeCompare(b.meta.title || 'Untitled', undefined, { numeric: true }));
}

export function sameNotebook(a: Notebook, b: Notebook) {
  return a.kind === b.kind && (a.kind === 'all' || a.path === (b as { path: string }).path);
}

// The notebook a partial selection belongs to, across visits to the page (the scope itself only keeps the ids).
let lastNotebook: Notebook | null = null;

/** The notebook a scope was picked from. A list of notes keeps the notebook it was ticked in. */
export function notebookFor(scope: Scope, notes: Record<string, NoteDoc>, folderMeta: Record<string, FolderMeta>): Notebook {
  if (scope.kind === 'all') return (lastNotebook = { kind: 'all' });
  if (scope.kind === 'folder') return (lastNotebook = { kind: 'folder', path: scope.path });
  const ids = scope.kind === 'note' ? [scope.id] : scope.kind === 'notes' ? scope.ids : [];
  if (lastNotebook && ids.every((id) => notes[id] && inNotebook(notes[id], lastNotebook!))) return lastNotebook;
  if (scope.kind === 'tag' || !ids.length) return { kind: 'all' };
  const classes = new Set(ids.map((id) => (notes[id] ? classForFolder(notes[id].meta.folder, folderMeta) : null)));
  const only = classes.size === 1 ? [...classes][0] : null;
  return only ? { kind: 'folder', path: only } : { kind: 'all' };
}

/** Which of the notebook's notes the scope ticks. */
export function checkedIn(scope: Scope, list: NoteDoc[]): Set<string> {
  switch (scope.kind) {
    case 'all':
    case 'folder':
      return new Set(list.map((n) => n.meta.id));
    case 'tag':
      return new Set(list.filter((n) => n.meta.tags.includes(scope.tag)).map((n) => n.meta.id));
    case 'note':
      return new Set([scope.id]);
    case 'notes': {
      const want = new Set(scope.ids);
      return new Set(list.filter((n) => want.has(n.meta.id)).map((n) => n.meta.id));
    }
  }
}

/** Every note ticked → the notebook's own scope (so new notes join it); otherwise exactly the ticked ones. */
export function scopeFor(nb: Notebook, checked: Set<string>, list: NoteDoc[]): Scope {
  if (list.length > 0 && list.every((n) => checked.has(n.meta.id))) return nb.kind === 'all' ? { kind: 'all' } : { kind: 'folder', path: nb.path };
  return { kind: 'notes', ids: list.filter((n) => checked.has(n.meta.id)).map((n) => n.meta.id) };
}

export function notebookClass(nb: Notebook, folderMeta: Record<string, FolderMeta>): ClassInfo | null {
  return nb.kind === 'folder' && folderMeta[nb.path]?.kind === 'class' ? classInfo(nb.path, folderMeta[nb.path]) : null;
}

export function notebookTitle(nb: Notebook, folderMeta: Record<string, FolderMeta>): string {
  if (nb.kind === 'all') return 'All notes';
  return notebookClass(nb, folderMeta)?.name ?? nb.path.split('/').pop()!;
}

/** Scanned pages and pictures read like NotebookLM's PDF sources; everything else is a note. */
export function isScan(n: NoteDoc): boolean {
  const blocks = n.content.content ?? [];
  return blocks.some((b) => b.type === 'image') && !blocks.some((b) => b.type === 'heading');
}

/** A heading's words as they'd sit mid-sentence ("Limit laws" → "limit laws", "French Revolution" stays). */
function midSentence(h: string): string {
  return /[A-Z]/.test(h.slice(1)) ? h : h.charAt(0).toLowerCase() + h.slice(1);
}

const GENERIC = /^(notes?|summary|overview|sources|introduction|intro|key events|causes|vocabulario|vocabulary|example|examples|worked example.*)$/i;

/** Section headings of course notes, in note order (guides and empty sections left out). */
export function topicsOf(chunks: Chunk[], notes: Record<string, NoteDoc>): { noteId: string; topic: string }[] {
  const out: { noteId: string; topic: string }[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (notes[c.noteId]?.meta.tags.includes('guide')) continue;
    const t = c.section
      .split(' › ')
      .pop()
      ?.replace(/\(.*?\)/g, '')
      .trim();
    if (!t || t.length > 40 || GENERIC.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ noteId: c.noteId, topic: t });
  }
  return out;
}

const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The notebook overview under the title: what the ticked notes cover, from
 * their own headings (no model call, so it can't say anything the notes don't).
 */
export function overviewMarkdown(chunks: Chunk[], notes: Record<string, NoteDoc>, folderMeta: Record<string, FolderMeta>, nb: Notebook): string {
  const topics = topicsOf(chunks, notes);
  if (!topics.length) return '';
  if (nb.kind === 'folder') {
    const picked = topics.slice(0, 6).map((t) => `**${midSentence(t.topic)}**`);
    return `These notes cover ${listOf(picked)}${topics.length > 6 ? ', among other things' : ''}.`;
  }
  // All notes: the classes first, then a couple of topics from each.
  const byClass = new Map<string, string[]>();
  for (const t of topics) {
    const c = classForFolder(notes[t.noteId]?.meta.folder ?? '', folderMeta);
    const name = c ? classInfo(c, folderMeta[c]).name : '';
    if (!byClass.has(name)) byClass.set(name, []);
    byClass.get(name)!.push(t.topic);
  }
  const classes = [...byClass.keys()].filter(Boolean);
  const picked = [...byClass.values()].flatMap((ts) => ts.slice(0, 1)).slice(0, 6).map((t) => `**${midSentence(t)}**`);
  const span = classes.length > 1 ? `These notes span ${classes.length} classes — ${listOf(classes)} — and cover` : 'These notes cover';
  return `${span} topics such as ${listOf(picked)}.`;
}

/** Turns a section heading into a natural question ("Limit laws" → "What are the limit laws?"). */
export function questionFor(heading: string): string {
  const h = midSentence(heading);
  if (/^(definition|meaning) of /i.test(heading)) return `What's the ${h}?`;
  if (/theorem|principle|rule$|law$/i.test(heading)) return `What does the ${h} say?`;
  if (/(laws|rules|equations|formulas)$/i.test(heading)) return `What are the ${h}?`;
  if (/^(worked example|example)/i.test(heading)) return 'Walk me through the worked example';
  if (/ vs\.? /i.test(heading)) return `What's the difference: ${h}?`;
  return `Explain ${h}`;
}

/** How each study tool is drawn: NotebookLM's per-tool pastel and ink (no purples). */
export const TOOL_LOOK: Record<StudyTool | 'review', { name: string; noun: string; bg: string; ink: string }> = {
  guide: { name: 'Study guide', noun: 'study guide', bg: '#f1f1e7', ink: '#786631' },
  summary: { name: 'Summary', noun: 'summary', bg: '#dfefe4', ink: '#0f5222' },
  terms: { name: 'Key terms', noun: 'key terms', bg: '#ebedf9', ink: '#214484' },
  flashcards: { name: 'Flashcards', noun: 'flashcards', bg: '#f5ebea', ink: '#8b2e2a' },
  quiz: { name: 'Quiz', noun: 'quiz', bg: '#def0f6', ink: '#056a94' },
  review: { name: 'Review', noun: 'review', bg: '#f6eddc', ink: '#7a4b00' },
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
    toast.info('Saved to note', title, { label: 'Open', run: () => useUI.getState().openNote(doc.meta.id, { newTab: true }) });
    return doc.meta.id;
  } catch (e) {
    toast.error('Couldn’t save the note', String(e));
    return null;
  }
}
