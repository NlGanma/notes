import { memo, useMemo } from 'react';
import { ArrowDownUp, Check, ChevronRight, ClipboardList, FileText, Folder, FolderPlus, LayoutGrid, List, MoreVertical, Plus, RotateCcw, Star, Tag, Trash2 } from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI, type View } from '../state/ui';
import { useSettings } from '../state/settings';
import type { NoteDoc } from '../lib/vault/types';
import { docToHTML } from '../lib/doc/toHTML';
import { cx, plural } from '../lib/util';
import { newFolder, newNote } from '../lib/commands';
import { classForFolder, classInfo, themeVars } from '../lib/classes';
import { folderMenu, noteMenu, noteTitle } from './FileTree';
import { openContextMenu } from './common/ContextMenu';
import { confirmDialog } from './common/dialogs';

const thumbCache = new Map<string, string>();

function thumbHTML(n: NoteDoc): string {
  const key = `${n.meta.id}:${n.meta.updated}`;
  let html = thumbCache.get(key);
  if (!html) {
    html = docToHTML(n.content, { maxBlocks: 16 });
    thumbCache.set(key, html);
    if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value!);
  }
  return html;
}

export const NoteThumb = memo(function NoteThumb({ note, width = 200 }: { note: NoteDoc; width?: number }) {
  const defaultPaper = useSettings((s) => s.paper);
  const scale = width / 816;
  return (
    <div className="thumb" style={{ width, height: width * 1.22 }}>
      <div className={cx('thumb-page nib-doc', `paper-${note.meta.paper ?? defaultPaper}`)} style={{ transform: `scale(${scale})` }}>
        <div className="thumb-title">{note.meta.title || 'Untitled'}</div>
        <div className="thumb-body" dangerouslySetInnerHTML={{ __html: thumbHTML(note) }} />
      </div>
    </div>
  );
});

function viewTitle(v: View): string {
  switch (v.kind) {
    case 'home':
      return 'All notes';
    case 'folder':
      return v.path.split('/').pop()!;
    case 'tag':
      return v.tag;
    case 'favorites':
      return 'Favorites';
    case 'recent':
      return 'Recent';
    case 'trash':
      return 'Trash';
    default:
      return '';
  }
}

/** The class a note belongs to, for its avatar letter and theme. */
function useClassOf(n: NoteDoc) {
  const folderMeta = useVault((s) => s.folderMeta);
  const p = classForFolder(n.meta.folder, folderMeta);
  return p ? classInfo(p, folderMeta[p]) : null;
}

