import { useMemo, useState } from 'react';
import {
  ChevronRight,
  ClipboardList,
  Clock,
  FolderPlus,
  Hash,
  Home,
  LibraryBig,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Star,
  Trash2,
} from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI, type View } from '../state/ui';
import { useAI } from '../state/ai';
import { FileTree } from './FileTree';
import { newClass, newFolder, newNote } from '../lib/commands';
import { classForFolder, listClasses } from '../lib/classes';
import { cx } from '../lib/util';
import { MOD, SHIFT } from '../lib/platform';

function NavItem({
  icon,
  label,
  view,
  count,
  hint,
  accent,
  alert,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  view: View;
  count?: number;
  hint?: string;
  accent?: boolean;
  /** Shows the count as a badge (e.g. homework due). */
  alert?: boolean;
  onClick?(): void;
}) {
  const active = useUI((s) => s.view.kind === view.kind && (view.kind === 'homework' || JSON.stringify(s.view) === JSON.stringify(view)));
  return (
    <button className={cx('nav-item', active && 'is-active', accent && 'is-accent')} onClick={() => (onClick ? onClick() : useUI.getState().setView(view))}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {hint && <kbd className="nav-hint">{hint}</kbd>}
      {!!count && <span className={cx('nav-count', alert && 'is-alert')}>{count}</span>}
    </button>
  );
}

export function Sidebar() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const backend = useVault((s) => s.backend);
  const ai = useAI();
  const [tagsOpen, setTagsOpen] = useState(true);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [classesOpen, setClassesOpen] = useState(true);

  const { live, trashed, pinned, tags, homework, overdue } = useMemo(() => {
    const all = Object.values(notes);
    const liveN = all.filter((n) => !n.meta.trashed);
    const tagCounts = new Map<string, number>();
    for (const n of liveN) for (const t of n.meta.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    const hw = liveN.filter((n) => n.meta.homework && !n.meta.homework.done);
    const soon = Date.now() + 86_400_000 * 2;
    return {
      live: liveN.filter((n) => !n.meta.homework).length,
      trashed: all.length - liveN.length,
      pinned: liveN.filter((n) => n.meta.pinned).length,
      tags: [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      homework: hw.length,
      overdue: hw.some((n) => n.meta.homework!.due && n.meta.homework!.due < soon),
    };
  }, [notes]);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  const otherFolders = useMemo(() => folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta)), [folders, folderMeta]);

  const vaultName = backend?.kind === 'fs' ? backend.label.split(/[\\/]/).filter(Boolean).pop() : 'Notebook';
  const statusLabel =
    ai.status === 'online'
      ? ai.chatModel || 'Choose a model'
      : ai.status === 'checking'
        ? 'Connecting…'
        : ai.status === 'offline'
          ? 'Local AI offline'
          : 'Set up local AI';

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="grow" />
        <button className="icon-btn no-drag" onClick={() => useUI.getState().toggleSidebar()} aria-label="Hide sidebar" title={`Hide sidebar  ${MOD}\\`}>
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="22" height="22">
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#1c1c1e" />
            <path
              d="M11 22.5c2.4-5.6 4.2-9.6 5.2-12.2.4-1 1.7-1 2 .1l.3 1.2c.3 1.2 1.1 2.4 2.3 3.1"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <circle cx="22.5" cy="9.5" r="1.8" fill="#8cc6ff" />
          </svg>
        </span>
        <div className="brand-text">
          <div className="brand-name">Nib</div>
          <div className="brand-vault" title={backend?.label}>
            {vaultName}
          </div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="search-btn" onClick={() => useUI.getState().setPalette(true)}>
          <Search size={14} />
          <span>Search</span>
          <kbd>{MOD}K</kbd>
        </button>
        <button className="icon-btn is-solid" onClick={() => newNote()} aria-label="New note" title={`New note  ${MOD}N`}>
          <SquarePen size={16} />
        </button>
      </div>

      <div className="sidebar-scroll">
        <nav className="nav">
          <NavItem icon={<Home size={16} />} label="All notes" view={{ kind: 'home' }} count={live} />
          <NavItem icon={<ClipboardList size={16} />} label="Homework" view={{ kind: 'homework' }} count={homework} alert={overdue} />
          <NavItem
            icon={<LibraryBig size={16} />}
            label="Ask your notes"
            view={{ kind: 'library' }}
            hint={`${SHIFT}${MOD}L`}
            accent
            onClick={() => useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'all' } })}
          />
          <NavItem icon={<Star size={16} />} label="Favorites" view={{ kind: 'favorites' }} count={pinned} />
          <NavItem icon={<Clock size={16} />} label="Recent" view={{ kind: 'recent' }} />
        </nav>

        <div className="side-section">
          <div className="side-section-head">
            <button className="side-section-toggle" onClick={() => setClassesOpen((v) => !v)}>
              <ChevronRight size={12} className={cx('chev', classesOpen && 'is-open')} />
              Classes
            </button>
            <button className="icon-btn is-tiny" onClick={newClass} aria-label="New class" title="New class">
              <Plus size={14} />
            </button>
          </div>
          {classesOpen &&
            (classes.length ? (
              <FileTree roots={classes.map((c) => c.path)} rootNotes={false} />
            ) : (
              <button className="side-empty" onClick={newClass}>
                <Plus size={13} /> Add your first class
              </button>
            ))}
        </div>

        <div className="side-section">
          <div className="side-section-head">
            <button className="side-section-toggle" onClick={() => setFoldersOpen((v) => !v)}>
              <ChevronRight size={12} className={cx('chev', foldersOpen && 'is-open')} />
              {classes.length ? 'Other notes' : 'Folders'}
            </button>
            <button className="icon-btn is-tiny" onClick={() => void newFolder('')} aria-label="New folder" title="New folder">
              <FolderPlus size={14} />
            </button>
          </div>
          {foldersOpen && <FileTree roots={otherFolders} />}
        </div>

        {tags.length > 0 && (
          <div className="side-section">
            <div className="side-section-head">
              <button className="side-section-toggle" onClick={() => setTagsOpen((v) => !v)}>
                <ChevronRight size={12} className={cx('chev', tagsOpen && 'is-open')} />
                Tags
              </button>
            </div>
            {tagsOpen && (
              <div className="tag-cloud">
                {tags.map(([t, c]) => (
                  <TagPill key={t} tag={t} count={c} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <NavItem icon={<Trash2 size={16} />} label="Trash" view={{ kind: 'trash' }} count={trashed} />
        <div className="sidebar-footer">
          <button className={cx('ai-status', `is-${ai.status}`)} onClick={() => useUI.getState().openSettings('ai')} title={ai.lastError ?? statusLabel}>
            <span className="ai-dot" />
            <span className="ai-status-text">{statusLabel}</span>
          </button>
          <button className="icon-btn" onClick={() => useUI.getState().openSettings('writing')} aria-label="Settings" title={`Settings  ${MOD},`}>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function TagPill({ tag, count }: { tag: string; count: number }) {
  const active = useUI((s) => s.view.kind === 'tag' && s.view.tag === tag);
  return (
    <button className={cx('tag-pill', active && 'is-active')} onClick={() => useUI.getState().setView({ kind: 'tag', tag })}>
      <Hash size={11} />
      {tag}
      <span className="tag-pill-count">{count}</span>
    </button>
  );
}
