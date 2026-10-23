import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '../../lib/util';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// 4 Jan 2026 is a Sunday: the weekday initials in the user's locale, Sunday first.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));

/**
 * A month to pick a due date from: one click on a day sets it. Today is ringed, the due day filled.
 * A due date keeps its time of day; a new one is due at the end of the day (11:59 PM).
 */
export function DuePicker({ value, onDone }: { value?: number; onDone(due: number | undefined): void }) {
  const [month, setMonth] = useState(() => {
    const d = value ? new Date(value) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const sel = value ? new Date(value) : null;
  const today = new Date();
  const lead = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  const pick = (d: Date) => onDone(new Date(d.getFullYear(), d.getMonth(), d.getDate(), sel?.getHours() ?? 23, sel ? sel.getMinutes() : 59).getTime());

  return (
    <div className="due-picker" role="dialog" aria-label="Due date">
      <div className="due-picker-head">
        <span className="due-picker-month">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="icon-btn is-tiny" onClick={() => shift(-1)} aria-label="Previous month">
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <button className="icon-btn is-tiny" onClick={() => shift(1)} aria-label="Next month">
          <ChevronRight size={16} strokeWidth={1.5} />
        </button>
      </div>
      <div className="due-picker-grid" role="grid">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="due-picker-wd" aria-hidden>
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
          const on = !!sel && sameDay(d, sel);
          return (
            <button
              key={i}
              className={cx('due-picker-day', on && 'is-selected', sameDay(d, today) && 'is-today')}
              aria-pressed={on}
              aria-label={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              onClick={() => pick(d)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <div className="due-picker-foot">
        <button className="btn is-ghost is-quiet" onClick={() => pick(today)}>
          Today
        </button>
        <span className="grow" />
        <button className="btn is-ghost is-quiet" onClick={() => onDone(undefined)} disabled={!value}>
          No due date
        </button>
      </div>
    </div>
  );
}
