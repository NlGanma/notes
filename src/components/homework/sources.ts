import type { FolderMeta, NoteDoc } from '../../lib/vault/types';
import { classInfo, inFolder } from '../../lib/classes';
import { daysFrom, dueTime } from '../../lib/homework';
import { plural } from '../../lib/util';

/*
 * Homework helpers for the lists and dialogs: what a homework answers from, and when it's due, in the
 * words the lists use ("Overdue · Oct 20", never "Missing").
 */

/** What a homework's answers may come from: single notes plus whole folders (classes or units). */
export interface SourceSelection {
  sources: string[];
  folders: string[];
}

/** A folder's display name: the class name for a class, else its last path segment. */
export function folderName(path: string, folderMeta: Record<string, FolderMeta>): string {
  return folderMeta[path]?.kind === 'class' ? classInfo(path, folderMeta[path]).name : path.split('/').pop() || path;
}

/** A selection in words: "All Calculus I notes + 1 note", "3 notes", or ''. */
export function summarize(sel: SourceSelection, notes: Record<string, NoteDoc>, folderMeta: Record<string, FolderMeta>): string {
  const loose = sel.sources.filter((id) => {
    const n = notes[id];
    return n && !n.meta.trashed && !sel.folders.some((f) => inFolder(n, f));
  });
  const parts = sel.folders.map((f) => `All ${folderName(f, folderMeta)} notes`);
  if (loose.length) parts.push(plural(loose.length, 'note'));
  return parts.join(' + ');
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

export const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** When a note was last edited: the time today, else the date. */
export function editedLabel(t: number, now = Date.now()): string {
  if (startOfDay(t) === startOfDay(now)) return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** The homework list's groups, in order (Things / Reminders). Done homework is listed apart from these. */
export type DueGroup = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';
export const DUE_GROUPS: { key: DueGroup; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  // The next seven days from today, whatever the weekday (a calendar week once hid a deadline two days out).
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
];

/** Which group a due date falls in. The days count from today, whatever the weekday. */
export function dueGroup(due: number | undefined, now = Date.now()): DueGroup {
  if (!due) return 'none';
  const days = daysFrom(due, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}

/** Soonest due first; homework without a date last, newest first. */
export function byDue(a: NoteDoc, b: NoteDoc): number {
  const da = a.meta.homework?.due ?? Infinity;
  const db = b.meta.homework?.due ?? Infinity;
  if (da !== db) return da - db;
  return b.meta.created - a.meta.created;
}

/** Unfinished homework in its non-empty groups, each soonest first. `held` ones were ticked a moment ago and stay put for now. */
export function groupHomework(list: NoteDoc[], now = Date.now(), held: ReadonlySet<string> = new Set()): { key: DueGroup; label: string; items: NoteDoc[] }[] {
  const todo = list.filter((n) => n.meta.homework && (!n.meta.homework.done || held.has(n.meta.id))).sort(byDue);
  return DUE_GROUPS.map((g) => ({ ...g, items: todo.filter((n) => dueGroup(n.meta.homework!.due, now) === g.key) })).filter((g) => g.items.length);
}

/**
 * A row's due text inside its group, saying only what the group doesn't: the time today and tomorrow,
 * the weekday this week, the date later on or when overdue.
 */
export function dueInGroup(due: number | undefined, now = Date.now()): { text: string; overdue?: boolean } | null {
  if (!due) return null;
  const g = dueGroup(due, now);
  const time = dueTime(due);
  const d = new Date(due);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  if (g === 'overdue') return { text: date, overdue: true };
  if (g === 'today' || g === 'tomorrow') return time ? { text: time } : null;
  if (g === 'week') return { text: [d.toLocaleDateString(undefined, { weekday: 'long' }), time].filter(Boolean).join(', ') };
  return { text: date };
}
