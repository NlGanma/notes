import type { FolderMeta, NoteDoc } from '../vault/types';
import { classForFolder, HOMEWORK_SUBFOLDER, listClasses, type ClassInfo } from '../classes';
import { displayTitle } from '../displayTitle';
import { unreadSections } from './concepts';

/**
 * What can be reviewed, organised the way the student already filed it:
 * class › chapter › note. A chapter is a subfolder of the class (nested
 * subfolders are listed as "Unit 3 › Week 2"); notes filed directly in the
 * class are its "General" chapter. Notes outside any class are grouped by
 * their top folder. Homework and the app's guide notes are never review
 * material.
 */

export interface ReviewChapter {
  /** Folder path; '' for a class's own top level. */
  path: string;
  name: string;
  notes: NoteDoc[];
}

export interface ReviewGroup {
  /** Class path, or `folder:<top folder>` / `folder:` (unfiled) for notes outside classes. */
  key: string;
  name: string;
  cls: ClassInfo | null;
  chapters: ReviewChapter[];
}

export const GENERAL_CHAPTER = 'General';

export function isReviewable(n: NoteDoc): boolean {
  if (n.meta.trashed || n.meta.homework || n.meta.generated || n.meta.tags.includes('guide')) return false;
  const parts = n.meta.folder.split('/');
  return !parts.includes(HOMEWORK_SUBFOLDER);
}

const byTitle = (a: NoteDoc, b: NoteDoc) => (a.meta.title || '').localeCompare(b.meta.title || '', undefined, { numeric: true });
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function buildReviewTree(notes: Record<string, NoteDoc>, folders: string[], folderMeta: Record<string, FolderMeta>): ReviewGroup[] {
  const classes = listClasses(folders, folderMeta);
  const groups = new Map<string, ReviewGroup>();
  for (const c of classes) groups.set(c.path, { key: c.path, name: c.name, cls: c, chapters: [] });
  const chapterOf = (g: ReviewGroup, path: string, name: string) => {
    let ch = g.chapters.find((c) => c.path === path);
    if (!ch) {
      ch = { path, name, notes: [] };
      g.chapters.push(ch);
    }
    return ch;
  };
  for (const n of Object.values(notes)) {
    if (!isReviewable(n)) continue;
    const folder = n.meta.folder;
    const cls = classForFolder(folder, folderMeta);
    if (cls && groups.has(cls)) {
      const g = groups.get(cls)!;
      const rel = folder.slice(cls.length + 1);
      chapterOf(g, rel ? folder : '', rel ? rel.split('/').join(' › ') : GENERAL_CHAPTER).notes.push(n);
      continue;
    }
    // Archived classes and plain folders: grouped by their top folder.
    const top = folder.split('/')[0] ?? '';
    const key = `folder:${top}`;
    if (!groups.has(key)) groups.set(key, { key, name: top || 'Unfiled', cls: null, chapters: [] });
    const g = groups.get(key)!;
    const rel = folder.slice(top.length + 1);
    chapterOf(g, rel ? folder : '', rel ? rel.split('/').join(' › ') : GENERAL_CHAPTER).notes.push(n);
  }
  const out = [...groups.values()].filter((g) => g.chapters.length);
  for (const g of out) {
    g.chapters.sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : byName(a, b)));
    for (const ch of g.chapters) ch.notes.sort(byTitle);
  }
  // Classes first (in sidebar order), then other folders, unfiled last.
  return out.sort((a, b) => {
    if (!!a.cls !== !!b.cls) return a.cls ? -1 : 1;
    if (a.cls && b.cls) return classes.indexOf(a.cls) - classes.indexOf(b.cls);
    if (a.key === 'folder:') return 1;
    if (b.key === 'folder:') return -1;
    return byName(a, b);
  });
}

/** Short description of a selection, e.g. "Calculus I + Spanish II · 3 notes". */
export function selectionLabel(groups: ReviewGroup[], ids: Set<string>): string {
  const names = groups.filter((g) => g.chapters.some((c) => c.notes.some((n) => ids.has(n.meta.id)))).map((g) => g.name);
  const count = ids.size;
  const who = names.length <= 2 ? names.join(' + ') : `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
  return `${who}${who ? ' · ' : ''}${count} ${count === 1 ? 'note' : 'notes'}`;
}

/** Where a note's unread handwriting is, as the student knows the note: "Lecture 4 › Worked example", or just its name. */
export function unreadLabels(note: NoteDoc): string[] {
  const name = displayTitle(note);
  return [...new Set(unreadSections(note).map((s) => (s ? `${name} › ${s}` : name)))];
}

/** The class (or folder group) a note belongs to, for interleaving across classes. */
export function groupKeyOf(n: NoteDoc, folderMeta: Record<string, FolderMeta>): string {
  const cls = classForFolder(n.meta.folder, folderMeta);
  return cls && !folderMeta[cls]?.archived ? cls : `folder:${n.meta.folder.split('/')[0] ?? ''}`;
}

