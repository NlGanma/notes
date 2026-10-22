import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  FolderClosed,
  FolderPlus,
  GraduationCap,
  Home,
  LibraryBig,
  ListTodo,
  Plus,
  Settings,
  Star,
  Tag,
  Tags,
  Target,
  Trash2,
} from 'lucide-react';
import { useVault } from '../state/vault';
import { useUI, type View } from '../state/ui';
import { FileTree, folderMenu } from './FileTree';
import { newClass, newFolder, openClass, openReview } from '../lib/commands';
import { dueCount, useReview } from '../state/review';
import { classForFolder, listClasses, themeVars, type ClassInfo } from '../lib/classes';
import { openContextMenu } from './common/ContextMenu';
import { cx } from '../lib/util';
import { MOD, SHIFT } from '../lib/platform';

/** A navigation-drawer item (Google Classroom): a 48px row whose selection is a full pill. */
function NavItem({
  icon,
  label,
  view,
  count,
  hint,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  view: View;
  count?: number;
  hint?: string;
  title?: string;
  onClick?(): void;
}) {
  const active = useUI(
    (s) =>
      s.view.kind === view.kind &&
      (view.kind === 'homework' || view.kind === 'review' || view.kind === 'library' || JSON.stringify(s.view) === JSON.stringify(view)),
  );
  return (
    <button
      className={cx('nav-item', active && 'is-active')}
      onClick={() => (onClick ? onClick() : useUI.getState().setView(view))}
      title={title ?? (hint ? `${label}  ${hint}` : label)}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {!!count && <span className="nav-count">{count}</span>}
    </button>
  );
}

/** A class in the drawer: its letter on the class's light tone, the name, and its course code · term. */
function ClassRow({ cls }: { cls: ClassInfo }) {
  const active = useUI((s) => (s.view.kind === 'class' || s.view.kind === 'folder') && s.view.path === cls.path);
  const section = [cls.code, cls.term].filter(Boolean).join(' · ');
  return (
    <button
      className={cx('nav-item nav-class tree-row is-class', active && 'is-active')}
      style={themeVars(cls.theme) as React.CSSProperties}
      onClick={() => openClass(cls.path)}
      onContextMenu={(e) => openContextMenu(e, folderMenu(cls.path))}
      title={cls.name}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">
        <span className="class-letter" aria-hidden>
          {cls.name.trim().charAt(0).toUpperCase()}
        </span>
      </span>
      <span className="nav-label is-two-line">
        <span className="nav-class-name">{cls.name}</span>
        {section && <span className="nav-class-sub">{section}</span>}
      </span>
    </button>
  );
}

