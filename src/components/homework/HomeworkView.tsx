import { memo, useMemo, useState } from 'react';
import { Check, ClipboardList, FileText, Link2, MoreHorizontal, Plus, ScanText } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { classForFolder, classInfo, type ClassInfo } from '../../lib/classes';
import { dueLabel, homeworkSources } from '../../lib/homework';
import { linkNotes, newHomework } from '../../lib/commands';
import { SCAN_TYPES } from '../../lib/import';
import { ClassBadge } from '../classes/ClassIcon';
import { noteMenu } from '../FileTree';
import { openContextMenu } from '../common/ContextMenu';
import { cx, formatRelativeTime, plural } from '../../lib/util';

type Bucket = 'overdue' | 'soon' | 'week' | 'later' | 'none' | 'done';
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'soon', label: 'Due soon' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
  { key: 'done', label: 'Done' },
];

export function bucketOf(n: NoteDoc, now = Date.now()): Bucket {
  const hw = n.meta.homework!;
  if (hw.done) return 'done';
  if (!hw.due) return 'none';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((hw.due - start.getTime()) / 86_400_000);
  if (days < 0) return 'overdue';
  if (days <= 1) return 'soon';
  if (days < 7) return 'week';
  return 'later';
}

export function sortHomework(list: NoteDoc[]): NoteDoc[] {
  return [...list].sort((a, b) => {
    const da = a.meta.homework!.due ?? Infinity;
    const db = b.meta.homework!.due ?? Infinity;
    return da - db || b.meta.updated - a.meta.updated;
  });
}

/** A homework assignment as a to-do row: done checkbox, class, due date, linked notes. */
export const HomeworkRow = memo(function HomeworkRow({ note, cls, showClass = true }: { note: NoteDoc; cls: ClassInfo | null; showClass?: boolean }) {
  const notes = useVault((s) => s.notes);
  const hw = note.meta.homework!;
  const due = dueLabel(hw.due);
  const linked = useMemo(() => homeworkSources(note, notes).length, [note, notes]);
  const pages = useMemo(() => (note.content.content ?? []).filter((b) => b.type === 'image').length, [note.content]);
  return (
    <div
      className={cx('hw-row-item', hw.done && 'is-done')}
      role="button"
      tabIndex={0}
      onClick={() => useUI.getState().openNote(note.meta.id, { newTab: true })}
      onKeyDown={(e) => e.key === 'Enter' && useUI.getState().openNote(note.meta.id, { newTab: true })}
      onContextMenu={(e) => openContextMenu(e, noteMenu(note))}
    >
      <button
        className={cx('hw-check', hw.done && 'is-on')}
        style={cls ? { ['--class' as string]: cls.color } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          useVault.getState().updateMeta(note.meta.id, { homework: { ...hw, done: !hw.done } });
        }}
        aria-label={hw.done ? 'Mark as not done' : 'Mark as done'}
        title={hw.done ? 'Mark as not done' : 'Mark as done'}
      >
        {hw.done && <Check size={12} strokeWidth={3} />}
      </button>
      <div className="hw-row-main">
        <div className="hw-row-title">{note.meta.title || 'Untitled homework'}</div>
        <div className="hw-row-meta">
          {showClass && cls && (
            <span className="hw-row-class" style={{ ['--class' as string]: cls.color }}>
              <ClassBadge cls={cls} size={14} />
              {cls.name}
            </span>
          )}
          {pages > 0 && (
            <span className="hw-row-pages">
              <ScanText size={12} /> {plural(pages, 'page')}
            </span>
          )}
          <span
            className={cx('hw-row-links', !linked && 'is-none')}
            title={linked ? 'Notes the assistant may use' : 'No notes linked yet'}
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              linkNotes(note.meta.id);
            }}
          >
            <Link2 size={12} /> {linked ? plural(linked, 'note') : 'Link notes'}
          </span>
          <span className="hw-row-edited">edited {formatRelativeTime(note.meta.updated)}</span>
        </div>
      </div>
      {due && !hw.done && <span className={cx('due-pill', `is-${due.tone}`)}>{due.text}</span>}
      <button
        className="icon-btn is-tiny hw-row-more"
        onClick={(e) => {
          e.stopPropagation();
          openContextMenu(e, noteMenu(note));
        }}
        aria-label="More"
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
});

