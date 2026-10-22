import { memo, useMemo } from 'react';
import { ArrowDownUp, Clock, Folder, FolderPlus, Hash, Home, LayoutGrid, List, MoreHorizontal, Plus, RotateCcw, Star, Trash2 } from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI, type View } from '../state/ui';
import { useSettings } from '../state/settings';
import type { NoteDoc } from '../lib/vault/types';
import { docToHTML } from '../lib/doc/toHTML';
import { docToText } from '../lib/ai/context';
import { cx, formatRelativeTime, hashString, plural } from '../lib/util';
import { newFolder, newNote, openClass } from '../lib/commands';
import { classHomework, classInfo, classNotes } from '../lib/classes';
import { ClassGlyph } from './classes/ClassIcon';
import { noteMenu, noteTitle, FOLDER_COLORS } from './FileTree';
import { openContextMenu } from './common/ContextMenu';
import { confirmDialog } from './common/dialogs';

const COVER_PALETTE = ['#2160e8', '#7346e6', '#1f9d4c', '#e35d14', '#0f8073', '#d62f7a', '#c98a04', '#1f3a8a'];

export function coverColor(key: string, explicit?: string) {
  if (explicit) return explicit;
  return COVER_PALETTE[parseInt(hashString(key), 36) % COVER_PALETTE.length];
}

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

