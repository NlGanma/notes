import { useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ClipboardList, FolderInput, GraduationCap, LibraryBig, Maximize2, Minimize2, MoreVertical, Plus, Target } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import type { NoteDoc } from '../../lib/vault/types';
import { classForFolder, classHomework, classInfo, listClasses, themeVars, type ClassInfo } from '../../lib/classes';
import { dueDay, isMissing } from '../../lib/homework';
import { newClass, openClass, openLibrary, reviewFolder } from '../../lib/commands';
import { folderMenu } from '../FileTree';
import { openContextMenu, type MenuItem } from '../common/ContextMenu';
import { Popover } from '../common/Popover';
import { pickFolder } from '../common/dialogs';
import { ClassGlyph } from './ClassIcon';
import { cx } from '../../lib/util';
import { toast } from '../common/toast';

/** Decorative art for a class banner or card header: a big circle arcing in from the right with the class icon on it. */
export function ClassArt({ icon, h, compact }: { icon: ClassInfo['icon']; h: number; compact?: boolean }) {
  const d = h * 1.6;
  // On a card the teacher avatar covers the header's bottom-right, so the glyph is smaller and sits higher.
  const s = Math.round(h * (compact ? 0.4 : 0.55));
  return (
    <span className="class-art" aria-hidden>
      <span className="class-art-circle" style={{ width: d, height: d, right: -(d / 2 - h * 0.18), top: h * 0.85 - d / 2 }} />
      <span className="class-art-icon" style={compact ? { right: h * 0.24, top: h * 0.14 } : { right: h * 0.32 - s / 2, top: h * 0.5 - s / 2 }}>
        <ClassGlyph icon={icon} size={s} />
      </span>
      <span className="class-art-dot" style={{ right: h * 0.95, top: h * 0.22 }} />
      <span className="class-art-dot is-small" style={{ right: h * 0.12, top: h * 0.12 }} />
    </span>
  );
}

/** "Prof. Alvarez" → "A" (the teacher avatar on a class card). */
export function teacherInitial(name?: string): string {
  if (!name) return '';
  const rest = name.replace(/^(prof|professor|dr|mr|mrs|ms|mx|sr|sra|srta|mme|m|herr|frau)\.?\s+/i, '').trim();
  return (rest || name).charAt(0).toUpperCase();
}

/** Due text in Classroom's words: "Due today", "Due Saturday", "Due Oct 28"; past due is "Missing". */
export function dueText(n: NoteDoc): string {
  const hw = n.meta.homework!;
  if (isMissing(hw)) return 'Missing';
  if (!hw.due) return 'No due date';
  const day = dueDay(hw.due);
  return `Due ${day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : day}`;
}

/** Archive or restore, with Classroom's snackbar and an Undo. */
function setArchived(cls: ClassInfo, archived: boolean) {
  const vault = useVault.getState();
  const meta = vault.folderMeta[cls.path] ?? {};
  vault.setFolderMeta(cls.path, { ...meta, archived });
  toast.info(archived ? `${cls.name} archived` : `${cls.name} restored`, undefined, {
    label: 'Undo',
    run: () => useVault.getState().setFolderMeta(cls.path, { ...(useVault.getState().folderMeta[cls.path] ?? {}), archived: !archived }),
  });
}

function cardMenu(cls: ClassInfo): MenuItem[] {
  if (cls.archived)
    return [
      { label: 'Restore', icon: <ArchiveRestore size={20} />, run: () => setArchived(cls, false) },
      { separator: true },
      ...folderMenu(cls.path).filter((m) => /^Delete/.test(m.label ?? '')),
    ];
  return [...folderMenu(cls.path), { separator: true }, { label: 'Archive', icon: <Archive size={20} />, run: () => setArchived(cls, true) }];
}

/** A class card (Google Classroom): themed header with the name, section and teacher; upcoming work; footer actions. */
export function ClassCard({ cls, due }: { cls: ClassInfo; due: NoteDoc[] }) {
  const section = [cls.code, cls.term].filter(Boolean).join(' · ');
  const initial = teacherInitial(cls.instructor);
  const open = () => openClass(cls.path);
  return (
    <div
      className={cx('class-card', cls.archived && 'is-archived')}
      style={themeVars(cls.theme) as React.CSSProperties}
      onContextMenu={(e) => openContextMenu(e, cardMenu(cls))}
      data-class={cls.name}
    >
      <div className="class-card-head" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <ClassArt icon={cls.icon} h={100} compact />
        <div className="class-card-name">{cls.name}</div>
        {section && <div className="class-card-section">{section}</div>}
        {cls.instructor && <div className="class-card-teacher">{cls.instructor}</div>}
      </div>
      {initial && (
        <div className="class-card-avatar" aria-hidden>
          {initial}
        </div>
      )}
      <div className={cx('class-card-body', initial && 'has-avatar')}>
        {due.slice(0, 2).map((n) => (
          <button key={n.meta.id} className="class-card-due" onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}>
            <span className={cx('class-card-due-when', isMissing(n.meta.homework) && 'is-missing')}>{dueText(n)}</span>
            <span className="class-card-due-title">{n.meta.title || 'Untitled homework'}</span>
          </button>
        ))}
      </div>
      <div className="class-card-foot">
        {!cls.archived && (
          <>
            <button className="icon-btn" onClick={() => openLibrary({ kind: 'folder', path: cls.path })} aria-label={`Ask your ${cls.name} notes`} title={`Ask your ${cls.name} notes`}>
              <LibraryBig size={20} />
            </button>
            <button className="icon-btn" onClick={() => reviewFolder(cls.path)} aria-label={`Review ${cls.name}`} title={`Review ${cls.name}`}>
              <Target size={20} />
            </button>
          </>
        )}
        <button className="icon-btn" onClick={(e) => openContextMenu(e, cardMenu(cls))} aria-label="Options" title="Options">
          <MoreVertical size={20} />
        </button>
      </div>
    </div>
  );
}

