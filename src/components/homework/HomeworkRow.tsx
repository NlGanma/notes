import { memo, useState } from 'react';
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { themeVars, type ClassInfo } from '../../lib/classes';
import { displayTitle } from '../../lib/displayTitle';
import { cx } from '../../lib/util';
import { noteMenu } from '../FileTree';
import { openContextMenu } from '../common/ContextMenu';
import { toast } from '../common/toast';
import { menuUnder } from '../classes/ClassesView';

/** Ticks a homework off (or back on), with Undo: a ticked row drops into the folded Done list. */
export function setDone(note: NoteDoc, done: boolean) {
  const update = (d: boolean) => {
    const cur = useVault.getState().notes[note.meta.id]?.meta.homework;
    if (cur) useVault.getState().updateMeta(note.meta.id, { homework: { ...cur, done: d } });
  };
  update(done);
  if (done) toast.info('Marked as done', undefined, { label: 'Undo', run: () => update(false) });
}

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