/** Every homework across classes, grouped by when it is due. */
export function HomeworkView({ filter = 'todo' }: { filter?: 'todo' | 'done' }) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const all = useMemo(() => Object.values(notes).filter((n) => !n.meta.trashed && n.meta.homework), [notes]);
  const clsOf = (n: NoteDoc) => {
    const p = classForFolder(n.meta.folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]) : null;
  };
  const classesWithHw = useMemo(() => {
    const m = new Map<string, ClassInfo>();
    for (const n of all) {
      const c = clsOf(n);
      if (c) m.set(c.path, c);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, folderMeta]);

  const todo = all.filter((n) => !n.meta.homework!.done).length;
  const done = all.length - todo;
  const shown = sortHomework(
    all.filter(
      (n) =>
        (filter === 'done' ? n.meta.homework!.done : !n.meta.homework!.done) && (!classFilter || classForFolder(n.meta.folder, folderMeta) === classFilter),
    ),
  );
  const groups = BUCKETS.map((b) => ({ ...b, items: shown.filter((n) => bucketOf(n) === b.key) })).filter((g) => g.items.length);
  if (filter === 'done') groups.forEach((g) => g.items.sort((a, b) => b.meta.updated - a.meta.updated));

  return (
    <div
      className={cx('collection homework-view', dropping && 'is-drop')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={async (e) => {
        setDropping(false);
        const f = [...e.dataTransfer.files].find((x) => SCAN_TYPES.includes(x.name.split('.').pop()?.toLowerCase() ?? ''));
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        newHomework(classFilter, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      }}
    >
      <div className="collection-head">
        <div className="collection-title">
          <span className="collection-icon is-homework">
            <ClipboardList size={20} />
          </span>
          <div>
            <h1>Homework</h1>
            <div className="collection-sub">
              {plural(todo, 'assignment')} to do{done ? ` · ${done} done` : ''} · answers come only from the notes you link
            </div>
          </div>
        </div>
        <div className="collection-actions">
          <div className="seg">
            <button className={cx(filter === 'todo' && 'is-active')} onClick={() => useUI.getState().setView({ kind: 'homework' })}>
              To do
            </button>
            <button className={cx(filter === 'done' && 'is-active')} onClick={() => useUI.getState().setView({ kind: 'homework', filter: 'done' })}>
              Done
            </button>
          </div>
          <button className="btn is-ghost" onClick={() => newHomework(classFilter)} title="Import a scanned worksheet (PDF or photo)">
            <ScanText size={15} /> Import scan
          </button>
          <button className="btn is-primary" onClick={() => newHomework(classFilter)}>
            <Plus size={15} /> New homework
          </button>
        </div>
      </div>

      {classesWithHw.length > 1 && (
        <div className="hw-class-filter">
          <button className={cx('class-chip', !classFilter && 'is-active')} onClick={() => setClassFilter(null)}>
            All classes
          </button>
          {classesWithHw.map((c) => (
            <button
              key={c.path}
              className={cx('class-chip', classFilter === c.path && 'is-active')}
              style={{ ['--class' as string]: c.color }}
              onClick={() => setClassFilter(classFilter === c.path ? null : c.path)}
            >
              <ClassBadge cls={c} size={16} /> {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="hw-groups">
        {groups.map((g) => (
          <section key={g.key} className={cx('hw-group', `is-${g.key}`)}>
            <div className="hw-group-head">
              {g.label} <span className="hw-group-count">{g.items.length}</span>
            </div>
            <div className="hw-group-list">
              {g.items.map((n) => (
                <HomeworkRow key={n.meta.id} note={n} cls={clsOf(n)} />
              ))}
            </div>
          </section>
        ))}
        {!groups.length && (
          <div className="empty">
            <div className="empty-art" aria-hidden>
              <FileText size={44} strokeWidth={1.2} />
            </div>
            <div className="empty-title">{filter === 'done' ? 'Nothing finished yet' : all.length ? 'All caught up' : 'No homework yet'}</div>
            <div className="empty-sub">
              {filter === 'done'
                ? 'Tick the circle next to an assignment when you finish it.'
                : 'Start from a blank page or drop in a scanned worksheet. Link the notes it covers, and the assistant will answer only from them.'}
            </div>
            {filter !== 'done' && (
              <button className="btn is-primary" onClick={() => newHomework(classFilter)}>
                <Plus size={15} /> New homework
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