function viewTitle(v: View): { title: string; icon: React.ReactNode } {
  switch (v.kind) {
    case 'home':
      return { title: 'All notes', icon: <Home size={20} /> };
    case 'folder':
      return { title: v.path.split('/').pop()!, icon: <Folder size={20} /> };
    case 'tag':
      return { title: `#${v.tag}`, icon: <Hash size={20} /> };
    case 'favorites':
      return { title: 'Favorites', icon: <Star size={20} /> };
    case 'recent':
      return { title: 'Recent', icon: <Clock size={20} /> };
    case 'trash':
      return { title: 'Trash', icon: <Trash2 size={20} /> };
    default:
      return { title: '', icon: null };
  }
}

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

  const subfolders = useMemo(() => {
    if (view.kind === 'home') return folders.filter((f) => !f.includes('/'));
    if (view.kind === 'folder') return folders.filter((f) => f.startsWith(view.path + '/') && !f.slice(view.path.length + 1).includes('/'));
    return [];
  }, [folders, view]);

  const folderCount = (path: string) =>
    Object.values(notes).filter((n) => !n.meta.trashed && (n.meta.folder === path || n.meta.folder.startsWith(path + '/'))).length;

  const { title, icon } = viewTitle(view);
  const folderPath = view.kind === 'folder' ? view.path : '';
  const canCreate = view.kind === 'home' || view.kind === 'folder' || view.kind === 'tag';

  return (
    <div className="collection">
      <div className="collection-head">
        <div className="collection-title">
          <span className="collection-icon" style={view.kind === 'folder' ? { color: coverColor(view.path, folderMeta[view.path]?.color) } : undefined}>
            {icon}
          </span>
          <div>
            {view.kind === 'folder' && view.path.includes('/') && (
              <div className="collection-crumbs">
                {view.path
                  .split('/')
                  .slice(0, -1)
                  .map((part, i, arr) => (
                    <button key={i} onClick={() => useUI.getState().setView({ kind: 'folder', path: [...arr.slice(0, i), part].join('/') })}>
                      {part} /
                    </button>
                  ))}
              </div>
            )}
            <h1>{title}</h1>
            <div className="collection-sub">
              {plural(list.length, 'note')}
              {subfolders.length ? ` · ${plural(subfolders.length, 'folder')}` : ''}
            </div>
          </div>
        </div>
        <div className="collection-actions">
          {view.kind === 'trash' && list.length > 0 && (
            <button
              className="btn is-ghost is-danger-text"
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
              <Trash2 size={15} /> Empty Trash
            </button>
          )}
          {view.kind !== 'trash' && view.kind !== 'recent' && (
            <button
              className="btn is-ghost"
              onClick={() => useUI.getState().set({ sort: sort === 'updated' ? 'title' : sort === 'title' ? 'created' : 'updated' })}
              title="Sort"
            >
              <ArrowDownUp size={14} /> {sort === 'updated' ? 'Last edited' : sort === 'title' ? 'Name' : 'Created'}
            </button>
          )}
          <div className="seg">
            <button className={cx(gridMode === 'grid' && 'is-active')} onClick={() => useUI.getState().set({ gridMode: 'grid' })} aria-label="Grid">
              <LayoutGrid size={15} />
            </button>
            <button className={cx(gridMode === 'list' && 'is-active')} onClick={() => useUI.getState().set({ gridMode: 'list' })} aria-label="List">
              <List size={15} />
            </button>
          </div>
          {(view.kind === 'home' || view.kind === 'folder') && (
            <button className="btn is-ghost" onClick={() => void newFolder(folderPath)}>
              <FolderPlus size={15} /> Folder
            </button>
          )}
          {canCreate && (
            <button
              className="btn is-primary"
              onClick={() => {
                const doc = newNote(folderPath);
                if (view.kind === 'tag') useVault.getState().updateMeta(doc.meta.id, { tags: [view.tag] });
              }}
            >
              <Plus size={15} /> New note
            </button>
          )}
        </div>
      </div>

      {subfolders.length > 0 && (
        <div className="notebooks">
          {subfolders.map((f) =>
            folderMeta[f]?.kind === 'class' ? (
              <ClassCover key={f} path={f} />
            ) : (
              <button
                key={f}
                className="notebook"
                onClick={() => {
                  useUI.getState().setView({ kind: 'folder', path: f });
                  useUI.getState().toggleFolder(f, true);
                }}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: 'New note here', icon: <Plus size={15} />, run: () => newNote(f) },
                    {
                      label: 'Change colour',
                      icon: <span className="menu-dot" style={{ background: coverColor(f, folderMeta[f]?.color) }} />,
                      run: () => {
                        const cur = FOLDER_COLORS.indexOf(folderMeta[f]?.color ?? '');
                        useVault.getState().setFolderMeta(f, { color: FOLDER_COLORS[(cur + 1) % FOLDER_COLORS.length] || COVER_PALETTE[0] });
                      },
                    },
                  ])
                }
              >
                <span className="notebook-cover" style={{ ['--cover' as string]: coverColor(f, folderMeta[f]?.color) }}>
                  <span className="notebook-spine" />
                  <span className="notebook-label">{f.split('/').pop()}</span>
                </span>
                <span className="notebook-meta">{plural(folderCount(f), 'note')}</span>
              </button>
            ),
          )}
        </div>
      )}

      {list.length === 0 && subfolders.length === 0 ? (
        <EmptyState view={view} />
      ) : gridMode === 'grid' ? (
        <div className="note-grid">
          {list.map((n) => (
            <NoteCard key={n.meta.id} note={n} trash={view.kind === 'trash'} />
          ))}
        </div>
      ) : (
        <div className="note-list">
          {list.map((n) => (
            <NoteListRow key={n.meta.id} note={n} trash={view.kind === 'trash'} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A class on the home page: a notebook cover with its icon, code and what's due. */
function ClassCover({ path }: { path: string }) {
  const notes = useVault((s) => s.notes);
  const meta = useVault((s) => s.folderMeta[path]);
  const cls = classInfo(path, meta);
  const count = classNotes(path, notes).length;
  const due = classHomework(path, notes).filter((n) => !n.meta.homework!.done).length;
  return (
    <button className="notebook is-class" onClick={() => openClass(path)}>
      <span className="notebook-cover" style={{ ['--cover' as string]: cls.color }}>
        <span className="notebook-spine" />
        <span className="notebook-label">
          {cls.name}
          {cls.code && <span className="notebook-code">{cls.code}</span>}
        </span>
        <span className="notebook-glyph">
          <ClassGlyph icon={cls.icon} size={30} />
        </span>
        {due > 0 && <span className="notebook-due">{due} due</span>}
      </span>
      <span className="notebook-meta">
        {plural(count, 'note')}
        {cls.instructor ? ` · ${cls.instructor}` : ''}
      </span>
    </button>
  );
}

function open(n: NoteDoc, trash: boolean, e?: React.MouseEvent) {
  if (trash) return;
  useUI.getState().openNote(n.meta.id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) || true });
}

function trashMenu(n: NoteDoc) {
  return [
    { label: 'Restore', icon: <RotateCcw size={15} />, run: () => useVault.getState().restoreNote(n.meta.id) },
    { separator: true },
    {
      label: 'Delete permanently',
      icon: <Trash2 size={15} />,
      danger: true,
      run: async () => {
        if (
          await confirmDialog({
            title: 'Delete permanently?',
            message: `“${noteTitle(n)}” can’t be recovered from Nib afterwards.`,
            confirm: 'Delete',
            danger: true,
          })
        )
          void useVault.getState().deleteForever(n.meta.id);
      },
    },
  ];
}

export const NoteCard = memo(function NoteCard({ note, trash }: { note: NoteDoc; trash: boolean }) {
  return (
    <div
      className="note-card"
      role="button"
      tabIndex={0}
      onClick={(e) => open(note, trash, e)}
      onKeyDown={(e) => e.key === 'Enter' && open(note, trash)}
      onContextMenu={(e) => openContextMenu(e, trash ? trashMenu(note) : noteMenu(note))}
    >
      <div className="note-card-thumb">
        <NoteThumb note={note} width={188} />
        {note.meta.color && <span className="note-card-ribbon" style={{ background: note.meta.color }} />}
        {!trash && (
          <button
            className={cx('note-card-star', note.meta.pinned && 'is-on')}
            onClick={(e) => {
              e.stopPropagation();
              useVault.getState().updateMeta(note.meta.id, { pinned: !note.meta.pinned, updated: note.meta.updated });
            }}
            aria-label="Favorite"
          >
            <Star size={14} />
          </button>
        )}
        {trash && (
          <button
            className="note-card-restore"
            onClick={(e) => {
              e.stopPropagation();
              useVault.getState().restoreNote(note.meta.id);
            }}
          >
            <RotateCcw size={13} /> Restore
          </button>
        )}
      </div>
      <div className="note-card-info">
        <div className={cx('note-card-title', !note.meta.title && 'is-untitled')}>{noteTitle(note)}</div>
        <div className="note-card-meta">
          {formatRelativeTime(note.meta.updated)}
          {note.meta.folder && <span className="note-card-folder"> · {note.meta.folder.split('/').pop()}</span>}
        </div>
      </div>
    </div>
  );
});

export function NoteListRow({ note, trash }: { note: NoteDoc; trash: boolean }) {
  const snippet = useMemo(
    () =>
      docToText(note.content)
        .replace(/[#*=`>$]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 140),
    [note.content],
  );
  return (
    <div
      className="note-row"
      role="button"
      tabIndex={0}
      onClick={(e) => open(note, trash, e)}
      onContextMenu={(e) => openContextMenu(e, trash ? trashMenu(note) : noteMenu(note))}
    >
      <div className="note-row-mini">
        <NoteThumb note={note} width={44} />
      </div>
      <div className="note-row-main">
        <div className={cx('note-row-title', !note.meta.title && 'is-untitled')}>
          {noteTitle(note)}
          {note.meta.pinned && <Star size={12} className="note-row-star" />}
        </div>
        <div className="note-row-snippet">{snippet || 'Empty note'}</div>
      </div>
      <div className="note-row-tags">
        {note.meta.tags.slice(0, 3).map((t) => (
          <span key={t} className="tag-mini">
            #{t}
          </span>
        ))}
      </div>
      <div className="note-row-folder">{note.meta.folder.split('/').pop()}</div>
      <div className="note-row-date">{formatRelativeTime(note.meta.updated)}</div>
      <button
        className="icon-btn is-tiny"
        onClick={(e) => {
          e.stopPropagation();
          openContextMenu(e, trash ? trashMenu(note) : noteMenu(note));
        }}
        aria-label="More"
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

function EmptyState({ view }: { view: View }) {
  const text =
    view.kind === 'trash'
      ? ['The Trash is empty', 'Notes you delete stay here until you empty it.']
      : view.kind === 'favorites'
        ? ['No favorites yet', 'Star a note to keep it one click away.']
        : view.kind === 'tag'
          ? ['No notes with this tag', 'Add tags under a note’s title.']
          : ['Nothing here yet', 'Create a note — type, write by hand, or both.'];
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden>
        <svg viewBox="0 0 120 90" width="120" height="90">
          <rect x="22" y="10" width="64" height="76" rx="6" fill="#fff" stroke="#e4e4e2" />
          <path d="M32 30h44M32 42h44M32 54h30" stroke="#ececea" strokeWidth="2" strokeLinecap="round" />
          <path d="M34 66c6-6 10 4 16-2s10 3 14-1" fill="none" stroke="#2160e8" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M86 18l14-8 4 6-14 9z" fill="#1c1c1e" />
        </svg>
      </div>
      <div className="empty-title">{text[0]}</div>
      <div className="empty-sub">{text[1]}</div>
      {(view.kind === 'home' || view.kind === 'folder') && (
        <button className="btn is-primary" onClick={() => newNote(view.kind === 'folder' ? view.path : '')}>
          <Plus size={15} /> New note
        </button>
      )}
    </div>
  );
}
