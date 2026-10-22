import type { FolderMeta, NoteDoc } from '../../lib/vault/types';
import { classInfo, inFolder } from '../../lib/classes';
import { dueTime } from '../../lib/homework';
import { plural } from '../../lib/util';

/** What a homework's answers may come from: single notes plus whole folders (classes or units). */
export interface SourceSelection {
  sources: string[];
  folders: string[];
}

/** A folder's display name: the class name for a class, else its last path segment. */
export function folderName(path: string, folderMeta: Record<string, FolderMeta>): string {
  return folderMeta[path]?.kind === 'class' ? classInfo(path, folderMeta[path]).name : path.split('/').pop() || path;
}

/** Classroom-style summary of a selection: "All Calculus I notes + 1 note", "3 notes", or ''. */
export function summarize(sel: SourceSelection, notes: Record<string, NoteDoc>, folderMeta: Record<string, FolderMeta>): string {
  const loose = sel.sources.filter((id) => {
    const n = notes[id];
    return n && !n.meta.trashed && !sel.folders.some((f) => inFolder(n, f));
  });
  const parts = sel.folders.map((f) => `All ${folderName(f, folderMeta)} notes`);
  if (loose.length) parts.push(plural(loose.length, 'note'));
  return parts.join(' + ');
}

export const sameSelection = (a: SourceSelection, b: SourceSelection) =>
  a.sources.length === b.sources.length &&
  a.folders.length === b.folders.length &&
  a.sources.every((s) => b.sources.includes(s)) &&
  a.folders.every((f) => b.folders.includes(f));

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** "Due today", "Due tomorrow", "Due Sat, Oct 25" (+ ", 3:00 PM" unless it's the default end of day). */
export function dueLine(due: number, now = Date.now()): string {
  const days = Math.floor((startOfDay(due) - startOfDay(now)) / DAY);
  const day =
    days === 0 ? 'today' : days === 1 ? 'tomorrow' : new Date(due).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = dueTime(due);
  return `Due ${day}${time ? `, ${time}` : ''}`;
}

export const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Drive's "Last modified": the time for today, else the date. */
export function editedLabel(t: number, now = Date.now()): string {
  if (startOfDay(t) === startOfDay(now)) return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
