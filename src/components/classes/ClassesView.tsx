import { useMemo } from 'react';
import { FileText, MoreHorizontal, Plus } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { classCounts, classHomework, classNotes, countLine, listClasses, themeVars, type ClassInfo } from '../../lib/classes';
import { dueLabel } from '../../lib/homework';
import { displayTitle } from '../../lib/displayTitle';
import { newClass, openClass } from '../../lib/commands';
import { cx, formatRelativeTime } from '../../lib/util';
import { folderMenu } from '../FileTree';
import { openContextMenu, type MenuItem } from '../common/ContextMenu';
import { byDue } from '../homework/sources';
import { ClassGlyph } from './ClassIcon';

/** The class icon on a darker circle arcing in from the right of a coloured header. */
export function ClassArt({ icon, h }: { icon: ClassInfo['icon']; h: number }) {
  const d = h * 1.7;
  const s = Math.round(h * 0.36);
  return (
    <span className="class-art" aria-hidden>
      <span className="class-art-circle" style={{ width: d, height: d, right: -(d / 2 - h * 0.3), top: h / 2 - d / 2 + h * 0.18 }} />
      <span className="class-art-icon" style={{ right: h * 0.28, bottom: h * 0.16 }}>
        <ClassGlyph icon={icon} size={s} />
      </span>
    </span>
  );
}

/** Opens a menu under a ⋯ button, right-aligned to it. */
export function menuUnder(e: React.MouseEvent, items: MenuItem[]) {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu({ clientX: r.right - 220, clientY: r.bottom + 4, preventDefault: () => undefined }, items);
}

type CardRow = { note: NoteDoc; kind: 'homework' | 'note' };

/** What a card shows under its header: unfinished homework, soonest due first, then the notes edited last; two at most. */
function cardRows(path: string, notes: Record<string, NoteDoc>): CardRow[] {
  const due = classHomework(path, notes)
    .filter((n) => !n.meta.homework!.done)
    .sort(byDue)
    .slice(0, 2)
    .map((note): CardRow => ({ note, kind: 'homework' }));
  const recent = classNotes(path, notes)
    .sort((a, b) => b.meta.updated - a.meta.updated)
    .slice(0, 2 - due.length)
    .map((note): CardRow => ({ note, kind: 'note' }));
  return [...due, ...recent];
}

/** A class card: the class-colour header with its name and counts, then what's due and what changed. */
export function ClassCard({ cls, notes }: { cls: ClassInfo; notes: Record<string, NoteDoc> }) {
  const open = () => openClass(cls.path);
  const line = countLine(classCounts(cls.path, notes));
  const rows = cardRows(cls.path, notes);
  return (
    <div
      className="class-card"
      style={themeVars(cls.theme) as React.CSSProperties}
      onContextMenu={(e) => openContextMenu(e, folderMenu(cls.path))}
      data-class={cls.name}
    >
      <div className="class-card-head" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()} title={cls.name}>
        <ClassArt icon={cls.icon} h={96} />
        <div className="class-card-name">{cls.name}</div>
        {line && <div className="class-card-meta">{line}</div>}
      </div>
      <button className="icon-btn class-card-more" onClick={(e) => menuUnder(e, folderMenu(cls.path))} aria-label={`${cls.name} options`} title="Options">
        <MoreHorizontal size={18} strokeWidth={1.75} />
      </button>
      <div className="class-card-body">
        {rows.map(({ note, kind }) => {
          const due = kind === 'homework' ? dueLabel(note.meta.homework!.due) : null;
          return (
            <button key={note.meta.id} className={cx('class-card-row', `is-${kind}`)} onClick={() => useUI.getState().openNote(note.meta.id)}>
              {kind === 'homework' ? <span className="class-card-ring" aria-hidden /> : <FileText size={14} strokeWidth={1.5} className="class-card-glyph" />}
              <span className="class-card-title">{displayTitle(note)}</span>
              <span className={cx('class-card-when', due?.tone === 'overdue' && 'is-overdue')}>{due ? due.text : kind === 'note' ? formatRelativeTime(note.meta.updated) : ''}</span>
            </button>
          );
        })}
        {!rows.length && <div className="class-card-empty">No notes yet</div>}
      </div>
    </div>
  );
}

/** The start page: every class as a card, alphabetically, with New class at the top right. */
export function ClassesView() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);

  return (
    <div className="screen classes-view">
      <div className="screen-scroll">
        <div className="classes-col">
          {classes.length > 0 ? (
            // The header spans the grid's columns, so New class sits over the right edge of the last one.
            <div className="class-grid">
              <header className="classes-head">
                <h1 className="page-h1">Classes</h1>
                <span className="grow" />
                <button className="btn is-primary" onClick={newClass}>
                  <Plus size={16} strokeWidth={2} /> New class
                </button>
              </header>
              {classes.map((c) => (
                <ClassCard key={c.path} cls={c} notes={notes} />
              ))}
            </div>
          ) : (
            <>
              <header className="classes-head">
                <h1 className="page-h1">Classes</h1>
              </header>
              {/* With no classes, the empty state has the one New class button. */}
              <div className="page-empty">
                <div className="page-empty-title">No classes yet</div>
                <div className="page-empty-sub">Classes keep a subject’s notes and homework together.</div>
                <button className="btn is-primary" onClick={newClass}>
                  <Plus size={16} strokeWidth={2} /> New class
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