/** Home: the "Due soon" module and every class as a card, as Google Classroom's home does it. */
export function ClassesView({ archived = false }: { archived?: boolean }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const [dueOpen, setDueOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);

  const classes = useMemo(
    () => listClasses(folders, folderMeta, { archived }).filter((c) => c.archived === archived),
    [folders, folderMeta, archived],
  );
  const dueOf = (cls: ClassInfo) =>
    classHomework(cls.path, notes)
      .filter((n) => !n.meta.homework!.done && n.meta.homework!.due)
      .sort((a, b) => a.meta.homework!.due! - b.meta.homework!.due!);
  const dueSoon = useMemo(() => {
    const week = Date.now() + 7 * 86_400_000;
    return Object.values(notes)
      .filter((n) => !n.meta.trashed && n.meta.homework && !n.meta.homework.done && n.meta.homework.due && n.meta.homework.due < week)
      .sort((a, b) => a.meta.homework!.due! - b.meta.homework!.due!);
  }, [notes]);
  const looseFolders = folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta));

  const useFolder = async () => {
    setAddOpen(false);
    const path = await pickFolder('Use a folder as a class', '', { only: looseFolders, action: 'Use as class' });
    if (path) {
      useVault.getState().setIsClass(path, true);
      useUI.getState().openDialog({ kind: 'class', path });
    }
  };

  return (
    <div className="classes-view">
      <div className="classes-scroll">
        {!archived && (
          <section className={cx('module due-module', dueOpen && 'is-open')}>
            <div className="module-head">
              <h2 className="module-title">Due soon</h2>
              <span className="grow" />
              <button className="icon-btn" onClick={() => setDueOpen((v) => !v)} aria-label={dueOpen ? 'Collapse' : 'Expand'} aria-expanded={dueOpen}>
                {dueOpen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            </div>
            {dueOpen && (
              <div className="due-list">
                {dueSoon.slice(0, 5).map((n) => {
                  const p = classForFolder(n.meta.folder, folderMeta);
                  const cls = p ? classInfo(p, folderMeta[p]) : null;
                  return (
                    <button
                      key={n.meta.id}
                      className="due-row"
                      style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}
                      onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}
                    >
                      <span className="item-circle">
                        <ClipboardList size={20} />
                      </span>
                      <span className="due-row-text">
                        <span className="due-row-title">{n.meta.title || 'Untitled homework'}</span>
                        <span className="due-row-class">{cls?.name ?? 'No class'}</span>
                      </span>
                      <span className={cx('due-row-when', isMissing(n.meta.homework) && 'is-missing')}>{dueText(n)}</span>
                    </button>
                  );
                })}
                {!dueSoon.length && <div className="due-empty">No work due soon</div>}
                <div className="due-foot">
                  <button className="btn is-ghost" onClick={() => useUI.getState().setView({ kind: 'homework' })}>
                    View all
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="module classes-module">
          <div className="module-head">
            <h2 className="module-title">{archived ? 'Archived classes' : 'Classes'}</h2>
            <span className="grow" />
            {!archived && (
              <button ref={addBtn} className="btn is-ghost" onClick={() => setAddOpen((v) => !v)}>
                <Plus size={18} /> Add class
              </button>
            )}
          </div>
          {classes.length > 0 ? (
            <div className="class-grid">
              {classes.map((c) => (
                <ClassCard key={c.path} cls={c} due={dueOf(c)} />
              ))}
            </div>
          ) : (
            <div className="module-empty">
              <div className="module-empty-title">{archived ? 'No archived classes' : 'Add a class to get started'}</div>
              {!archived && (
                <div className="module-empty-actions">
                  <button className="btn is-ghost" onClick={newClass}>
                    Create class
                  </button>
                  {looseFolders.length > 0 && (
                    <button className="btn is-ghost" onClick={() => void useFolder()}>
                      Use a folder as a class
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <Popover anchor={addBtn.current} open={addOpen} onClose={() => setAddOpen(false)} align="end" className="menu-pop">
        <div className="menu">
          <button className="menu-item" disabled={!looseFolders.length} onClick={() => void useFolder()} title={looseFolders.length ? undefined : 'Every folder is already a class'}>
            <FolderInput size={20} />
            <span className="menu-label">Use a folder as a class</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setAddOpen(false);
              newClass();
            }}
          >
            <GraduationCap size={20} />
            <span className="menu-label">Create class</span>
          </button>
        </div>
      </Popover>
    </div>
  );
}
