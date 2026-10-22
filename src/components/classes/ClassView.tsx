import { useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ClipboardList,
  FileText,
  FolderOpen,
  FolderPlus,
  Info,
  LibraryBig,
  MoreVertical,
  Pencil,
  Plus,
  ScanText,
  Settings,
} from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI, type ClassTab } from '../../state/ui';
import { useAssistant } from '../../state/assistant';
import type { NoteDoc } from '../../lib/vault/types';
import { classHomework, classInfo, HOMEWORK_SUBFOLDER, inFolder, themeVars } from '../../lib/classes';
import { dueDay, isMissing } from '../../lib/homework';
import { editClass, newFolder, newHomework, newNote, openLibrary, reviewFolder } from '../../lib/commands';
import { SCAN_TYPES } from '../../lib/import';
import type { StudyTool } from '../../lib/ai/prompts';
import { folderMenu, noteMenu, noteTitle } from '../FileTree';
import { ToolIcon, toolStyle } from '../library/StudioPanel';
import { TOOL_LOOK } from '../library/notebook';
import { openContextMenu } from '../common/ContextMenu';
import { Popover } from '../common/Popover';
import { Tabs } from '../common/Tabs';
import { ClassArt, dueText } from './ClassesView';
import { isElectron } from '../../lib/platform';
import { cx } from '../../lib/util';

const when = (t: number) => {
  const d = new Date(t);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** A Classwork item row: the class-colour circle with the item's glyph, its title, and plain grey details. */
function ItemRow({ note, onOpen }: { note: NoteDoc; onOpen(): void }) {
  const hw = note.meta.homework;
  const scanned = hw && (note.content.content ?? []).some((b) => b.type === 'image');
  const meta = hw
    ? hw.done
      ? 'Done'
      : isMissing(hw)
        ? 'Missing'
        : hw.due
          ? `Due ${dueDay(hw.due, Date.now(), 'short')}`
          : 'No due date'
    : `Edited ${when(note.meta.updated)}`;
  return (
    <div
      className={cx('cw-row', hw?.done && 'is-done')}
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => openContextMenu(e, noteMenu(note))}
    >
      <span className="item-circle">{hw ? scanned ? <ScanText size={20} /> : <ClipboardList size={20} /> : <FileText size={20} />}</span>
      <span className="cw-row-title">{noteTitle(note)}</span>
      <span className={cx('cw-row-meta', hw && !hw.done && isMissing(hw) && 'is-missing', hw?.done && 'is-done')}>{meta}</span>
      <button
        className="icon-btn cw-row-more"
        onClick={(e) => {
          e.stopPropagation();
          openContextMenu(e, noteMenu(note));
        }}
        aria-label="More"
      >
        <MoreVertical size={20} />
      </button>
    </div>
  );
}

// The class's study tools, in NotebookLM's Studio order, each with one line on what it makes.
const STUDY: { tool: StudyTool | 'review'; hint: string }[] = [
  { tool: 'guide', hint: 'Concepts, formulas and practice' },
  { tool: 'summary', hint: 'What the notes cover, in bullets' },
  { tool: 'terms', hint: 'Everything defined in class' },
  { tool: 'flashcards', hint: 'Flip cards from every note' },
  { tool: 'quiz', hint: 'Questions with sources' },
  { tool: 'review', hint: 'Practise until you know it' },
];

