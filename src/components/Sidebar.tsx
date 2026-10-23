import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, LayoutGrid, ListChecks, MessagesSquare, MoreHorizontal, PanelLeft, Plus, Repeat, Search, Settings } from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import { useAI } from '../state/ai';
import { folderMenu } from './FileTree';
import { NewNotePopover } from './NewNoteMenu';
import { openClass, openReview } from '../lib/commands';
import { dueCount, useReview } from '../state/review';
import { classForFolder, listClasses, themeVars, type ClassInfo } from '../lib/classes';
import { openContextMenu } from './common/ContextMenu';
import { cx } from '../lib/util';
import { MOD } from '../lib/platform';

const DAY = 86_400_000;

/**
 * Which sidebar row stands for the page on screen: 'classes', 'homework', 'review', 'library', 'notes'
 * (All notes, Trash, plain folders and the notes in them) or 'cls:<path>' for anything inside a class.
 */
function usePlace(): string | null {
  return useUI((s) => {
    const v = s.view;
    const { notes, folderMeta } = useVault.getState();
    switch (v.kind) {
      case 'classes':
        return 'classes';
      case 'homework':
        return 'homework';
      case 'review':
        return 'review';
      case 'library':
        return 'library';
      case 'home':
      case 'trash':
        return 'notes';
      case 'class':
      case 'folder': {
        const c = classForFolder(v.path, folderMeta);
        return c ? `cls:${c}` : 'notes';
      }
      case 'note': {
        const n = notes[v.id];
        const c = n ? classForFolder(n.meta.folder, folderMeta) : null;
        return c ? `cls:${c}` : 'notes';
      }
    }
    return null;
  });
}

const isHere = (place: string | null, row: string) => place === row;

function NavItem({
  icon,
  label,
  here,
  count,
  overdue,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  here: boolean;
  count?: number;
  overdue?: boolean;
  title?: string;
  onClick(): void;
}) {
  return (
    <button className={cx('nav-item', here && 'is-active')} onClick={onClick} title={title} aria-current={here ? 'page' : undefined}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {!!count && <span className={cx('nav-count badge-count', overdue && 'is-overdue')}>{count}</span>}
    </button>
  );
}

/** A class under "Classes": its colour, its name, and on hover the class menu. */
function ClassRow({ cls, here }: { cls: ClassInfo; here: boolean }) {
  return (
    <div
      className={cx('nav-item nav-class tree-row is-class', here && 'is-active')}
      style={themeVars(cls.theme) as React.CSSProperties}
      role="button"
      tabIndex={0}
      onClick={() => openClass(cls.path)}
      onKeyDown={(e) => e.key === 'Enter' && openClass(cls.path)}
      onContextMenu={(e) => openContextMenu(e, folderMenu(cls.path))}
      title={cls.name}
      aria-current={here ? 'page' : undefined}
    >
      <span className="nav-class-dot" aria-hidden />
      <span className="nav-label">{cls.name}</span>
      <button
        className="nav-more"
        aria-label={`${cls.name} menu`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => undefined }, folderMenu(cls.path));
        }}
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/**
 * The sidebar, as in Claude: New note and Search pinned at the top, the places in the middle (classes
 * last, since their number grows), Settings pinned at the bottom.
 */
