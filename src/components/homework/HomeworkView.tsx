import { memo, useMemo, useRef, useState } from 'react';
import { ChevronDown, ClipboardList, MoreVertical, Plus, ScanText } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { classForFolder, classInfo, themeVars, type ClassInfo } from '../../lib/classes';
import { dueDay, dueTime, isMissing } from '../../lib/homework';
import { newHomework } from '../../lib/commands';
import { SCAN_TYPES } from '../../lib/import';
import { noteMenu } from '../FileTree';
import { openContextMenu } from '../common/ContextMenu';
import { Popover } from '../common/Popover';
import { Tabs } from '../common/Tabs';
import { cx } from '../../lib/util';

type Tab = 'todo' | 'missing' | 'done';
type Section = { key: string; label: string; dated: boolean; items: NoteDoc[] };

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Weeks start on Sunday, as in Google Calendar's US default. */
const startOfWeek = (t: number) => {
  const d = new Date(startOfDay(t));
  return d.getTime() - d.getDay() * DAY;
};

export function sortHomework(list: NoteDoc[]): NoteDoc[] {
  return [...list].sort((a, b) => {
    const da = a.meta.homework!.due ?? Infinity;
    const db = b.meta.homework!.due ?? Infinity;
    return da - db || b.meta.updated - a.meta.updated;
  });
}

/** Which tab a homework belongs on: Assigned, Missing (past due, not done) or Done. */
export function tabOf(n: NoteDoc): Tab {
  const hw = n.meta.homework!;
  return hw.done ? 'done' : isMissing(hw) ? 'missing' : 'todo';
}

function sectionsFor(tab: Tab, list: NoteDoc[], now = Date.now()): Section[] {
  const week = startOfWeek(now);
  const nextWeek = week + 7 * DAY;
  const after = nextWeek + 7 * DAY;
  const lastWeek = week - 7 * DAY;
  const due = (n: NoteDoc) => n.meta.homework!.due;
  const pick = (f: (n: NoteDoc) => boolean) => sortHomework(list.filter(f));
  if (tab === 'todo')
    return [
      { key: 'none', label: 'No due date', dated: false, items: pick((n) => !due(n)) },
      { key: 'week', label: 'This week', dated: true, items: pick((n) => !!due(n) && due(n)! < nextWeek) },
      { key: 'next', label: 'Next week', dated: true, items: pick((n) => !!due(n) && due(n)! >= nextWeek && due(n)! < after) },
      { key: 'later', label: 'Later', dated: true, items: pick((n) => !!due(n) && due(n)! >= after) },
    ];
  if (tab === 'missing')
    return [
      { key: 'week', label: 'This week', dated: true, items: pick((n) => due(n)! >= week) },
      { key: 'last', label: 'Last week', dated: true, items: pick((n) => due(n)! >= lastWeek && due(n)! < week) },
      { key: 'earlier', label: 'Earlier', dated: true, items: pick((n) => due(n)! < lastWeek) },
    ];
  const done = (f: (n: NoteDoc) => boolean) => list.filter(f).sort((a, b) => b.meta.updated - a.meta.updated);
  return [
    { key: 'none', label: 'No due date', dated: false, items: done((n) => !due(n)) },
    { key: 'week', label: 'This week', dated: true, items: done((n) => !!due(n) && due(n)! >= week) },
    { key: 'last', label: 'Last week', dated: true, items: done((n) => !!due(n) && due(n)! >= lastWeek && due(n)! < week) },
    { key: 'earlier', label: 'Earlier', dated: true, items: done((n) => !!due(n) && due(n)! < lastWeek) },
  ];
}

const EMPTY: Record<Tab, string> = {
  todo: 'Nothing on this to-do list.',
  missing: 'Looks like nothing is missing. Nice work!',
  done: 'No homework completed yet.',
};

/** The date gutter of a day block (Google Calendar's schedule view): the day number, then month and weekday. */
function DateGutter({ t }: { t: number }) {
  const d = new Date(t);
  const today = startOfDay(Date.now()) === startOfDay(t);
  const past = startOfDay(t) < startOfDay(Date.now());
  return (
    <div className={cx('hw-gutter', today && 'is-today', past && 'is-past')}>
      <span className="hw-gutter-day">{d.getDate()}</span>
      <span className="hw-gutter-caps">
        <span>{d.toLocaleDateString(undefined, { month: 'short' })}</span>
        <span>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      </span>
    </div>
  );
}