/** A class's page, as Google Classroom shows a class: Stream, Classwork and Study tabs under a breadcrumb. */
export function ClassView({ path, tab = 'stream' }: { path: string; tab?: ClassTab }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const [dropping, setDropping] = useState(false);
  const cls = classInfo(path, folderMeta[path]);
  const section = [cls.code, cls.term].filter(Boolean).join(' · ');
  const setTab = (t: ClassTab) => useUI.getState().setView({ kind: 'class', path, tab: t });

  return (
    <div
      className={cx('screen class-view', dropping && 'is-drop')}
      style={themeVars(cls.theme) as React.CSSProperties}
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
      <div className="screen-head">
        <nav className="crumbs" aria-label="Breadcrumb">
          <button className="crumb-root" onClick={() => useUI.getState().setView({ kind: 'classes' })}>
            Classes
          </button>
          <ChevronRight size={20} className="crumb-sep" />
          <span className="crumb-here">
            <span className="crumb-name">{cls.name}</span>
            {section && <span className="crumb-sub">{section}</span>}
          </span>
        </nav>
      </div>
      <Tabs
        items={[
          { id: 'stream', label: 'Stream' },
          { id: 'classwork', label: 'Classwork' },
          { id: 'study', label: 'Study' },
        ]}
        value={tab}
        onChange={setTab}
        className="is-class"
      >
        <button className="icon-btn" onClick={() => openLibrary({ kind: 'folder', path })} aria-label={`Ask your ${cls.name} notes`} title={`Ask your ${cls.name} notes`}>
          <LibraryBig size={20} />
        </button>
        <button className="icon-btn" onClick={() => editClass(path)} aria-label="Class settings" title="Class settings">
          <Settings size={20} />
        </button>
      </Tabs>
      <div className="screen-scroll">
        {tab === 'stream' && <Stream path={path} notes={notes} onTab={setTab} />}
        {tab === 'classwork' && <Classwork path={path} notes={notes} folders={folders} />}
        {tab === 'study' && <Study path={path} />}
      </div>
      {dropping && <div className="drop-hint">Drop to create homework from this scan</div>}
    </div>
  );
}