export function Sidebar({ overlay }: { overlay?: boolean }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const shown = useUI((s) => s.sidebar);
  const classesOpen = useUI((s) => s.expanded['section:classes'] !== false);
  const place = usePlace();
  const ai = useAI((s) => s.status);
  const chatModel = useAI((s) => s.chatModel);
  const newBtn = useRef<HTMLButtonElement>(null);
  const [newOpen, setNewOpen] = useState(false);

  // Hidden, it is out of the tab order and out of reach of screen readers too.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (asideRef.current) asideRef.current.inert = !shown;
  }, [shown]);

  // Ideas due for review: counted again when the review file or the notes change (a moment after typing
  // stops — it reads every note), and every minute, as reviews fall due.
  const reviewFile = useReview((s) => s.file);
  const [reviewDue, setReviewDue] = useState(0);
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setReviewDue(dueCount()), 300);
    return () => clearTimeout(t);
  }, [reviewFile, notes, minute]);

  // Homework that needs doing soon: overdue, or due within a week.
  const homework = useMemo(() => {
    const now = Date.now();
    let count = 0;
    let overdue = false;
    for (const n of Object.values(notes)) {
      const hw = n.meta.homework;
      if (n.meta.trashed || !hw || hw.done || !hw.due) continue;
      if (hw.due < now) overdue = true;
      if (hw.due < now + 7 * DAY) count++;
    }
    return { count, overdue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, minute]);

  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  const toggleClasses = () => useUI.getState().set({ expanded: { ...useUI.getState().expanded, 'section:classes': !classesOpen } });
  const classHere = place?.startsWith('cls:') ? place.slice(4) : null;

  const aiState = ai === 'online' ? 'online' : ai === 'offline' ? 'offline' : 'loading';
  const settingsTitle =
    aiState === 'online' ? `Settings  ${MOD},  ·  ${chatModel || 'no model chosen'}` : aiState === 'offline' ? 'Local AI isn’t running' : 'Starting the local model…';

  return (
    <aside ref={asideRef} className={cx('sidebar', !shown && 'is-hidden', overlay && 'is-overlay')} aria-label="Navigation">
      <div className="sidebar-head drag">
        <span className="grow" />
        <button className="icon-btn no-drag" onClick={() => useUI.getState().toggleSidebar()} aria-label="Hide sidebar" title={`Hide sidebar  ${MOD}\\`}>
          <PanelLeft size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className="sidebar-top">
        <button ref={newBtn} className={cx('nav-item side-new', newOpen && 'is-open')} onClick={() => setNewOpen(!newOpen)} aria-haspopup="menu" aria-expanded={newOpen}>
          <span className="side-new-circle" aria-hidden>
            <Plus size={14} strokeWidth={2} />
          </span>
          <span className="nav-label">New note</span>
        </button>
        <button className="side-search" onClick={() => useUI.getState().setPalette(true)}>
          <Search size={16} strokeWidth={1.5} />
          <span className="grow">Search</span>
          <kbd>{MOD}K</kbd>
        </button>
      </div>

      <div className="sidebar-scroll">
        <nav className="nav">
          <NavItem
            icon={<ListChecks size={18} strokeWidth={1.5} />}
            label="Homework"
            here={isHere(place, 'homework')}
            count={homework.count || undefined}
            overdue={homework.overdue}
            onClick={() => useUI.getState().setView({ kind: 'homework' })}
          />
          <NavItem
            icon={<Repeat size={18} strokeWidth={1.5} />}
            label="Review"
            here={isHere(place, 'review')}
            count={reviewDue || undefined}
            title={reviewDue ? `${reviewDue} due` : undefined}
            onClick={() => openReview()}
          />
          <NavItem
            icon={<MessagesSquare size={18} strokeWidth={1.5} />}
            label="Ask your notes"
            here={isHere(place, 'library')}
            onClick={() => useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'all' } })}
          />
          <NavItem icon={<FileText size={18} strokeWidth={1.5} />} label="All notes" here={isHere(place, 'notes')} onClick={() => useUI.getState().setView({ kind: 'home' })} />

          <div className={cx('nav-item nav-classes', (place === 'classes' || (classHere && !classesOpen)) && 'is-active')}>
            <button className="nav-classes-label" onClick={() => useUI.getState().setView({ kind: 'classes' })} aria-current={place === 'classes' ? 'page' : undefined}>
              <span className="nav-icon">
                <LayoutGrid size={18} strokeWidth={1.5} />
              </span>
              <span className="nav-label">Classes</span>
            </button>
            {classes.length > 0 && (
              <button className="nav-chev" onClick={toggleClasses} aria-label={classesOpen ? 'Hide classes' : 'Show classes'} aria-expanded={classesOpen}>
                <ChevronRight size={14} strokeWidth={1.5} className={cx('chev', classesOpen && 'is-open')} />
              </button>
            )}
          </div>
          {classesOpen && classes.map((c) => <ClassRow key={c.path} cls={c} here={classHere === c.path} />)}
        </nav>
      </div>

      <div className="sidebar-foot">
        <button
          className="nav-item side-settings"
          data-ai-status={aiState}
          onClick={() => useUI.getState().openSettings(aiState === 'online' ? undefined : 'ai')}
          title={settingsTitle}
        >
          <span className="nav-icon">
            <Settings size={18} strokeWidth={1.5} />
            {aiState !== 'online' && <span className={cx('side-ai-dot', `is-${aiState}`)} aria-hidden />}
          </span>
          <span className="nav-label">Settings</span>
          <kbd className="side-kbd">{MOD},</kbd>
        </button>
      </div>

      <NewNotePopover anchor={newBtn.current} open={newOpen} onClose={() => setNewOpen(false)} />
    </aside>
  );
}
