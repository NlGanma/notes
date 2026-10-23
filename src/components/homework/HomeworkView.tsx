import { Fragment, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { useVault } from '../../state/vault';
import type { NoteDoc } from '../../lib/vault/types';
import { classForFolder, classInfo, listClasses } from '../../lib/classes';
import { newHomework } from '../../lib/commands';
import { importDropped, SCAN_TYPES } from '../../lib/import';
import { cx } from '../../lib/util';
import { Popover } from '../common/Popover';
import { short } from '../FileTree';
import { DoneList, HomeworkRow, isTodo, useJustDone } from './HomeworkRow';
import { dueInGroup, groupHomework } from './sources';

const isScan = (f: File) => SCAN_TYPES.includes(f.name.split('.').pop()?.toLowerCase() ?? '');

/**
 * Every homework, as Things or Reminders list to-dos: one list grouped by when it's due (Overdue, Today,
 * Tomorrow, This week, Later, No due date), finished ones folded into Done at the bottom. Groups never
 * fold, so nothing due is ever out of sight. A class filter narrows it to one class.
 */
export function HomeworkView() {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const held = useJustDone((s) => s.ids);
  const [classFilter, setClassFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const filterBtn = useRef<HTMLButtonElement>(null);

  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  const all = useMemo(() => Object.values(notes).filter((n) => !n.meta.trashed && n.meta.homework), [notes]);
  // The filter counts only while its class is still there: renamed or deleted, it falls back to all.
  const filterCls = classes.find((c) => c.path === classFilter) ?? null;
  const active = filterCls ? classFilter : '';
  const shown = useMemo(() => (active ? all.filter((n) => classForFolder(n.meta.folder, folderMeta) === active) : all), [all, active, folderMeta]);
  const groups = useMemo(() => groupHomework(shown, undefined, held), [shown, held]);
  const done = useMemo(() => shown.filter((n) => !isTodo(n, held)).sort((a, b) => b.meta.updated - a.meta.updated), [shown, held]);
  const clsOf = (n: NoteDoc) => {
    const p = classForFolder(n.meta.folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]) : null;
  };

  return (
    <div
      className={cx('screen homework-view', dropping && 'is-drop')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const scan = [...e.dataTransfer.files].find(isScan);
        if (scan) newHomework(active || null, { name: scan.name, bytes: new Uint8Array(await scan.arrayBuffer()) });
        else void importDropped(e.dataTransfer.files);
      }}
    >
      <div className="screen-scroll">
        <div className="list-col hw-col">
          <header className="list-head">
            <div className="list-head-row">
              <h1 className="list-title">Homework</h1>
              {classes.length > 0 && all.length > 0 && (
                <button
                  ref={filterBtn}
                  className={cx('chip hw-filter', (filterOpen || !!filterCls) && 'is-on')}
                  onClick={() => setFilterOpen(!filterOpen)}
                  aria-haspopup="menu"
                  aria-expanded={filterOpen}
                  title={filterCls?.name}
                >
                  {filterCls && <span className="class-square" style={{ background: filterCls.color }} />}
                  <span className="hw-filter-name">{filterCls?.name ?? 'All classes'}</span>
                  <ChevronDown size={14} strokeWidth={1.5} />
                </button>
              )}
              <span className="grow" />
              {/* With no homework at all, the empty state has the one New homework button. */}
              {all.length > 0 && (
                <button className="btn is-primary" onClick={() => newHomework(active || null)}>
                  <Plus size={16} strokeWidth={2} /> New homework
                </button>
              )}
            </div>
          </header>

          {groups.map((g) => (
            <section key={g.key} className={cx('list-section hw-group', `is-${g.key}`)}>
              <h2 className="list-caption">{g.label}</h2>
              {g.items.map((n) => (
                <HomeworkRow key={n.meta.id} note={n} cls={clsOf(n)} due={dueInGroup(n.meta.homework!.due)} showClass={!active} />
              ))}
            </section>
          ))}
          {!groups.length && (
            <div className="page-empty">
              <div className="page-empty-title">{filterCls && all.length && !shown.length ? `No homework for ${short(filterCls.name)}` : 'No homework due'}</div>
              {!all.length && (
                <button className="btn is-secondary" onClick={() => newHomework(active || null)}>
                  <Plus size={16} strokeWidth={1.75} /> New homework
                </button>
              )}
            </div>
          )}
          <DoneList count={done.length}>{() => done.map((n) => <HomeworkRow key={n.meta.id} note={n} cls={clsOf(n)} showClass={!active} />)}</DoneList>
        </div>
      </div>

      <Popover anchor={filterBtn.current} open={filterOpen} onClose={() => setFilterOpen(false)} align="start" className="menu-pop">
        <div className="menu hw-filter-menu" role="menu">
          {[{ path: '', name: 'All classes', color: '' }, ...classes].map((c, i) => (
            <Fragment key={c.path || 'all'}>
              <button
                className="menu-item"
                role="menuitemradio"
                aria-checked={active === c.path}
                onClick={() => {
                  setClassFilter(c.path);
                  setFilterOpen(false);
                }}
              >
                {c.color ? <span className="class-square" style={{ background: c.color }} /> : null}
                <span className="menu-label">{c.name}</span>
                {active === c.path && <Check size={16} strokeWidth={1.5} />}
              </button>
              {i === 0 && <div className="menu-sep" />}
            </Fragment>
          ))}
        </div>
      </Popover>
      {dropping && <div className="drop-hint">Drop a PDF or photo to make homework{filterCls ? ` for ${short(filterCls.name)}` : ''}</div>}
    </div>
  );
}
