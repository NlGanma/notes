import type { NoteDoc } from './vault/types';
import { displayTitle, isDateTitle } from './displayTitle';

// By hand, like displayTitle's dates, so a tab reads the same on every machine.
export function clockTime(t: number): string {
  const d = new Date(t);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What each open tab says (`label`) and its full name for the tooltip and menus (`full`).
 * Untitled notes that go by the same name are told apart by the time they were made. A name that is only
 * the date they were made ("Note · Oct 23") becomes that time ("12:52 PM"; the tab's icon already says note
 * or homework), so the part that differs fits in the narrowest tab. Any other name gets the time after it.
 * Made in the same minute: 2, 3… by creation order.
 */
export function tabLabels(notes: NoteDoc[]): Map<string, { label: string; full: string }> {
  const groups = new Map<string, NoteDoc[]>();
  for (const n of notes) groups.set(displayTitle(n), [...(groups.get(displayTitle(n)) ?? []), n]);
  const out = new Map<string, { label: string; full: string }>();
  for (const [name, group] of groups) {
    const untitled = group.filter((n) => !n.meta.title.trim()).sort((a, b) => a.meta.created - b.meta.created || a.meta.id.localeCompare(b.meta.id));
    for (const n of group) out.set(n.meta.id, { label: name, full: name });
    if (group.length < 2) continue;
    const seen = new Map<string, number>();
    for (const n of untitled) {
      const time = clockTime(n.meta.created);
      const k = (seen.get(time) ?? 0) + 1;
      seen.set(time, k);
      const nth = k > 1 ? ` ${k}` : '';
      // A homework's due date means something, so it stays; only the date a note was made gives way.
      const madeOn = isDateTitle(n) && !n.meta.homework?.due;
      out.set(n.meta.id, {
        label: madeOn ? `${time}${nth}` : `${name}, ${time}${nth}`,
        full: `${name}, ${time}${nth}`,
      });
    }
  }
  return out;
}