/** A homework row (Classroom's to-do item): class-colour circle, title over class, then the due details. */
export const HomeworkRow = memo(function HomeworkRow({
  note,
  cls,
  meta,
  gutter,
}: {
  note: NoteDoc;
  cls: ClassInfo | null;
  /** Right-hand text; by default the due day and time. */
  meta?: React.ReactNode;
  /** In a dated section: the date gutter for the first row of a day, or an empty one. */
  gutter?: number | null;
}) {
  const hw = note.meta.homework!;
  const scanned = (note.content.content ?? []).some((b) => b.type === 'image');
  const open = () => useUI.getState().openNote(note.meta.id);
  const time = hw.due ? dueTime(hw.due) : '';
  const late = !!hw.due && hw.due < startOfDay(note.meta.updated);
  const right =
    meta ??
    (hw.done ? (
      <span className={cx(late && 'is-missing')}>{late ? 'Done late' : 'Done'}</span>
    ) : isMissing(hw) ? (
      <span className="is-missing">{time || 'Missing'}</span>
    ) : gutter !== undefined ? (
      time
    ) : hw.due ? (
      <>
        <span>{dueDay(hw.due, Date.now(), 'short')}</span>
        {time && <span>{time}</span>}
      </>
    ) : (
      `Added ${new Date(note.meta.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    ));
  return (
    <div
      className={cx('hw-row-item', hw.done && 'is-done')}
      role="link"
      tabIndex={0}
      style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      onContextMenu={(e) => openContextMenu(e, noteMenu(note))}
    >
      {gutter !== undefined && (gutter ? <DateGutter t={gutter} /> : <div className="hw-gutter" />)}
      <span className="item-circle">{scanned ? <ScanText size={20} /> : <ClipboardList size={20} />}</span>
      <div className="hw-row-main">
        <div className="hw-row-title">{note.meta.title || 'Untitled homework'}</div>
        <div className="hw-row-meta">{cls?.name ?? 'No class'}</div>
      </div>
      <div className="hw-row-when">{right}</div>
      <button
        className="icon-btn hw-row-more"
        onClick={(e) => {
          e.stopPropagation();
          openContextMenu(e, noteMenu(note));
        }}
        aria-label="More"
        title="More"
      >
        <MoreVertical size={20} />
      </button>
    </div>
  );
});

/** Every homework across classes, as Google Classroom's To-do page: Assigned, Missing and Done. */
export function HomeworkView({ filter = 'todo' }: { filter?: Tab }) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const [classFilter, setClassFilter] = useState<string>('');
  const [dropping, setDropping] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const createBtn = useRef<HTMLButtonElement>(null);

  const all = useMemo(() => Object.values(notes).filter((n) => !n.meta.trashed && n.meta.homework), [notes]);
  const clsOf = (n: NoteDoc) => {
    const p = classForFolder(n.meta.folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]) : null;
  };
  const classes = useMemo(
    () =>
      folders
        .filter((f) => !f.includes('/') && folderMeta[f]?.kind === 'class')
        .map((f) => classInfo(f, folderMeta[f]))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, folderMeta],
  );
  const counts = useMemo(() => {
    const c = { todo: 0, missing: 0, done: 0 };
    for (const n of all) c[tabOf(n)]++;
    return c;
  }, [all]);

  const shown = all.filter((n) => tabOf(n) === filter && (!classFilter || classForFolder(n.meta.folder, folderMeta) === classFilter));
  const sections = sectionsFor(filter, shown);
  const firstOpen = sections.find((s) => s.items.length)?.key;
  const isOpen = (s: Section) =>
    collapsed[`${filter}:${s.key}`] !== undefined ? !collapsed[`${filter}:${s.key}`] : s.key === 'week' || filter === 'missing' || s.key === firstOpen;
  const filterName = classes.find((c) => c.path === classFilter)?.name;

  return (
    <div
      className={cx('screen homework-view', dropping && 'is-drop')}
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
        newHomework(classFilter || null, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      }}
    >
      <div className="screen-head">
        <h1 className="screen-title">Homework</h1>
      </div>
      <Tabs
        items={[
          { id: 'todo', label: 'Assigned' },
          { id: 'missing', label: 'Missing', count: counts.missing || undefined },
          { id: 'done', label: 'Done' },
        ]}
        value={filter}
        onChange={(t) => useUI.getState().setView({ kind: 'homework', filter: t })}
      />
      <div className="screen-scroll">
        <div className="screen-column">
          <div className="hw-toolbar">
            <button ref={createBtn} className="btn is-primary is-create" onClick={() => setCreateOpen((v) => !v)}>
              <Plus size={22} /> New homework
            </button>
          </div>
          <label className="gselect">
            <span className="gselect-label">Class</span>
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          {shown.length ? (
            <div className="hw-sections">
              {sections.map((s) => {
                const open = isOpen(s) && s.items.length > 0;
                let lastDay = -1;
                return (
                  <section key={s.key} className={cx('hw-section', open && 'is-open')}>
                    <button
                      className="hw-section-head"
                      disabled={!s.items.length}
                      onClick={() => setCollapsed({ ...collapsed, [`${filter}:${s.key}`]: open })}
                      aria-expanded={open}
                    >
                      <span className="hw-section-label">{s.label}</span>
                      <span className="grow" />
                      <span className="hw-section-count">{s.items.length}</span>
                      <span className="hw-section-chev">{s.items.length > 0 && <ChevronDown size={22} className={cx('chev', open && 'is-open')} />}</span>
                    </button>
                    {open && (
                      <div className="hw-section-list">
                        {s.items.map((n) => {
                          const due = n.meta.homework!.due;
                          let gutter: number | null | undefined;
                          if (s.dated && due) {
                            const day = startOfDay(due);
                            gutter = day !== lastDay ? due : null;
                            lastDay = day;
                          } else if (s.dated || filter !== 'done') gutter = s.dated ? null : undefined;
                          return <HomeworkRow key={n.meta.id} note={n} cls={clsOf(n)} gutter={s.dated ? gutter : undefined} />;
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="screen-empty">{filterName && all.length ? `Nothing for ${filterName} on this list.` : EMPTY[filter]}</div>
          )}
        </div>
      </div>

      <Popover anchor={createBtn.current} open={createOpen} onClose={() => setCreateOpen(false)} align="start" className="menu-pop">
        <div className="menu">
          <button
            className="menu-item"
            onClick={() => {
              setCreateOpen(false);
              newHomework(classFilter || null);
            }}
          >
            <ClipboardList size={20} />
            <span className="menu-label">Homework</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setCreateOpen(false);
              newHomework(classFilter || null);
              setTimeout(() => window.dispatchEvent(new CustomEvent('nib:homework-scan')), 60);
            }}
          >
            <ScanText size={20} />
            <span className="menu-label">Homework from a scan…</span>
          </button>
        </div>
      </Popover>
      {dropping && <div className="drop-hint">Drop to create homework from this scan</div>}
    </div>
  );
}