function Stream({ path, notes, onTab }: { path: string; notes: Record<string, NoteDoc>; onTab(t: ClassTab): void }) {
  const folderMeta = useVault((s) => s.folderMeta);
  const cls = classInfo(path, folderMeta[path]);
  const [info, setInfo] = useState(false);
  const infoBtn = useRef<HTMLButtonElement>(null);
  const upcoming = useMemo(
    () =>
      classHomework(path, notes)
        .filter((n) => !n.meta.homework!.done && n.meta.homework!.due && n.meta.homework!.due < Date.now() + 7 * 86_400_000)
        .sort((a, b) => a.meta.homework!.due! - b.meta.homework!.due!)
        .slice(0, 3),
    [path, notes],
  );
  const feed = useMemo(
    () =>
      Object.values(notes)
        .filter((n) => !n.meta.trashed && inFolder(n, path))
        .sort((a, b) => b.meta.created - a.meta.created)
        .slice(0, 30),
    [notes, path],
  );

  return (
    <div className="stream">
      <div className="banner">
        <ClassArt icon={cls.icon} h={240} />
        <div className="banner-name">{cls.name}</div>
        {(cls.code || cls.term) && <div className="banner-section">{[cls.code, cls.term].filter(Boolean).join(' · ')}</div>}
        <button className="banner-customize" onClick={() => useUI.getState().openDialog({ kind: 'customize', path })}>
          <Pencil size={18} /> Customize
        </button>
        <button ref={infoBtn} className="icon-btn banner-info" onClick={() => setInfo((v) => !v)} aria-label="Class details" title="Class details">
          <Info size={22} />
        </button>
        <Popover anchor={infoBtn.current} open={info} onClose={() => setInfo(false)} align="end" className="class-info-pop">
          <dl className="class-info">
            <dt>Course code</dt>
            <dd>{cls.code || '—'}</dd>
            <dt>Teacher</dt>
            <dd>{cls.instructor || '—'}</dd>
            <dt>Term</dt>
            <dd>{cls.term || '—'}</dd>
            <dt>Folder</dt>
            <dd>{cls.path}</dd>
          </dl>
        </Popover>
      </div>

      <div className="stream-grid">
        <aside className="upcoming">
          <div className="upcoming-title">Upcoming</div>
          {upcoming.length ? (
            upcoming.map((n) => (
              <button key={n.meta.id} className="upcoming-item" onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}>
                <span className={cx('upcoming-when', isMissing(n.meta.homework) && 'is-missing')}>{dueText(n)}</span>
                <span className="upcoming-name">{n.meta.title || 'Untitled homework'}</span>
              </button>
            ))
          ) : (
            <div className="upcoming-empty">No work due soon</div>
          )}
          <div className="upcoming-foot">
            <button className="btn is-ghost is-small is-class" onClick={() => useUI.getState().setView({ kind: 'homework' })}>
              View all
            </button>
          </div>
        </aside>

        <div className="stream-main">
          <div className="stream-actions">
            <button className="btn is-tonal" onClick={() => newNote(path)}>
              <Pencil size={18} /> New note
            </button>
            <button className="btn is-ghost is-class" onClick={() => newHomework(path)}>
              <ClipboardList size={18} /> Add homework
            </button>
          </div>
          {feed.length ? (
            feed.map((n) => {
              const edited = n.meta.updated - n.meta.created > 60_000;
              return (
                <div
                  key={n.meta.id}
                  className="stream-card"
                  role="link"
                  tabIndex={0}
                  onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}
                  onKeyDown={(e) => e.key === 'Enter' && useUI.getState().openNote(n.meta.id, { newTab: true })}
                  onContextMenu={(e) => openContextMenu(e, noteMenu(n))}
                >
                  <span className="item-circle is-40">{n.meta.homework ? <ClipboardList size={20} /> : <FileText size={20} />}</span>
                  <div className="stream-card-text">
                    <div className="stream-card-title">
                      {n.meta.homework ? 'New homework' : 'New note'}: {noteTitle(n)}
                    </div>
                    <div className="stream-card-date">
                      {when(n.meta.created)}
                      {edited ? ` (Edited ${when(n.meta.updated)})` : ''}
                    </div>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      openContextMenu(e, noteMenu(n));
                    }}
                    aria-label="More"
                  >
                    <MoreVertical size={20} />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="stream-card is-empty">
              <div className="stream-empty-title">This is where your class activity shows up</div>
              <div className="stream-empty-sub">Notes and homework you add to {cls.name} appear here.</div>
            </div>
          )}
          {feed.length > 0 && (
            <button className="btn is-ghost is-class stream-more" onClick={() => onTab('classwork')}>
              See everything in Classwork
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Classwork({ path, notes, folders }: { path: string; notes: Record<string, NoteDoc>; folders: string[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const createBtn = useRef<HTMLButtonElement>(null);
  const hwDir = `${path}/${HOMEWORK_SUBFOLDER}`;
  const open = (n: NoteDoc) => useUI.getState().openNote(n.meta.id, { newTab: true });
  const live = Object.values(notes).filter((n) => !n.meta.trashed && inFolder(n, path));
  const homework = live.filter((n) => n.meta.homework).sort((a, b) => (a.meta.homework!.due ?? Infinity) - (b.meta.homework!.due ?? Infinity));
  const topics = folders
    .filter((f) => f.startsWith(path + '/') && f !== hwDir && !f.startsWith(hwDir + '/'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const byTitle = (a: NoteDoc, b: NoteDoc) => noteTitle(a).localeCompare(noteTitle(b), undefined, { numeric: true });
  const loose = live.filter((n) => !n.meta.homework && n.meta.folder === path).sort(byTitle);
  const topicNotes = (f: string) => live.filter((n) => !n.meta.homework && n.meta.folder === f).sort(byTitle);
  const anchor = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const empty = !live.length;

  return (
    <div className="classwork">
      <nav className="topic-list" aria-label="Topics">
        <button className="topic-link is-active" onClick={() => document.querySelector('.screen-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })}>
          All topics
        </button>
        {homework.length > 0 && (
          <button className="topic-link" onClick={() => anchor('topic-homework')}>
            Homework
          </button>
        )}
        {topics.map((f) => (
          <button key={f} className="topic-link" onClick={() => anchor(`topic-${f}`)}>
            {f.slice(path.length + 1)}
          </button>
        ))}
      </nav>
      <div className="cw-main">
        <div className="cw-toolbar">
          <button ref={createBtn} className="btn is-primary is-create is-class" onClick={() => setCreateOpen((v) => !v)}>
            <Plus size={22} /> Create
          </button>
          <span className="grow" />
          {isElectron && (
            <button className="btn is-ghost is-class" onClick={() => useVault.getState().backend?.revealFolder?.(path)}>
              <FolderOpen size={18} /> Show in Finder
            </button>
          )}
        </div>
        {empty && (
          <div className="screen-empty is-block">
            <div className="screen-empty-title">This is where your notes and homework live</div>
            <div>Add notes and homework for this class, then organise them into topics.</div>
          </div>
        )}
        {homework.length > 0 && (
          <section className="topic" id="topic-homework">
            <div className="topic-head">
              <h2 className="topic-title">Homework</h2>
            </div>
            {homework.map((n) => (
              <ItemRow key={n.meta.id} note={n} onOpen={() => open(n)} />
            ))}
          </section>
        )}
        {topics.map((f) => {
          const list = topicNotes(f);
          return (
            <section key={f} className="topic" id={`topic-${f}`}>
              <div className="topic-head" onContextMenu={(e) => openContextMenu(e, folderMenu(f))}>
                <h2 className="topic-title">{f.slice(path.length + 1)}</h2>
                <button className="icon-btn topic-more" onClick={(e) => openContextMenu(e, folderMenu(f))} aria-label="Topic options">
                  <MoreVertical size={20} />
                </button>
              </div>
              {list.length ? list.map((n) => <ItemRow key={n.meta.id} note={n} onOpen={() => open(n)} />) : <div className="topic-empty">No items in this topic</div>}
            </section>
          );
        })}
        {loose.length > 0 && (
          <section className={cx('topic', (homework.length > 0 || topics.length > 0) && 'is-loose')}>
            {(homework.length > 0 || topics.length > 0) && (
              <div className="topic-head">
                <h2 className="topic-title">Notes</h2>
              </div>
            )}
            {loose.map((n) => (
              <ItemRow key={n.meta.id} note={n} onOpen={() => open(n)} />
            ))}
          </section>
        )}
      </div>

      <Popover anchor={createBtn.current} open={createOpen} onClose={() => setCreateOpen(false)} align="start" className="menu-pop">
        <div className="menu">
          {(
            [
              ['Note', <FileText size={20} key="i" />, () => newNote(path)],
              ['Homework', <ClipboardList size={20} key="i" />, () => newHomework(path)],
              ['Import scan', <ScanText size={20} key="i" />, () => newHomework(path)],
              null,
              ['Topic', <FolderPlus size={20} key="i" />, () => void newFolder(path)],
            ] as const
          ).map((it, i) =>
            it ? (
              <button
                key={it[0]}
                className="menu-item"
                onClick={() => {
                  setCreateOpen(false);
                  it[2]();
                }}
              >
                {it[1]}
                <span className="menu-label">{it[0]}</span>
              </button>
            ) : (
              <div key={i} className="menu-sep" />
            ),
          )}
        </div>
      </Popover>
    </div>
  );
}

function Study({ path }: { path: string }) {
  const folderMeta = useVault((s) => s.folderMeta);
  const cls = classInfo(path, folderMeta[path]);
  const scope = { kind: 'folder' as const, path };
  const run = (tool: StudyTool | 'review') => {
    if (tool === 'review') return reviewFolder(path);
    openLibrary(scope);
    void useAssistant.getState().askLibrary({ prompt: '', scope, scopeLabel: cls.name, tool });
  };
  return (
    <div className="study-page">
      <div className="study-intro">Made only from your {cls.name} notes. What you make opens in Ask your notes.</div>
      <div className="study-tiles">
        {STUDY.map((s) => (
          <div key={s.tool} className="studio-tile" style={toolStyle(s.tool)}>
            <button className="study-tool class-study-tool" onClick={() => run(s.tool)}>
              <ToolIcon tool={s.tool} size={24} />
              <span>
                <span className="study-tool-name">{TOOL_LOOK[s.tool].name}</span>
                <span className="study-tool-hint">{s.hint}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
