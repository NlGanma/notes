import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ClipboardList, FolderPlus, MoreHorizontal, Plus, Repeat } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { useAssistant } from '../../state/assistant';
import { conceptsOf, useReview } from '../../state/review';
import { isDue } from '../../lib/review/mastery';
import { isReviewable } from '../../lib/review/tree';
import type { NoteDoc } from '../../lib/vault/types';
import { classCounts, classHomework, classInfo, classNotes, countLine, HOMEWORK_SUBFOLDER, themeVars, type ClassInfo } from '../../lib/classes';
import { dueLabel } from '../../lib/homework';
import { newFolder, newHomework, openLibrary, reviewFolder } from '../../lib/commands';
import { importDropped, SCAN_TYPES } from '../../lib/import';
import { cx } from '../../lib/util';
import { folderMenu } from '../FileTree';
import { dateGroup, FolderRow, NoteRow } from '../NoteGrid';
import { NewNotePopover } from '../NewNoteMenu';
import { DoneList, HomeworkRow, isTodo, useJustDone } from '../homework/HomeworkRow';
import { byDue } from '../homework/sources';
import { menuUnder } from './ClassesView';

const isScan = (f: File) => SCAN_TYPES.includes(f.name.split('.').pop()?.toLowerCase() ?? '');

/** Ideas due for review in a class, counted a moment after the notes or the review file change. */
function useReviewDue(path: string, notes: Record<string, NoteDoc>) {
  const file = useReview((s) => s.file);
  const [due, setDue] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      const now = Date.now();
      let n = 0;
      for (const note of classNotes(path, notes)) if (isReviewable(note)) n += conceptsOf(note, file).filter((c) => isDue(file.states[c.id], now)).length;
      setDue(n);
    }, 300);
    return () => clearTimeout(t);
  }, [path, notes, file]);
  return due;
}

/** Claude's project composer: one line until it's used, then room to write. Asking opens Ask your notes on this class. */
function AskComposer({ cls }: { cls: ClassInfo }) {
  const status = useAI((s) => s.status);
  const [text, setText] = useState('');
  // Once used, it stays open: shrinking on blur would move the buttons under a click that is landing.
  const [opened, setOpened] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const offline = status === 'offline';
  const loading = status !== 'online' && !offline;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, opened]);

  const ask = () => {
    const prompt = text.trim();
    if (!prompt || offline) return;
    const scope = { kind: 'folder' as const, path: cls.path };
    openLibrary(scope);
    void useAssistant.getState().askLibrary({ prompt, scope, scopeLabel: cls.name });
    setText('');
  };

  return (
    <form
      className={cx('class-ask', (opened || !!text) && 'is-open')}
      onSubmit={(e) => {
        e.preventDefault();
        ask();
      }}
      onClick={() => ref.current?.focus()}
    >
      {(offline || loading) && (
        <div className="class-ask-status">
          <span className={cx('class-ask-dot', offline ? 'is-offline' : 'is-loading')} />
          {offline ? 'Local AI isn’t running.' : 'Starting the local model…'}
          <button type="button" className="link-btn" onClick={() => useUI.getState().openSettings('ai')}>
            Open settings
          </button>
        </div>
      )}
      <div className="class-ask-row">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={`Ask about your ${cls.name} notes`}
          aria-label={`Ask about your ${cls.name} notes`}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpened(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <button type="submit" className="class-ask-send" disabled={!text.trim() || offline} aria-label="Ask" title="Ask">
          <ArrowUp size={16} strokeWidth={2} />
        </button>
      </div>
    </form>
  );
}

/**
 * A class's page, as Claude lays out a project: the class's name, a composer to ask its notes, a row of
 * actions, then its homework (Reminders: tick to finish) and its notes (Apple Notes: folders, then notes
 * by when they were last edited). Dropping a PDF or photo on it makes homework from it.
 */