/** A collapsible group header (Classroom's "Enrolled ⌃"): its icon and label sit in the items' columns. */
function Section({
  id,
  icon,
  label,
  onLabel,
  children,
  action,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  onLabel?(): void;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const open = useUI((s) => s.expanded[`section:${id}`] !== false);
  const toggle = () => useUI.getState().set({ expanded: { ...useUI.getState().expanded, [`section:${id}`]: !open } });
  return (
    <div className={cx('side-section', !open && 'is-collapsed')}>
      <div className="side-section-head">
        <button className="side-section-label" onClick={onLabel ?? toggle}>
          <span className="nav-icon">{icon}</span>
          {label}
        </button>
        {action}
        <button className="side-section-chev" onClick={toggle} aria-label={open ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={open}>
          <ChevronDown size={18} className={cx('chev', open && 'is-open')} />
        </button>
      </div>
      {open && <div className="side-section-body">{children}</div>}
    </div>
  );
}

export function Sidebar() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const rail = useUI((s) => !s.sidebar);
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

  const { trashed, tags, homework } = useMemo(() => {
    const all = Object.values(notes);
    const liveN = all.filter((n) => !n.meta.trashed);
    const tagSet = new Set<string>();
    for (const n of liveN) for (const t of n.meta.tags) tagSet.add(t);
    return {
      trashed: all.length - liveN.length,
      tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
      homework: liveN.filter((n) => n.meta.homework && !n.meta.homework.done).length,
    };
  }, [notes]);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  const archived = useMemo(() => listClasses(folders, folderMeta, { archived: true }).filter((c) => c.archived).length, [folders, folderMeta]);
  const otherFolders = useMemo(() => folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta)), [folders, folderMeta]);

  return (
    <aside className={cx('sidebar', rail && 'is-rail')} aria-label="Navigation">
      <div className="sidebar-scroll">
        <nav className="nav">
          <NavItem icon={<Home size={20} />} label="Home" view={{ kind: 'classes' }} />
          <NavItem
            icon={<LibraryBig size={20} />}
            label="Ask your notes"
            view={{ kind: 'library' }}
            hint={`${SHIFT}${MOD}L`}
            onClick={() => useUI.getState().set({ view: { kind: 'library' }, libraryScope: { kind: 'all' } })}
          />
          <NavItem
            icon={<Target size={20} />}
            label="Review"
            view={{ kind: 'review' }}
            count={reviewDue || undefined}
            hint={`${SHIFT}${MOD}E`}
            title={reviewDue ? `Review · ${reviewDue} due` : undefined}
            onClick={() => openReview()}
          />
        </nav>

        <Section id="classes" icon={<GraduationCap size={20} />} label="Classes" onLabel={() => useUI.getState().setView({ kind: 'classes' })}>
          <NavItem icon={<ListTodo size={20} />} label="Homework" view={{ kind: 'homework' }} count={homework || undefined} />
          {classes.map((c) => (
            <ClassRow key={c.path} cls={c} />
          ))}
          {!classes.length && (
            <button className="nav-item" onClick={newClass}>
              <span className="nav-icon">
                <Plus size={20} />
              </span>
              <span className="nav-label">Create class</span>
            </button>
          )}
        </Section>

        <Section
          id="notes"
          icon={<FolderClosed size={20} />}
          label="Notes"
          action={
            <button className="side-section-chev" onClick={() => void newFolder('')} aria-label="New folder" title="New folder">
              <FolderPlus size={18} />
            </button>
          }
        >
          <NavItem icon={<FileText size={20} />} label="All notes" view={{ kind: 'home' }} />
          <NavItem icon={<Star size={20} />} label="Favorites" view={{ kind: 'favorites' }} />
          <NavItem icon={<Clock size={20} />} label="Recent" view={{ kind: 'recent' }} />
          {otherFolders.length > 0 && <FileTree roots={otherFolders} />}
        </Section>

        {tags.length > 0 && (
          <Section id="tags" icon={<Tags size={20} />} label="Labels">
            <TagList tags={tags} />
          </Section>
        )}

        <nav className="nav is-end">
          {archived > 0 && <NavItem icon={<Archive size={20} />} label="Archived classes" view={{ kind: 'classes', archived: true }} />}
          <NavItem icon={<Trash2 size={20} />} label="Trash" view={{ kind: 'trash' }} count={trashed || undefined} />
          <button className="nav-item" onClick={() => useUI.getState().openSettings('writing')} title={`Settings  ${MOD},`}>
            <span className="nav-icon">
              <Settings size={20} />
            </span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}

/** Gmail's label list: the first few, then "More" for the rest (and whichever one is open). */
const TAGS_SHOWN = 5;
function TagList({ tags }: { tags: string[] }) {
  const all = useUI((s) => !!s.expanded['section:tags-all']);
  const current = useUI((s) => (s.view.kind === 'tag' ? s.view.tag : null));
  const shown = all ? tags : tags.filter((t, i) => i < TAGS_SHOWN || t === current);
  const toggle = () => useUI.getState().set({ expanded: { ...useUI.getState().expanded, 'section:tags-all': !all } });
  return (
    <>
      {shown.map((t) => (
        <TagRow key={t} tag={t} />
      ))}
      {tags.length > TAGS_SHOWN && (
        <button className="nav-item is-dense" onClick={toggle} aria-expanded={all}>
          <span className="nav-icon">{all ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
          <span className="nav-label">{all ? 'Less' : 'More'}</span>
        </button>
      )}
    </>
  );
}

/** A label (tag), Gmail-style: an outlined tag glyph and the name. */
function TagRow({ tag }: { tag: string }) {
  const active = useUI((s) => s.view.kind === 'tag' && s.view.tag === tag);
  return (
    <button className={cx('nav-item is-dense tag-pill', active && 'is-active')} onClick={() => useUI.getState().setView({ kind: 'tag', tag })} title={`#${tag}`}>
      <span className="nav-icon">
        <Tag size={18} />
      </span>
      <span className="nav-label">{tag}</span>
    </button>
  );
}
