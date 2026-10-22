import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Copy,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Palette,
  Pencil,
  Pin,
  PinOff,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import { openContextMenu, type MenuItem } from './common/ContextMenu';
import { confirmDialog, pickFolder } from './common/dialogs';
import { newFolder, newNote } from '../lib/commands';
import { cx } from '../lib/util';
import type { NoteDoc } from '../lib/vault/types';
import { exportNote } from '../lib/export';
import { bridge } from '../lib/platform';

export const FOLDER_COLORS = ['', '#2160e8', '#7346e6', '#1f9d4c', '#e35d14', '#dc2b2b', '#c98a04', '#0f8073', '#d62f7a'];

const DRAG_NOTE = 'application/x-nib-note';
const DRAG_FOLDER = 'application/x-nib-folder';

export function noteTitle(n: NoteDoc) {
  return n.meta.title || 'Untitled';
}

function sortNotes(list: NoteDoc[]) {
  return [...list].sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), undefined, { numeric: true }));
}

/** Obsidian-style folder tree with notes, drag & drop and inline rename. */
export function FileTree() {
  const folders = useVault((s) => s.folders);
  const notes = useVault((s) => s.notes);
  const [rootDrop, setRootDrop] = useState(false);

  const byFolder = useMemo(() => {
    const map = new Map<string, NoteDoc[]>();
    for (const n of Object.values(notes)) {
      if (n.meta.trashed) continue;
      const list = map.get(n.meta.folder) ?? [];
      list.push(n);
      map.set(n.meta.folder, list);
    }
    return map;
  }, [notes]);

  const top = folders.filter((f) => !f.includes('/'));

  return (
    <div
      className={cx('tree', rootDrop && 'is-drop')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_NOTE) || e.dataTransfer.types.includes(DRAG_FOLDER)) {
          e.preventDefault();
          setRootDrop(true);
        }
      }}
      onDragLeave={() => setRootDrop(false)}
      onDrop={(e) => {
        setRootDrop(false);
        const id = e.dataTransfer.getData(DRAG_NOTE);
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        if (id) useVault.getState().moveNote(id, '');
        else if (folder) void useVault.getState().moveFolder(folder, '');
      }}
    >
      {top.map((f) => (
        <FolderRow key={f} path={f} depth={0} folders={folders} byFolder={byFolder} />
      ))}
      {sortNotes(byFolder.get('') ?? []).map((n) => (
        <NoteRow key={n.meta.id} note={n} depth={0} />
      ))}
    </div>
  );
}