export function ClassView({ path }: { path: string }) {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const [dropping, setDropping] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const cls = classInfo(path, folderMeta[path]);
  const reviewDue = useReviewDue(path, notes);
  const held = useJustDone((s) => s.ids);

  const homework = useMemo(() => classHomework(path, notes).sort(byDue), [path, notes]);
  const todo = homework.filter((n) => isTodo(n, held));
  const done = homework.filter((n) => !isTodo(n, held)).sort((a, b) => b.meta.updated - a.meta.updated);
  const lecture = useMemo(() => classNotes(path, notes).sort((a, b) => b.meta.updated - a.meta.updated), [path, notes]);
  const hwDir = `${path}/${HOMEWORK_SUBFOLDER}`;
  const subfolders = folders.filter((f) => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/') && f !== hwDir);
  const countIn = (f: string) => lecture.filter((n) => n.meta.folder === f || n.meta.folder.startsWith(f + '/')).length;
  const groups = useMemo(() => {
    const out: { label: string; notes: NoteDoc[] }[] = [];
    for (const n of lecture) {
      const label = dateGroup(n.meta.updated);
      const last = out[out.length - 1];
      if (last?.label === label) last.notes.push(n);
      else out.push({ label, notes: [n] });
    }
    return out;
  }, [lecture]);
  const line = countLine(classCounts(path, notes));
  const empty = !homework.length && !lecture.length && !subfolders.length;

  return (
    <div
      className={cx('screen class-view', dropping && 'is-drop')}
      style={themeVars(cls.theme) as React.CSSProperties}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        // Taken here, always: a file the page doesn't handle must never make the window open it.
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const scan = [...e.dataTransfer.files].find(isScan);
        if (scan) newHomework(path, { name: scan.name, bytes: new Uint8Array(await scan.arrayBuffer()) });
        else void importDropped(e.dataTransfer.files);
      }}
    >
      <div className="screen-scroll">
        <div className="class-col">
          <header className="class-head">
            <div className="class-head-row">
              <span className="class-head-square" aria-hidden />
              <h1 className="page-h1 class-title" title={cls.name}>
                {cls.name}
              </h1>
              <span className="grow" />
              <button className="icon-btn class-head-more" aria-label={`${cls.name} options`} title="Options" onClick={(e) => menuUnder(e, folderMenu(path, { onPage: true }))}>
                <MoreHorizontal size={18} strokeWidth={1.5} />
              </button>
            </div>
            {line && <div className="class-head-meta">{line}</div>}
          </header>

          {lecture.length > 0 && <AskComposer cls={cls} />}

          <div className="class-actions">
            <button ref={newBtn} className={cx('btn is-secondary', newOpen && 'is-on')} onClick={() => setNewOpen(!newOpen)} aria-haspopup="menu" aria-expanded={newOpen}>
              <Plus size={16} strokeWidth={1.75} /> New note
            </button>
            <button className="btn is-secondary" onClick={() => newHomework(path)}>
              <ClipboardList size={16} strokeWidth={1.5} /> New homework
            </button>
            <span className="grow" />
            {lecture.length > 0 && (
              <button className="btn is-secondary class-review" onClick={() => reviewFolder(path)}>
                <Repeat size={16} strokeWidth={1.5} /> Review
                {reviewDue > 0 && <span className="badge-count">{reviewDue}</span>}
              </button>
            )}
          </div>
          <NewNotePopover anchor={newBtn.current} open={newOpen} onClose={() => setNewOpen(false)} folder={path} placement="bottom" />

          {empty ? (
            <div className="class-empty">
              <div className="page-empty-title">Nothing here yet</div>
              <div className="page-empty-sub">Drop a PDF or photo here to make homework.</div>
            </div>
          ) : (
            <>
              {homework.length > 0 && (
                <section className="class-section class-homework">
                  <h2 className="class-section-head">Homework</h2>
                  {todo.map((n) => {
                    const due = dueLabel(n.meta.homework!.due);
                    return <HomeworkRow key={n.meta.id} note={n} cls={cls} due={due && { text: due.text, overdue: due.tone === 'overdue' }} />;
                  })}
                  {!todo.length && <div className="class-section-empty">All done</div>}
                  <DoneList count={done.length}>{() => done.map((n) => <HomeworkRow key={n.meta.id} note={n} cls={cls} />)}</DoneList>
                </section>
              )}

              {(lecture.length > 0 || subfolders.length > 0) && (
                <section className="class-section class-notes">
                  <div className="class-section-row">
                    <h2 className="class-section-head">Notes</h2>
                    <span className="grow" />
                    <button className="btn is-ghost is-quiet class-new-folder" onClick={() => void newFolder(path)}>
                      <FolderPlus size={14} strokeWidth={1.5} /> New folder
                    </button>
                  </div>
                  {subfolders.map((f) => (
                    <FolderRow key={f} path={f} count={countIn(f)} />
                  ))}
                  {groups.map((g) => (
                    <Fragment key={g.label}>
                      <h3 className="list-caption">{g.label}</h3>
                      {g.notes.map((n) => (
                        <NoteRow key={n.meta.id} note={n} />
                      ))}
                    </Fragment>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {dropping && <div className="drop-hint">Drop a PDF or photo to make homework for {cls.name}</div>}
    </div>
  );
}
