import { Fragment, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, Folder, FolderPlus, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { useVault } from '../state/vault';
import { useUI, type View } from '../state/ui';
import type { NoteDoc } from '../lib/vault/types';
import { cx, plural } from '../lib/util';
import { newFolder } from '../lib/commands';
import { classForFolder, classInfo, HOMEWORK_SUBFOLDER } from '../lib/classes';
import { displayTitle } from '../lib/displayTitle';
import { normalizePaper } from '../lib/paper';
import { folderMenu, noteMenu, short } from './FileTree';
import { PaperThumb } from './PaperPicker';
import { Popover } from './common/Popover';
import { openContextMenu, type MenuItem } from './common/ContextMenu';
import { confirmDialog } from './common/dialogs';

/*
 * All notes, a folder, and Trash, as Apple Notes lists them: a serif title, folders first, then notes
 * grouped by when they were last edited. Each note row shows its paper, its name, and a second line
 * with the date and the first words. The class page lists its notes with the same rows.
 */

const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Apple Notes' sections, newest first: Today, Yesterday, Previous 7 days, Previous 30 days, then months, then years. */
export function dateGroup(t: number, now = Date.now()): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const m = midnight.getTime();
  if (t >= m) return 'Today';
  if (t >= m - DAY) return 'Yesterday';
  if (t >= m - 7 * DAY) return 'Previous 7 days';
  if (t >= m - 30 * DAY) return 'Previous 30 days';
  const d = new Date(t);
  return d.getFullYear() === midnight.getFullYear() ? MONTHS[d.getMonth()] : String(d.getFullYear());
}

/** A row's date: the time today, "Yesterday", the weekday this week, else the date. */
export function rowDate(t: number, now = Date.now()): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const d = new Date(t);
  if (t >= midnight.getTime()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (t >= midnight.getTime() - DAY) return 'Yesterday';
  if (t >= midnight.getTime() - 6 * DAY) return WEEKDAYS[d.getDay()];
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === midnight.getFullYear() ? {} : { year: 'numeric' }) });
}

const snippets = new WeakMap<NoteDoc, string>();

/** The first words of a note after its name, for the second line of its row. */
export function noteSnippet(n: NoteDoc): string {
  const hit = snippets.get(n);
  if (hit !== undefined) return hit;
  const lines: string[] = [];
  const walk = (nodes: JSONContent[] | undefined) => {
    for (const b of nodes ?? []) {
      if (lines.join(' ').length > 160) return;
      if (b.type === 'text') lines.push(b.text ?? '');
      // Math, handwriting and pictures don't read as a line of text; the row shows the words around them.
      else if (b.type === 'mathInline' || b.type === 'inkInline') lines.push('…');
      else if (b.type === 'mathBlock' || b.type === 'inkBlock' || b.type === 'image' || b.type === 'codeBlock') continue;
      else {
        walk(b.content);
        if (b.type === 'paragraph' || b.type === 'heading') lines.push('\n');
      }
    }
  };
  walk(n.content.content);
  const name = displayTitle(n);
  const text = lines
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i) => l && !(i < 3 && (l === name || (name.endsWith('…') && l.startsWith(name.slice(0, -1))))))
    .filter((l) => !(n.meta.homework && l === 'My work'))
    .join(' ')
    .replace(/(\s*…\s*)+/g, ' … ')
    .trim()
    .slice(0, 140);
  snippets.set(n, text);
  return text;
}

/** Notes in date sections (by last edit, or by when they were made), or one list when sorted by name. */
function groupNotes(list: NoteDoc[], sort: 'updated' | 'title' | 'created') {
  if (sort === 'title') return [{ label: '', notes: list }];
  const out: { label: string; notes: NoteDoc[] }[] = [];
  for (const n of list) {
    const label = dateGroup(sort === 'created' ? n.meta.created : n.meta.updated);
    const last = out[out.length - 1];
    if (last?.label === label) last.notes.push(n);
    else out.push({ label, notes: [n] });
  }
  return out;
}

function openFromRow(n: NoteDoc, e?: React.MouseEvent) {
  useUI.getState().openNote(n.meta.id, { newTab: !!e && (e.metaKey || e.ctrlKey || e.button === 1) });
}

const menuAt = (e: React.MouseEvent, items: MenuItem[]) => {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu({ clientX: r.right - 200, clientY: r.bottom + 4, preventDefault: () => undefined }, items);
};

/**
 * A note in a list: its paper, its name, and "date  first words" under it. `place` adds where it lives
 * (All notes shows a class's colour and name; Trash says where it came from).
 */