function FolderRow({ path, depth, folders, byFolder }: { path: string; depth: number; folders: string[]; byFolder: Map<string, NoteDoc[]> }) {
  const expanded = useUI((s) => !!s.expanded[path]);
  const renaming = useUI((s) => s.renaming === `folder:${path}`);
  const view = useUI((s) => s.view);
  const meta = useVault((s) => s.folderMeta[path]);
  const [drop, setDrop] = useState(false);
  const name = path.split('/').pop()!;
  const children = folders.filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/'));
  const notes = sortNotes(byFolder.get(path) ?? []);
  const count = useMemo(() => {
    let c = 0;
    for (const [f, list] of byFolder) if (f === path || f.startsWith(path + '/')) c += list.length;
    return c;
  }, [byFolder, path]);
  const isActive = view.kind === 'folder' && view.path === path;

  const menu = (): MenuItem[] => [
    { label: 'New note', icon: <FilePlus size={15} />, run: () => newNote(path) },
    { label: 'New folder inside', icon: <FolderPlus size={15} />, run: () => void newFolder(path) },
    { separator: true },
    { label: 'Rename', icon: <Pencil size={15} />, run: () => useUI.getState().set({ renaming: `folder:${path}` }) },
    {
      label: 'Colour',
      icon: <Palette size={15} />,
      run: () => {
        const cur = FOLDER_COLORS.indexOf(meta?.color ?? '');
        useVault.getState().setFolderMeta(path, { color: FOLDER_COLORS[(cur + 1) % FOLDER_COLORS.length] });
      },
    },
    { separator: true },
    {
      label: 'Delete folder',
      icon: <Trash2 size={15} />,
      danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: `Delete “${name}”?`,
          message: count ? `Its ${count} note${count === 1 ? '' : 's'} will move to the Trash, where you can restore them.` : 'The folder is empty.',
          confirm: 'Delete folder',
          danger: true,
        });
        if (ok) void useVault.getState().deleteFolder(path);
      },
    },
  ];

  return (
    <div className="tree-folder">
      <div
        className={cx('tree-row is-folder', isActive && 'is-active', drop && 'is-drop')}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_FOLDER, path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_NOTE) || e.dataTransfer.types.includes(DRAG_FOLDER)) {
            e.preventDefault();
            e.stopPropagation();
            setDrop(true);
          }
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrop(false);
          const id = e.dataTransfer.getData(DRAG_NOTE);
          const folder = e.dataTransfer.getData(DRAG_FOLDER);
          if (id) useVault.getState().moveNote(id, path);
          else if (folder && folder !== path) void useVault.getState().moveFolder(folder, path);
          useUI.getState().toggleFolder(path, true);
        }}
        onClick={() => {
          useUI.getState().setView({ kind: 'folder', path });
          useUI.getState().toggleFolder(path, true);
        }}
        onContextMenu={(e) => openContextMenu(e, menu())}
      >
        <button
          className={cx('tree-chevron', expanded && 'is-open')}
          onClick={(e) => {
            e.stopPropagation();
            useUI.getState().toggleFolder(path);
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronRight size={13} />
        </button>
        <span className="tree-icon" style={meta?.color ? { color: meta.color } : undefined}>
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
        </span>
        {renaming ? (
          <InlineRename
            value={name}
            onDone={(v) => {
              useUI.getState().set({ renaming: null });
              if (v && v !== name) void useVault.getState().renameFolder(path, v);
            }}
          />
        ) : (
          <span className="tree-label">{name}</span>
        )}
        <span className="tree-count">{count || ''}</span>
      </div>
      {expanded && (
        <div className="tree-children">
          {children.map((c) => (
            <FolderRow key={c} path={c} depth={depth + 1} folders={folders} byFolder={byFolder} />
          ))}
          {notes.map((n) => (
            <NoteRow key={n.meta.id} note={n} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function noteMenu(n: NoteDoc): MenuItem[] {
  const vault = useVault.getState();
  return [
    { label: 'Open in new tab', icon: <SquareArrowOutUpRight size={15} />, run: () => useUI.getState().openNote(n.meta.id, { newTab: true }) },
    { label: 'Rename', icon: <Pencil size={15} />, run: () => useUI.getState().set({ renaming: `note:${n.meta.id}` }) },
    n.meta.pinned
      ? { label: 'Remove from Favorites', icon: <PinOff size={15} />, run: () => vault.updateMeta(n.meta.id, { pinned: false, updated: n.meta.updated }) }
      : { label: 'Add to Favorites', icon: <Pin size={15} />, run: () => vault.updateMeta(n.meta.id, { pinned: true, updated: n.meta.updated }) },
    {
      label: 'Duplicate',
      icon: <Copy size={15} />,
      run: () => {
        const d = vault.duplicateNote(n.meta.id);
        if (d) useUI.getState().openNote(d.meta.id, { newTab: true });
      },
    },
    {
      label: 'Move to…',
      icon: <FolderInput size={15} />,
      run: async () => {
        const choice = await pickFolder(`Move “${noteTitle(n)}” to…`, n.meta.folder);
        if (choice !== null) vault.moveNote(n.meta.id, choice);
      },
    },
    { label: 'Export as PDF', icon: <Download size={15} />, run: () => void exportNote(n.meta.id, 'pdf') },
    ...(bridge ? [{ label: 'Reveal in Finder', icon: <FolderOpen size={15} />, run: () => vault.backend?.reveal?.(n.meta.id) }] : []),
    { separator: true },
    { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, run: () => trashNote(n.meta.id) },
  ];
}

export function trashNote(id: string) {
  useVault.getState().trashNote(id);
  useUI.getState().closeTab(id);
}

function NoteRow({ note, depth }: { note: NoteDoc; depth: number }) {
  const active = useUI((s) => s.view.kind === 'note' && s.view.id === note.meta.id);
  const renaming = useUI((s) => s.renaming === `note:${note.meta.id}`);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={ref}
      className={cx('tree-row is-note', active && 'is-active')}
      style={{ paddingLeft: 8 + depth * 14 + 15 }}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_NOTE, note.meta.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => useUI.getState().openNote(note.meta.id, { newTab: e.metaKey || e.ctrlKey })}
      onAuxClick={(e) => e.button === 1 && useUI.getState().openNote(note.meta.id, { newTab: true })}
      onContextMenu={(e) => openContextMenu(e, noteMenu(note))}
    >
      <span className="tree-icon is-note" style={note.meta.color ? { color: note.meta.color } : undefined}>
        <FileText size={14} />
      </span>
      {renaming ? (
        <InlineRename
          value={note.meta.title}
          onDone={(v) => {
            useUI.getState().set({ renaming: null });
            if (v !== note.meta.title) useVault.getState().updateMeta(note.meta.id, { title: v });
          }}
        />
      ) : (
        <span className={cx('tree-label', !note.meta.title && 'is-untitled')}>{noteTitle(note)}</span>
      )}
      {note.meta.pinned && <Pin size={11} className="tree-pin" />}
    </div>
  );
}

export function InlineRename({ value, onDone }: { value: string; onDone(v: string): void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (val: string) => {
    if (done.current) return;
    done.current = true;
    onDone(val.trim());
  };
  return (
    <input
      ref={ref}
      className="tree-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(value);
      }}
    />
  );
}
