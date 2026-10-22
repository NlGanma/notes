import { useMemo, useState } from 'react';
import { BookMarked, ChevronRight, FolderPlus, Layers, ListChecks, Pencil, Plus, ScanText, ScrollText, Sparkles } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAssistant } from '../../state/assistant';
import { classHomework, classInfo, classNotes, HOMEWORK_SUBFOLDER } from '../../lib/classes';
import { editClass, newFolder, newHomework, newNote, openLibrary } from '../../lib/commands';
import { SCAN_TYPES } from '../../lib/import';
import { STUDY_TOOLS, type StudyTool } from '../../lib/ai/prompts';
import { ClassBadge } from './ClassIcon';
import { HomeworkRow, sortHomework } from '../homework/HomeworkView';
import { NoteCard, NoteListRow, coverColor } from '../NoteGrid';
import { cx, plural } from '../../lib/util';

const STUDY: { tool: StudyTool; icon: React.ReactNode; hint: string }[] = [
  { tool: 'flashcards', icon: <Layers size={17} />, hint: 'From every lecture' },
  { tool: 'quiz', icon: <ListChecks size={17} />, hint: '5 questions, with sources' },
  { tool: 'guide', icon: <ScrollText size={17} />, hint: 'Concepts, formulas, practice' },
  { tool: 'terms', icon: <BookMarked size={17} />, hint: 'Everything defined in class' },
];

/** A class's home: its homework, study tools and notes in one place. */
export function ClassView({ path }: { path: string }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const { gridMode, sort } = useUI();
  const [showDone, setShowDone] = useState(false);
  const [dropping, setDropping] = useState(false);
  const cls = classInfo(path, folderMeta[path]);

  const lectureNotes = useMemo(() => {
    const l = classNotes(path, notes).filter((n) => n.meta.folder === path);
    return l.sort((a, b) =>
      sort === 'title'
        ? (a.meta.title || '').localeCompare(b.meta.title || '', undefined, { numeric: true })
        : sort === 'created'
          ? b.meta.created - a.meta.created
          : b.meta.updated - a.meta.updated,
    );
  }, [notes, path, sort]);
  const allNotes = useMemo(() => classNotes(path, notes), [notes, path]);
  const homework = useMemo(() => sortHomework(classHomework(path, notes)), [notes, path]);
  const todo = homework.filter((n) => !n.meta.homework!.done);
  const done = homework.filter((n) => n.meta.homework!.done);
  const subfolders = folders.filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/') && f !== `${path}/${HOMEWORK_SUBFOLDER}`);
  const scope = { kind: 'folder' as const, path };

  const study = (tool: StudyTool) => {
    openLibrary(scope);
    void useAssistant.getState().askLibrary({ prompt: '', scope, scopeLabel: cls.name, tool });
  };

  return (
    <div
      className={cx('collection class-view', dropping && 'is-drop')}
      style={{ ['--class' as string]: cls.color }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={async (e) => {
        setDropping(false);
        const f = [...e.dataTransfer.files].find((x) => SCAN_TYPES.includes(x.name.split('.').pop()?.toLowerCase() ?? ''));
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        newHomework(path, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      }}
    >
      <div className="class-hero">
        <div className="class-hero-main">
          <ClassBadge cls={cls} size={56} />
          <div className="class-hero-text">
            <h1>{cls.name}</h1>
            <div className="class-hero-sub">
              {[cls.code, cls.instructor, cls.term].filter(Boolean).join(' · ') || (
                <button className="link-btn" onClick={() => editClass(path)}>
                  Add course code, teacher and term
                </button>
              )}
            </div>
            <div className="class-hero-stats">
              <span>{plural(allNotes.length, 'note')}</span>
              <span>{todo.length ? `${todo.length} homework to do` : 'No homework due'}</span>
            </div>
          </div>
          <button className="icon-btn class-edit" onClick={() => editClass(path)} title="Edit class">
            <Pencil size={15} />
          </button>
        </div>
        <div className="collection-actions">
          <button className="btn is-ai" onClick={() => openLibrary(scope)} title={`Ask questions answered only from your ${cls.name} notes`}>
            <Sparkles size={15} /> Ask {cls.code || cls.name}
          </button>
          <button className="btn is-secondary" onClick={() => newHomework(path)}>
            <Plus size={15} /> Homework
          </button>
          <button className="btn is-primary" onClick={() => newNote(path)}>
            <Plus size={15} /> New note
          </button>
        </div>
      </div>

      <div className="class-sections">
        <section className="class-section">
          <div className="class-section-head">
            <h2>Homework</h2>
            {done.length > 0 && (
              <button className="link-btn" onClick={() => setShowDone((v) => !v)}>
                {showDone ? 'Hide done' : `Show ${done.length} done`}
              </button>
            )}
            <span className="grow" />
            <button className="btn is-ghost is-small" onClick={() => newHomework(path)} title="Import a scanned worksheet">
              <ScanText size={14} /> Import scan
            </button>
          </div>
          <div className="hw-group-list">
            {[...todo, ...(showDone ? done : [])].map((n) => (
              <HomeworkRow key={n.meta.id} note={n} cls={cls} showClass={false} />
            ))}
            {!todo.length && !showDone && (
              <button className="hw-empty-row" onClick={() => newHomework(path)}>
                <Plus size={15} /> Add homework — start blank or drop a scanned PDF here
              </button>
            )}
          </div>
        </section>

        {allNotes.length > 0 && (
          <section className="class-section">
            <div className="class-section-head">
              <h2>Study</h2>
              <span className="class-section-sub">made only from your {cls.name} notes</span>
            </div>
            <div className="class-study">
              {STUDY.map((s) => (
                <button key={s.tool} className="class-study-tool" onClick={() => study(s.tool)}>
                  <span className="class-study-icon">{s.icon}</span>
                  <span className="class-study-name">{STUDY_TOOLS[s.tool].label}</span>
                  <span className="class-study-hint">{s.hint}</span>
                  <ChevronRight size={14} className="class-study-chev" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="class-section">
          <div className="class-section-head">
            <h2>Notes</h2>
            <span className="class-section-sub">{plural(lectureNotes.length, 'note')}</span>
            <span className="grow" />
            <button className="btn is-ghost is-small" onClick={() => void newFolder(path)}>
              <FolderPlus size={14} /> Folder
            </button>
          </div>
          {subfolders.length > 0 && (
            <div className="notebooks is-compact">
              {subfolders.map((f) => (
                <button
                  key={f}
                  className="notebook"
                  onClick={() => {
                    useUI.getState().setView({ kind: 'folder', path: f });
                    useUI.getState().toggleFolder(f, true);
                  }}
                >
                  <span className="notebook-cover" style={{ ['--cover' as string]: coverColor(f, folderMeta[f]?.color ?? cls.color) }}>
                    <span className="notebook-spine" />
                    <span className="notebook-label">{f.split('/').pop()}</span>
                  </span>
                  <span className="notebook-meta">{plural(classNotes(f, notes).length, 'note')}</span>
                </button>
              ))}
            </div>
          )}
          {lectureNotes.length === 0 && !subfolders.length ? (
            <button className="hw-empty-row" onClick={() => newNote(path)}>
              <Plus size={15} /> Take your first {cls.name} note
            </button>
          ) : gridMode === 'grid' ? (
            <div className="note-grid">
              {lectureNotes.map((n) => (
                <NoteCard key={n.meta.id} note={n} trash={false} />
              ))}
            </div>
          ) : (
            <div className="note-list">
              {lectureNotes.map((n) => (
                <NoteListRow key={n.meta.id} note={n} trash={false} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