export function NoteRow({ note, place, trash }: { note: NoteDoc; place?: 'class' | 'from'; trash?: boolean }) {
  const folderMeta = useVault((s) => s.folderMeta);
  const clsPath = place ? classForFolder(note.meta.folder, folderMeta) : null;
  const cls = clsPath ? classInfo(clsPath, folderMeta[clsPath]) : null;
  const from = place === 'from' ? (cls?.name ?? (note.meta.folder.split('/').pop() || '')) : '';
  const name = displayTitle(note);
  const items = trash ? trashMenu(note) : noteMenu(note);
  return (
    <div
      className={cx('note-row', trash && 'is-trashed')}
      role="button"
      tabIndex={0}
      data-note-id={note.meta.id}
      onClick={(e) => !trash && openFromRow(note, e)}
      onAuxClick={(e) => !trash && e.button === 1 && openFromRow(note, e)}
      onKeyDown={(e) => e.key === 'Enter' && !trash && openFromRow(note)}
      onContextMenu={(e) => openContextMenu(e, items)}
      title={name}
    >
      <PaperThumb paper={normalizePaper(note.meta.paper)} className="note-row-paper" />
      <span className="note-row-text">
        <span className={cx('note-row-title', !note.meta.title && 'is-derived')}>{name}</span>
        <span className="note-row-sub">
          <span className="note-row-date">{rowDate(trash && note.meta.trashed ? note.meta.trashed : note.meta.updated)}</span>
          {place === 'class' && cls && (
            <span className="note-row-class" title={cls.name}>
              <span className="class-square" style={{ background: cls.color }} />
              <span className="note-row-class-name">{cls.name}</span>
            </span>
          )}
          {from && <span className="note-row-from">From {from}</span>}
          <span className="note-row-snippet">{noteSnippet(note)}</span>
        </span>
      </span>
      {trash && (
        <button
          className="btn is-ghost is-quiet note-row-restore"
          onClick={(e) => {
            e.stopPropagation();
            useVault.getState().restoreNote(note.meta.id);
          }}
        >
          <RotateCcw size={14} strokeWidth={1.5} /> Restore
        </button>
      )}
      <button className="icon-btn is-tiny row-more" aria-label="More" onClick={(e) => menuAt(e, items)}>
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** A folder in a list: its icon (in the class colour inside a class), name and note count. */
export function FolderRow({ path, count }: { path: string; count: number }) {
  const folderMeta = useVault((s) => s.folderMeta);
  const clsPath = classForFolder(path, folderMeta);
  const color = clsPath ? classInfo(clsPath, folderMeta[clsPath]).color : undefined;
  const name = path.split('/').pop()!;
  const open = () => useUI.getState().setView({ kind: 'folder', path });
  return (
    <div
      className="folder-row"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      onContextMenu={(e) => openContextMenu(e, folderMenu(path))}
      title={name}
    >
      <Folder size={18} strokeWidth={1.5} className="folder-row-icon" style={color ? { color } : undefined} />
      <span className="folder-row-name">{name}</span>
      <span className="folder-row-count">{plural(count, 'note')}</span>
      <button className="icon-btn is-tiny row-more" aria-label="More" onClick={(e) => menuAt(e, folderMenu(path))}>
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function trashMenu(n: NoteDoc): MenuItem[] {
  return [
    { label: 'Restore', icon: <RotateCcw size={16} strokeWidth={1.5} />, run: () => useVault.getState().restoreNote(n.meta.id) },
    { separator: true },
    {
      label: 'Delete forever…',
      icon: <Trash2 size={16} strokeWidth={1.5} />,
      danger: true,
      run: async () => {
        if (
          await confirmDialog({
            title: `Delete ${short(displayTitle(n))} forever?`,
            message: 'It can’t be brought back afterwards.',
            confirm: 'Delete forever',
            danger: true,
          })
        )
          void useVault.getState().deleteForever(n.meta.id);
      },
    },
  ];
}

const SORTS: ['updated' | 'title' | 'created', string][] = [
  ['updated', 'Last edited'],
  ['title', 'Name'],
  ['created', 'Created'],
];

function SortMenu() {
  const sort = useUI((s) => s.sort);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={btn} className={cx('btn is-ghost is-quiet sort-btn', open && 'is-on')} onClick={() => setOpen(!open)} aria-haspopup="menu">
        {SORTS.find(([k]) => k === sort)?.[1]}
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} align="end" className="menu-pop">
        <div className="menu" role="menu">
          <div className="menu-caption">Sort by</div>
          {SORTS.map(([k, label]) => (
            <button
              key={k}
              className="menu-item"
              role="menuitemradio"
              aria-checked={sort === k}
              onClick={() => {
                setOpen(false);
                useUI.getState().set({ sort: k });
              }}
            >
              <span className="menu-label">{label}</span>
              {sort === k && <Check size={16} strokeWidth={1.5} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

const byName = (a: NoteDoc, b: NoteDoc) => displayTitle(a).localeCompare(displayTitle(b), undefined, { numeric: true });

/** All notes (view 'home'), a folder page, or Trash. */
export function NotesPage({ view }: { view: View }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const sort = useUI((s) => s.sort);
  const folderPath = view.kind === 'folder' ? view.path : '';
  const isTrash = view.kind === 'trash';

  const trashed = useMemo(() => Object.values(notes).filter((n) => n.meta.trashed), [notes]);

  const list = useMemo(() => {
    let l: NoteDoc[];
    if (isTrash) l = [...trashed].sort((a, b) => (b.meta.trashed ?? 0) - (a.meta.trashed ?? 0));
    else {
      // All notes: every note except homework (homework lives in Homework and its class).
      l = Object.values(notes).filter((n) => !n.meta.trashed && (view.kind === 'folder' ? n.meta.folder === folderPath : !n.meta.homework));
      l.sort(sort === 'title' ? byName : sort === 'created' ? (a, b) => b.meta.created - a.meta.created : (a, b) => b.meta.updated - a.meta.updated);
    }
    return l;
  }, [notes, trashed, isTrash, view.kind, folderPath, sort]);

  // Folders first: the plain folders on All notes (classes have their own page), the subfolders on a folder page.
  const subfolders = useMemo(() => {
    if (view.kind === 'home') return folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta));
    if (view.kind === 'folder') return folders.filter((f) => f.startsWith(folderPath + '/') && !f.slice(folderPath.length + 1).includes('/'));
    return [];
  }, [folders, folderMeta, view.kind, folderPath]);

  const countIn = (path: string) => Object.values(notes).filter((n) => !n.meta.trashed && (n.meta.folder === path || n.meta.folder.startsWith(path + '/'))).length;

  // Where the back link goes: a class's folder to its parent (the class page at the top), a plain folder to its parent or All notes.
  const back = useMemo((): { label: string; view: View } | null => {
    if (isTrash) return { label: 'All notes', view: { kind: 'home' } };
    if (view.kind !== 'folder') return null;
    const parent = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
    if (!parent) return { label: 'All notes', view: { kind: 'home' } };
    return { label: parent.split('/').pop()!, view: folderMeta[parent]?.kind === 'class' ? { kind: 'class', path: parent } : { kind: 'folder', path: parent } };
  }, [isTrash, view.kind, folderPath, folderMeta]);

  const title = isTrash ? 'Trash' : view.kind === 'folder' ? folderPath.split('/').pop()! : 'All notes';
  const groups = isTrash ? [{ label: '', notes: list }] : groupNotes(list, sort);
  const empty = !list.length && !subfolders.length;
  const inClassHomework = view.kind === 'folder' && folderPath.endsWith('/' + HOMEWORK_SUBFOLDER) && !!classForFolder(folderPath, folderMeta);

  return (
    <div className={cx('screen list-page', isTrash ? 'trash-view' : 'notes-view')}>
      <div className="screen-scroll">
        <div className="list-col">
          <header className="list-head">
            {back && (
              <button className="list-back" onClick={() => useUI.getState().setView(back.view)}>
                <ChevronLeft size={14} strokeWidth={1.5} />
                {back.label}
              </button>
            )}
            <div className="list-head-row">
              <h1 className="list-title" title={title}>
                {title}
              </h1>
              <span className="grow" />
              {view.kind === 'home' && (
                <>
                  <SortMenu />
                  <button className="btn is-ghost is-quiet trash-link" onClick={() => useUI.getState().setView({ kind: 'trash' })}>
                    <Trash2 size={14} strokeWidth={1.5} />
                    Trash{trashed.length ? ` (${trashed.length})` : ''}
                  </button>
                  <button className="btn is-secondary" onClick={() => void newFolder('')}>
                    <FolderPlus size={16} strokeWidth={1.5} /> New folder
                  </button>
                </>
              )}
              {view.kind === 'folder' && (
                <>
                  {!inClassHomework && (
                    <button className="btn is-ghost is-quiet" onClick={() => void newFolder(folderPath)}>
                      <FolderPlus size={14} strokeWidth={1.5} /> New folder
                    </button>
                  )}
                  <button className="icon-btn" aria-label="Folder menu" onClick={(e) => menuAt(e, folderMenu(folderPath))}>
                    <MoreHorizontal size={18} strokeWidth={1.5} />
                  </button>
                </>
              )}
              {isTrash && list.length > 0 && (
                <button
                  className="btn is-secondary"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: 'Empty Trash?',
                        message: `${plural(list.length, 'note')} will be deleted for good.`,
                        confirm: 'Empty Trash',
                        danger: true,
                      })
                    )
                      void useVault.getState().emptyTrash();
                  }}
                >
                  Empty Trash
                </button>
              )}
            </div>
          </header>

          {empty ? (
            <div className="list-empty">{isTrash ? 'Trash is empty' : view.kind === 'folder' ? 'Nothing in this folder yet' : 'No notes yet'}</div>
          ) : (
            <>
              {subfolders.length > 0 && (
                <section className="list-section">
                  <h2 className="list-caption">Folders</h2>
                  {subfolders.map((f) => (
                    <FolderRow key={f} path={f} count={countIn(f)} />
                  ))}
                </section>
              )}
              {groups.map((g, i) =>
                g.notes.length ? (
                  <Fragment key={g.label || i}>
                    <section className="list-section">
                      {(g.label || subfolders.length > 0) && <h2 className="list-caption">{g.label || 'Notes'}</h2>}
                      {g.notes.map((n) => (
                        <NoteRow key={n.meta.id} note={n} place={isTrash ? 'from' : view.kind === 'home' ? 'class' : undefined} trash={isTrash} />
                      ))}
                    </section>
                  </Fragment>
                ) : null,
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
