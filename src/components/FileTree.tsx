import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ClipboardList,
  ClipboardCheck,
  Copy,
  GraduationCap,
  Settings2,
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
import { editClass, newFolder, newHomework, newNote, openClass } from '../lib/commands';
import { classForFolder, classInfo, HOMEWORK_SUBFOLDER, listClasses } from '../lib/classes';
import { ClassBadge } from './classes/ClassIcon';
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

/**
 * Obsidian-style folder tree with notes, drag & drop and inline rename.
 * `roots` limits it to some top-level folders (the sidebar shows classes and
 * other folders in separate sections); `rootNotes` adds notes at the top level.
 */
export function FileTree({ roots, rootNotes = true }: { roots?: string[]; rootNotes?: boolean } = {}) {
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

  const top = roots ?? folders.filter((f) => !f.includes('/'));

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
      {rootNotes && sortNotes(byFolder.get('') ?? []).map((n) => <NoteRow key={n.meta.id} note={n} depth={0} />)}
    </div>
  );
}

function FolderRow({ path, depth, folders, byFolder }: { path: string; depth: number; folders: string[]; byFolder: Map<string, NoteDoc[]> }) {
  const expanded = useUI((s) => !!s.expanded[path]);
  const renaming = useUI((s) => s.renaming === `folder:${path}`);
  const view = useUI((s) => s.view);
  const meta = useVault((s) => s.folderMeta[path]);
  const isClass = meta?.kind === 'class';
  const isHomeworkDir = useVault((s) => path.endsWith('/' + HOMEWORK_SUBFOLDER) && !!classForFolder(path, s.folderMeta));
  const cls = isClass ? classInfo(path, meta) : null;
  const [drop, setDrop] = useState(false);
  const name = path.split('/').pop()!;
  const children = folders.filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/'));
  const notes = sortNotes(byFolder.get(path) ?? []);
  const count = useMemo(() => {
    let c = 0;
    for (const [f, list] of byFolder) if (f === path || f.startsWith(path + '/')) c += list.length;
    return c;
  }, [byFolder, path]);
  const isActive = (view.kind === 'folder' || view.kind === 'class') && view.path === path;
  const homeworkTodo = useMemo(() => {
    if (!isClass && !isHomeworkDir) return 0;
    let c = 0;
    for (const [f, list] of byFolder) if (f === path || f.startsWith(path + '/')) c += list.filter((n) => n.meta.homework && !n.meta.homework.done).length;
    return c;
  }, [byFolder, path, isClass, isHomeworkDir]);
  const inClass = useVault((s) => classForFolder(path, s.folderMeta));

  const menu = (): MenuItem[] => [
    { label: 'New note', icon: <FilePlus size={15} />, run: () => newNote(path) },
    ...(inClass ? [{ label: 'New homework', icon: <ClipboardList size={15} />, run: () => newHomework(inClass) }] : []),
    { label: 'New folder inside', icon: <FolderPlus size={15} />, run: () => void newFolder(path) },
    { separator: true },
    ...(isClass
      ? [{ label: 'Class details…', icon: <Settings2 size={15} />, run: () => editClass(path) }]
      : !path.includes('/')
        ? [{ label: 'Make this a class', icon: <GraduationCap size={15} />, run: () => (useVault.getState().setIsClass(path, true), editClass(path)) }]
        : []),
    { label: 'Rename', icon: <Pencil size={15} />, run: () => useUI.getState().set({ renaming: `folder:${path}` }) },
    ...(isClass
      ? []
      : [
          {
            label: 'Colour',
            icon: <Palette size={15} />,
            run: () => {
              const cur = FOLDER_COLORS.indexOf(meta?.color ?? '');
              useVault.getState().setFolderMeta(path, { color: FOLDER_COLORS[(cur + 1) % FOLDER_COLORS.length] });
            },
          },
        ]),
    { separator: true },
    {
      label: isClass ? 'Delete class' : 'Delete folder',
      icon: <Trash2 size={15} />,
      danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: `Delete “${name}”?`,
          message: count ? `Its ${count} note${count === 1 ? '' : 's'} will move to the Trash, where you can restore them.` : 'The folder is empty.',
          confirm: isClass ? 'Delete class' : 'Delete folder',
          danger: true,
        });
        if (ok) void useVault.getState().deleteFolder(path);
      },
    },
  ];

  return (
    <div className="tree-folder">
      <div
        className={cx('tree-row is-folder', isClass && 'is-class', isActive && 'is-active', drop && 'is-drop')}
        style={{ paddingLeft: 8 + depth * 14, ...(cls ? { ['--class' as string]: cls.color } : {}) }}
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
          if (isClass) openClass(path);
          else if (isHomeworkDir) useUI.getState().setView({ kind: 'class', path: inClass! });
          else {
            useUI.getState().setView({ kind: 'folder', path });
            useUI.getState().toggleFolder(path, true);
          }
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
        {cls ? (
          <ClassBadge cls={cls} size={18} />
        ) : (
          <span className={cx('tree-icon', isHomeworkDir && 'is-homework')} style={meta?.color ? { color: meta.color } : undefined}>
            {isHomeworkDir ? <ClipboardList size={15} /> : expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </span>
        )}
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
        {homeworkTodo > 0 ? (
          <span className="tree-due" title={`${homeworkTodo} homework to do`}>
            {homeworkTodo}
          </span>
        ) : (
          <span className="tree-count">{count || ''}</span>
        )}
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
    ...(n.meta.homework
      ? [
          {
            label: n.meta.homework.done ? 'Mark as not done' : 'Mark as done',
            icon: <ClipboardCheck size={15} />,
            run: () => vault.updateMeta(n.meta.id, { homework: { ...n.meta.homework!, done: !n.meta.homework!.done } }),
          },
        ]
      : [
          {
            label: 'Use as homework',
            icon: <ClipboardList size={15} />,
            run: () => {
              // e.g. a worksheet PDF that was imported as a plain note.
              const fm = useVault.getState().folderMeta;
              const c = classForFolder(n.meta.folder, fm);
              vault.updateMeta(n.meta.id, { homework: { sources: [], folders: c ? [c] : [], due: undefined } });
              if (c) vault.moveNote(n.meta.id, `${c}/${HOMEWORK_SUBFOLDER}`);
            },
          },
        ]),
    ...moveToClassItems(n),
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

/** "Move to <class>" entries, so notes made outside any class can be filed in one click. */
function moveToClassItems(n: NoteDoc): MenuItem[] {
  const { folders, folderMeta } = useVault.getState();
  if (classForFolder(n.meta.folder, folderMeta)) return [];
  const targets = listClasses(folders, folderMeta);
  if (!targets.length || targets.length > 6) return [];
  return targets.map((c) => ({
    label: `Move to ${c.name}`,
    icon: <ClassBadge cls={c} size={16} />,
    run: () => useVault.getState().moveNote(n.meta.id, n.meta.homework ? `${c.path}/${HOMEWORK_SUBFOLDER}` : c.path),
  }));
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
      <span className={cx('tree-icon is-note', note.meta.homework && 'is-homework')} style={note.meta.color ? { color: note.meta.color } : undefined}>
        {note.meta.homework ? note.meta.homework.done ? <ClipboardCheck size={14} /> : <ClipboardList size={14} /> : <FileText size={14} />}
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