/** Notes and folders as Google Drive shows files: folder tiles, then note cards (or a list). */
export function NoteGrid({ view }: { view: View }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const { gridMode, sort } = useUI();

  const list = useMemo(() => {
    let l = Object.values(notes);
    if (view.kind === 'trash') l = l.filter((n) => n.meta.trashed);
    else {
      l = l.filter((n) => !n.meta.trashed);
      if (view.kind === 'folder') l = l.filter((n) => n.meta.folder === view.path);
      if (view.kind === 'home') l = l.filter((n) => !n.meta.homework);
      if (view.kind === 'tag') l = l.filter((n) => n.meta.tags.includes(view.tag));
      if (view.kind === 'favorites') l = l.filter((n) => n.meta.pinned);
    }
    const by = view.kind === 'recent' ? 'updated' : sort;
    l.sort((a, b) =>
      by === 'title'
        ? noteTitle(a).localeCompare(noteTitle(b), undefined, { numeric: true })
        : by === 'created'
          ? b.meta.created - a.meta.created
          : b.meta.updated - a.meta.updated,
    );
    if (view.kind === 'recent') l = l.slice(0, 24);
    return l;
  }, [notes, view, sort]);

  // All notes shows plain folders only: classes have their own pages.
  const subfolders = useMemo(() => {
    if (view.kind === 'home') return folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta));
    if (view.kind === 'folder') return folders.filter((f) => f.startsWith(view.path + '/') && !f.slice(view.path.length + 1).includes('/'));
    return [];
  }, [folders, folderMeta, view]);

  const folderCount = (path: string) =>
    Object.values(notes).filter((n) => !n.meta.trashed && (n.meta.folder === path || n.meta.folder.startsWith(path + '/'))).length;

  const title = viewTitle(view);
  const folderPath = view.kind === 'folder' ? view.path : '';
  const canCreate = view.kind === 'home' || view.kind === 'folder' || view.kind === 'tag';
  const sortLabel = sort === 'updated' ? 'Last edited' : sort === 'title' ? 'Name' : 'Date created';

  return (
    <div className="screen notes-view">
      <div className="screen-head">
        {view.kind === 'folder' && view.path.includes('/') ? (
          <nav className="crumbs" aria-label="Breadcrumb">
            {view.path
              .split('/')
              .slice(0, -1)
              .map((part, i, arr) => (
                <span key={i} className="crumb-step">
                  <button className="crumb-root" onClick={() => useUI.getState().setView({ kind: 'folder', path: [...arr.slice(0, i), part].join('/') })}>
                    {part}
                  </button>
                  <ChevronRight size={20} className="crumb-sep" />
                </span>
              ))}
            <h1 className="screen-title">{title}</h1>
          </nav>
        ) : (
          <h1 className="screen-title">
            {view.kind === 'tag' && <Tag size={20} className="screen-title-icon" />}
            {title}
          </h1>
        )}
        <span className="grow" />
        {view.kind !== 'trash' && view.kind !== 'recent' && (
          <button
            className="btn is-ghost is-quiet"
            onClick={() => useUI.getState().set({ sort: sort === 'updated' ? 'title' : sort === 'title' ? 'created' : 'updated' })}
            title="Change the order"
          >
            <ArrowDownUp size={18} /> {sortLabel}
          </button>
        )}
        <div className="seg" role="radiogroup" aria-label="Layout">
          <button className={cx(gridMode === 'list' && 'is-active')} onClick={() => useUI.getState().set({ gridMode: 'list' })} aria-label="List" title="List layout">
            {gridMode === 'list' && <Check size={16} />}
            <List size={18} />
          </button>
          <button className={cx(gridMode === 'grid' && 'is-active')} onClick={() => useUI.getState().set({ gridMode: 'grid' })} aria-label="Grid" title="Grid layout">
            {gridMode === 'grid' && <Check size={16} />}
            <LayoutGrid size={18} />
          </button>
        </div>
      </div>

      <div className="screen-scroll">
        <div className="notes-body">
          {view.kind === 'trash' && list.length > 0 && (
            <div className="info-bar">
              <span>Notes in the Trash stay here until you empty it.</span>
              <span className="grow" />
              <button
                className="btn is-ghost"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Empty the Trash?',
                      message: `${plural(list.length, 'note')} will be deleted permanently.`,
                      confirm: 'Empty Trash',
                      danger: true,
                    })
                  )
                    void useVault.getState().emptyTrash();
                }}
              >
                Empty trash
              </button>
            </div>
          )}

          {canCreate && (
            <div className="notes-toolbar">
              <button
                className="btn is-primary is-create"
                onClick={() => {
                  const doc = newNote(folderPath);
                  if (view.kind === 'tag') useVault.getState().updateMeta(doc.meta.id, { tags: [view.tag] });
                }}
              >
                <Plus size={22} /> New note
              </button>
              {(view.kind === 'home' || view.kind === 'folder') && (
                <button className="btn is-secondary" onClick={() => void newFolder(folderPath)}>
                  <FolderPlus size={18} /> Folder
                </button>
              )}
            </div>
          )}

          {subfolders.length > 0 && (
            <>
              <h2 className="notes-section">Folders</h2>
              <div className="folder-grid">
                {subfolders.map((f) => (
                  <div
                    key={f}
                    className="folder-tile notebook"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      useUI.getState().setView({ kind: 'folder', path: f });
                      useUI.getState().toggleFolder(f, true);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && useUI.getState().setView({ kind: 'folder', path: f })}
                    onContextMenu={(e) => openContextMenu(e, folderMenu(f))}
                    title={`${f.split('/').pop()} · ${plural(folderCount(f), 'note')}`}
                  >
                    <Folder size={22} className="folder-tile-icon" style={folderMeta[f]?.color ? { color: folderMeta[f]!.color, fill: folderMeta[f]!.color } : undefined} />
                    <span className="folder-tile-name">{f.split('/').pop()}</span>
                    <button
                      className="icon-btn folder-tile-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        openContextMenu(e, folderMenu(f));
                      }}
                      aria-label="More"
                    >
                      <MoreVertical size={20} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {list.length === 0 && subfolders.length === 0 ? (
            <EmptyState view={view} />
          ) : list.length === 0 ? null : gridMode === 'grid' ? (
            <>
              {subfolders.length > 0 && <h2 className="notes-section">Notes</h2>}
              <div className="note-grid">
                {list.map((n) => (
                  <NoteCard key={n.meta.id} note={n} trash={view.kind === 'trash'} />
                ))}
              </div>
            </>
          ) : (
            <div className="note-list" role="table">
              <div className="note-list-head" role="row">
                <span className="note-list-name">Name</span>
                <span className="note-list-where">Location</span>
                <span className="note-list-date">{view.kind === 'trash' ? 'Trashed' : 'Last edited'}</span>
                <span className="note-list-more" />
              </div>
              {list.map((n) => (
                <NoteListRow key={n.meta.id} note={n} trash={view.kind === 'trash'} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function open(n: NoteDoc, trash: boolean, e?: React.MouseEvent) {
  if (trash) return;
  useUI.getState().openNote(n.meta.id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) || true });
}

function trashMenu(n: NoteDoc) {
  return [
    { label: 'Restore', icon: <RotateCcw size={20} />, run: () => useVault.getState().restoreNote(n.meta.id) },
    { separator: true },
    {
      label: 'Delete forever',
      icon: <Trash2 size={20} />,
      danger: true,
      run: async () => {
        if (
          await confirmDialog({
            title: 'Delete forever?',
            message: `“${noteTitle(n)}” can’t be recovered from Nib afterwards.`,
            confirm: 'Delete forever',
            danger: true,
          })
        )
          void useVault.getState().deleteForever(n.meta.id);
      },
    },
  ];
}

const edited = (t: number) => {
  const d = new Date(t);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** A note as a Google Drive grid card: type icon, title and ⋮; a page preview; who/where and when. */
export const NoteCard = memo(function NoteCard({ note, trash }: { note: NoteDoc; trash: boolean }) {
  const cls = useClassOf(note);
  const menu = (e: React.MouseEvent) => openContextMenu(e, trash ? trashMenu(note) : noteMenu(note));
  return (
    <div
      className="note-card"
      role="button"
      tabIndex={0}
      style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
      onClick={(e) => open(note, trash, e)}
      onKeyDown={(e) => e.key === 'Enter' && open(note, trash)}
      onContextMenu={menu}
    >
      <div className="note-card-top">
        {note.meta.homework ? <ClipboardList size={20} className="note-card-type" /> : <FileText size={20} className="note-card-type" />}
        <span className={cx('note-card-title', !note.meta.title && 'is-untitled')}>{noteTitle(note)}</span>
        <button
          className="icon-btn note-card-more"
          onClick={(e) => {
            e.stopPropagation();
            menu(e);
          }}
          aria-label="More"
        >
          <MoreVertical size={20} />
        </button>
      </div>
      <div className="note-card-thumb">
        <NoteThumb note={note} width={196} />
        {note.meta.pinned && !trash && <Star size={16} className="note-card-star is-on" />}
      </div>
      <div className="note-card-meta">
        {cls ? (
          <span className="class-letter is-small" title={cls.name}>
            {cls.name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <Folder size={16} className="note-card-folder-icon" />
        )}
        <span className="note-card-when">
          {trash ? 'Trashed' : 'Edited'} {edited(note.meta.updated)}
        </span>
        {trash && (
          <button
            className="icon-btn is-tiny note-card-restore"
            aria-label="Restore"
            title="Restore"
            onClick={(e) => {
              e.stopPropagation();
              useVault.getState().restoreNote(note.meta.id);
            }}
          >
            <RotateCcw size={18} />
          </button>
        )}
      </div>
    </div>
  );
});

/** A note as a Google Drive list row: Name | Location | Last edited | ⋮. */
export function NoteListRow({ note, trash }: { note: NoteDoc; trash: boolean }) {
  const cls = useClassOf(note);
  const where = cls ? cls.name + (note.meta.folder !== cls.path ? ` › ${note.meta.folder.split('/').pop()}` : '') : note.meta.folder.split('/').pop() || 'Notes';
  return (
    <div
      className="note-row"
      role="row"
      tabIndex={0}
      style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
      onClick={(e) => open(note, trash, e)}
      onKeyDown={(e) => e.key === 'Enter' && open(note, trash)}
      onContextMenu={(e) => openContextMenu(e, trash ? trashMenu(note) : noteMenu(note))}
    >
      <span className="note-list-name">
        {note.meta.homework ? <ClipboardList size={20} className="note-card-type" /> : <FileText size={20} className="note-card-type" />}
        <span className={cx('note-row-title', !note.meta.title && 'is-untitled')}>{noteTitle(note)}</span>
        {note.meta.pinned && <Star size={14} className="note-row-star" />}
      </span>
      <span className="note-list-where">{where}</span>
      <span className="note-list-date">{edited(note.meta.updated)}</span>
      <span className="note-list-more">
        <button
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            openContextMenu(e, trash ? trashMenu(note) : noteMenu(note));
          }}
          aria-label="More"
        >
          <MoreVertical size={20} />
        </button>
      </span>
    </div>
  );
}

function EmptyState({ view }: { view: View }) {
  const text =
    view.kind === 'trash'
      ? 'Nothing in the Trash'
      : view.kind === 'favorites'
        ? 'No favorites yet. Star a note to keep it here.'
        : view.kind === 'tag'
          ? 'No notes with this label'
          : view.kind === 'recent'
            ? 'No recent notes'
            : 'No notes here yet';
  return <div className="screen-empty">{text}</div>;
}
