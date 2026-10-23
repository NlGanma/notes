import { memo, useState } from 'react';
import { create } from 'zustand';
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { themeVars, type ClassInfo } from '../../lib/classes';
import { displayTitle } from '../../lib/displayTitle';
import { cx } from '../../lib/util';
import { noteMenu } from '../FileTree';
import { openContextMenu } from '../common/ContextMenu';
import { toast, useToasts } from '../common/toast';
import { menuUnder } from '../classes/ClassesView';

// The "Marked as done" toast of each homework, so ticking it back off takes its Undo away too.
const doneToasts = new Map<string, string>();

/** Ticks a homework off (or back on), with Undo: a ticked row drops into the folded Done list. */
export function setDone(note: NoteDoc, done: boolean) {
  const id = note.meta.id;
  const update = (d: boolean) => {
    const cur = useVault.getState().notes[id]?.meta.homework;
    if (cur) useVault.getState().updateMeta(id, { homework: { ...cur, done: d } });
    if (!d) useJustDone.getState().release(id);
  };
  update(done);
  const shown = doneToasts.get(id);
  if (shown) useToasts.getState().dismiss(shown);
  doneToasts.delete(id);
  // Longer than most toasts: in a list, the row only leaves for Done a moment after the tick.
  if (done) doneToasts.set(id, toast.info('Marked as done', undefined, { label: 'Undo', run: () => update(false) }, 6000));
}

const HOLD_MS = 1500;
let holdTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Homework just ticked in a list. As in Reminders, a ticked row stays where it is, checked, for a moment
 * before it goes to Done, so the next row doesn't slide under the pointer and take a second click. Each
 * tick restarts the wait, so rows ticked one after another leave together.
 */
export const useJustDone = create<{ ids: ReadonlySet<string>; hold(id: string): void; release(id: string): void }>((set, get) => ({
  ids: new Set(),
  hold: (id) => {
    set({ ids: new Set(get().ids).add(id) });
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => set({ ids: new Set() }), HOLD_MS);
  },
  release: (id) => {
    if (!get().ids.has(id)) return;
    const ids = new Set(get().ids);
    ids.delete(id);
    set({ ids });
  },
}));

/** Whether a homework is still on the to-do side of a list: not done, or ticked a moment ago. */
export const isTodo = (n: NoteDoc, held: ReadonlySet<string>) => !!n.meta.homework && (!n.meta.homework.done || held.has(n.meta.id));

/**
 * A homework in a list, as Reminders shows a to-do: a round checkbox (the class colour once ticked), the
 * name, where it's from, and when it's due. The row opens the homework; ⋯ and right-click give the note menu.
 */
export const HomeworkRow = memo(function HomeworkRow({
  note,
  cls,
  due,
  showClass,
}: {
  note: NoteDoc;
  cls: ClassInfo | null;
  due?: { text: string; overdue?: boolean } | null;
  showClass?: boolean;
}) {
  const done = !!note.meta.homework?.done;
  const name = displayTitle(note);
  const open = (e?: React.MouseEvent) => useUI.getState().openNote(note.meta.id, { newTab: !!e && (e.metaKey || e.ctrlKey) });
  return (
    <div
      className={cx('hw-row-item', done && 'is-done')}
      role="button"
      tabIndex={0}
      data-note-id={note.meta.id}
      style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open()}
      onContextMenu={(e) => openContextMenu(e, noteMenu(note))}
      title={name}
    >
      <button
        className={cx('hw-check', done && 'is-on')}
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark ${name} not done` : `Mark ${name} done`}
        onClick={(e) => {
          e.stopPropagation();
          if (!done) useJustDone.getState().hold(note.meta.id);
          setDone(note, !done);
        }}
      >
        {done && <Check size={12} strokeWidth={3} />}
      </button>
      <span className="hw-row-title">{name}</span>
      {showClass && cls && (
        <span className="hw-row-class" title={cls.name}>
          <span className="class-square" style={{ background: cls.color }} />
          <span className="hw-row-class-name">{cls.name}</span>
        </span>
      )}
      {due?.text && <span className={cx('hw-row-due', due.overdue && 'is-overdue')}>{due.text}</span>}
      <button className="icon-btn is-tiny row-more" aria-label="More" onClick={(e) => menuUnder(e, noteMenu(note))}>
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
});

/** "Done (5)": finished homework, folded away until asked for. Its rows aren't drawn while it's shut. */
export function DoneList({ count, children }: { count: number; children: () => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <section className={cx('hw-done-list', open && 'is-open')}>
      <button className="hw-done-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} strokeWidth={1.75} className={cx('chev', open && 'is-open')} />
        Done ({count})
      </button>
      {open && <div className="hw-done-rows">{children()}</div>}
    </section>
  );
}
