import type { CSSProperties, ReactNode } from 'react';
import { Target } from 'lucide-react';
import { themeFor, themeVars } from '../../lib/classes';
import { isDue, isMastered } from '../../lib/review/mastery';
import { conceptsOf, type ReviewFile } from '../../state/review';
import type { NoteDoc } from '../../lib/vault/types';
import { cx } from '../../lib/util';

/** Quizlet's three buckets for a set of ideas, plus what's due now and when the next one is. */
export interface IdeaCounts {
  total: number;
  /** Never answered ("Not studied"; Anki's "New"). */
  fresh: number;
  /** Answered, not mastered yet ("Still learning"). */
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

/** The class letter avatar, as in the navigation drawer. */
export function ClassLetter({ name, color, small }: { name: string; color?: string; small?: boolean }) {
  return (
    <span className={cx('class-letter', small && 'is-small', !color && 'rv-letter-plain')} style={classStyle(color)} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

/** M3 switch (the shared .switch), as a labelled control. */
export function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <span className={cx('switch', checked && 'is-on', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

/** A small progress dial: the share of a total, in one colour, with the count inside (like the summary donut). */
export function Ring({ value, total, tone, children }: { value: number; total: number; tone: 'fresh' | 'learning' | 'mastered'; children?: ReactNode }) {
  const r = 14.5;
  const len = 2 * Math.PI * r;
  const part = total ? Math.min(1, value / total) : 0;
  return (
    <span className="rv-ring-wrap">
      <svg className={cx('rv-ring', `is-${tone}`)} width="32" height="32" viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r={r} className="rv-ring-track" />
        {part > 0 && <circle cx="16" cy="16" r={r} className="rv-ring-fill" strokeDasharray={`${part * len} ${len}`} transform="rotate(-90 16 16)" />}
      </svg>
      <span className="rv-ring-n">{children}</span>
    </span>
  );
}

/** Quizlet's "How you're doing" donut: mastered, then still learning, on a grey track. */
export function Donut({ mastered, learning, total, children }: { mastered: number; learning: number; total: number; children?: ReactNode }) {
  const r = 52;
  const len = 2 * Math.PI * r;
  const gap = 3;
  const arc = (n: number) => (total ? (n / total) * len : 0);
  const a = arc(mastered);
  const b = arc(learning);
  return (
    <div className="rv-donut">
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden>
        <circle cx="60" cy="60" r={r} className="rv-donut-track" />
        {a > 0 && <circle cx="60" cy="60" r={r} className="rv-donut-arc is-mastered" strokeDasharray={`${Math.max(0, a - (b > 0 ? gap : 0))} ${len}`} transform="rotate(-90 60 60)" />}
        {b > 0 && (
          <circle
            cx="60"
            cy="60"
            r={r}
            className="rv-donut-arc is-learning"
            strokeDasharray={`${Math.max(0, b - (a > 0 ? gap : 0))} ${len}`}
            transform={`rotate(${-90 + (a / len) * 360} 60 60)`}
          />
        )}
      </svg>
      <div className="rv-donut-centre">{children}</div>
    </div>
  );
}

/** The bar at the top of a study session (Quizlet's study-mode header): mode on the left, title centred, actions right. */
export function StudyBar({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rv-topbar">
      <div className="rv-mode">
        <Target size={20} />
        <span>Review</span>
      </div>
      <div className="rv-topbar-label" title={title}>
        {title}
      </div>
      <div className="rv-topbar-actions">{children}</div>
    </div>
  );
}

/** A key, as Quizlet's SHORTCUT tip shows it. */
export const Key = ({ children }: { children: ReactNode }) => <kbd className="rv-key">{children}</kbd>;
