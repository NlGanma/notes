import type { CSSProperties, ReactNode } from 'react';
import { Folder } from 'lucide-react';
import { themeFor, themeVars } from '../../lib/classes';
import { isDue, isMastered } from '../../lib/review/mastery';
import { conceptsOf, type ReviewFile } from '../../state/review';
import type { NoteDoc } from '../../lib/vault/types';
import { cx } from '../../lib/util';

/** A set of ideas by how far along they are, plus what's due now and when the next one is. */
export interface IdeaCounts {
  total: number;
  /** Never answered (Anki's "New"). */
  fresh: number;
  /** Answered, not mastered yet. */
  learning: number;
  mastered: number;
  due: number;
  next: number | null;
  /** 0–100, or null when none of the ideas was answered yet. */
  mastery: number | null;
}

export const NO_COUNTS: IdeaCounts = { total: 0, fresh: 0, learning: 0, mastered: 0, due: 0, next: null, mastery: null };

export function countIdeas(notes: NoteDoc[], file: ReviewFile, now = Date.now()): IdeaCounts {
  const c = { ...NO_COUNTS };
  let seen = 0;
  for (const n of notes) {
    for (const idea of conceptsOf(n, file)) {
      const st = file.states[idea.id];
      c.total++;
      if (!st?.attempts) {
        c.fresh++;
        continue;
      }
      seen++;
      if (isMastered(st, idea.cap, idea.needs)) c.mastered++;
      else c.learning++;
      if (isDue(st, now)) c.due++;
      else c.next = Math.min(c.next ?? st.due, st.due);
    }
  }
  // As the picker always showed a note's mastery: what's mastered, or a sliver for what's been started.
  if (seen) c.mastery = Math.round((c.mastered / c.total) * 100) || Math.min(99, Math.round((seen / c.total) * 20));
  return c;
}

export function addCounts(list: IdeaCounts[]): IdeaCounts {
  const c = { ...NO_COUNTS };
  let weighted = 0;
  let seen = false;
  for (const x of list) {
    c.total += x.total;
    c.fresh += x.fresh;
    c.learning += x.learning;
    c.mastered += x.mastered;
    c.due += x.due;
    if (x.next !== null) c.next = Math.min(c.next ?? x.next, x.next);
    if (x.mastery !== null) {
      seen = true;
      weighted += x.mastery * x.total;
    }
  }
  if (seen) c.mastery = Math.round(weighted / Math.max(1, c.total));
  return c;
}

/** A class's theme as CSS variables (--class-main, --class-light…), from its stored colour. */
export const classStyle = (color?: string): CSSProperties | undefined => (color ? (themeVars(themeFor(color)) as CSSProperties) : undefined);

/** A class's colour square, as in the sidebar; a folder icon for notes outside any class. */
export function GroupMark({ color }: { color?: string }) {
  return color ? <span className="class-square" style={{ background: color }} aria-hidden /> : <Folder size={16} strokeWidth={1.5} className="rv-folder" aria-hidden />;
}

/** The shared switch, as a labelled control. */
export function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <span className={cx('switch', checked && 'is-on', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export const Key = ({ children }: { children: ReactNode }) => <kbd className="rv-key">{children}</kbd>;
