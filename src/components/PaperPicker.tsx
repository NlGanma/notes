import { useEffect, useRef } from 'react';
import { PAPERS, type Paper } from '../lib/paper';
import { cx } from '../lib/util';

/** A paper's look, drawn in CSS: blank, a small grid, or ruled lines. Also the thumbnail in note rows. */
export function PaperThumb({ paper, className }: { paper: Paper; className?: string }) {
  return <span className={cx('paper-thumb', `is-${paper}`, className)} aria-hidden />;
}

/**
 * The one paper choice used everywhere a paper is picked for a note (New homework, the note's paper,
 * the in-note strip): a radio group of three thumbnails. Arrow keys move the choice.
 */
export function PaperPicker({
  value,
  onChange,
  size = 'm',
  label = 'Paper',
  className,
}: {
  value: Paper;
  onChange(p: Paper): void;
  size?: 's' | 'm' | 'l';
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={cx('paper-picker', `is-${size}`, className)}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const i = PAPERS.findIndex((p) => p.id === value);
        const next = PAPERS[(i + dir + PAPERS.length) % PAPERS.length];
        onChange(next.id);
        ref.current?.querySelector<HTMLButtonElement>(`[data-paper="${next.id}"]`)?.focus();
      }}
    >
      {PAPERS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          tabIndex={value === p.id ? 0 : -1}
          data-paper={p.id}
          className={cx('paper-opt', value === p.id && 'is-active')}
          title={size === 's' ? p.label : undefined}
          onClick={() => onChange(p.id)}
        >
          <PaperThumb paper={p.id} />
          <span className="paper-opt-label">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The same three papers as menu items, for the New note popover: one click (or Enter) makes the note.
 * There is no selection to show; the last-used paper just has the focus.
 */
export function PaperTiles({ last, onPick }: { last: Paper; onPick(p: Paper): void }) {
  const ref = useRef<HTMLDivElement>(null);
  // A frame later: the popover holding the tiles is still hidden while it measures where to sit,
  // and a hidden button can't take the focus.
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-paper="${last}"]`)?.focus());
    return () => cancelAnimationFrame(id);
  }, [last]);
  return (
    <div
      ref={ref}
      className="paper-picker is-m is-tiles"
      role="group"
      aria-label="Paper"
      onKeyDown={(e) => {
        const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[data-paper]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + dir + items.length) % items.length]?.focus();
      }}
    >
      {PAPERS.map((p) => (
        <button key={p.id} type="button" role="menuitem" data-paper={p.id} className="paper-opt" onClick={() => onPick(p.id)}>
          <PaperThumb paper={p.id} />
          <span className="paper-opt-label">{p.label}</span>
        </button>
      ))}
    </div>
  );
}
