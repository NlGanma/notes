import { useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { FileText, Folder, MessageSquareText, Paperclip, Plus, SendHorizontal, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI, visionModel } from '../../state/ai';
import { useAssistant } from '../../state/assistant';
import { classForFolder, classInfo, inFolder, themeVars } from '../../lib/classes';
import { homeworkSources, isMissing, suggestSources } from '../../lib/homework';
import { toggleAssistant } from '../../lib/commands';
import { pickFiles, scanToBlocks, SCAN_TYPES } from '../../lib/import';
import { needsReading, readScannedPages } from '../../lib/scan';
import { editors } from '../registry';
import { Popover } from '../../components/common/Popover';
import { toast } from '../../components/common/toast';
import { DuePicker } from '../../components/homework/DuePicker';
import { openLinkPicker } from '../../components/homework/LinkNotesDialog';
import { dueLine, folderName, shortDate } from '../../components/homework/sources';
import { cx, formatRelativeTime, plural } from '../../lib/util';

/** One attachment of "Your work": a 56px tile with a thumbnail cell, title, type line and remove button. */
function Attachment({
  thumb,
  title,
  sub,
  source,
  onOpen,
  onRemove,
}: {
  thumb: React.ReactNode;
  title: string;
  sub: string;
  /** Linked sources keep the old class name the tests look for. */
  source?: boolean;
  onOpen(): void;
  onRemove?: () => void;
}) {
  return (
    <div className={cx('hw-att', source && 'hw-source-chip')}>
      <button className="hw-att-main" onClick={onOpen} title={title}>
        <span className="hw-att-thumb">{thumb}</span>
        <span className="hw-att-text">
          <span className="hw-att-title">{title}</span>
          <span className="hw-att-sub">{sub}</span>
        </span>
      </button>
      {onRemove && (
        <button className="icon-btn hw-att-x" onClick={onRemove} aria-label={`Remove ${title}`} title="Remove">
          <X size={20} />
        </button>
      )}
    </div>
  );
}

/**
 * The top of a homework's page, after Google Classroom's assignment page: the
 * meta line, linked notes and due date, the class-colour rule, then the "Your
 * work" card (status, the notes it answers from as attachments, Add or create,
 * Mark as done) and the card to ask the assistant about it.
 */
export function HomeworkBar({ note, tags }: { note: NoteDoc; /** The page's hashtags, shown above the class-colour rule. */ tags?: React.ReactNode }) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const hw = note.meta.homework!;
  const [reading, setReading] = useState(false);
  const [needsVision, setNeedsVision] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const addBtn = useRef<HTMLButtonElement>(null);
  const dueBtn = useRef<HTMLButtonElement>(null);

  const sources = useMemo(() => homeworkSources(note, notes), [note, notes]);
  const classPath = classForFolder(note.meta.folder, folderMeta);
  const cls = classPath ? classInfo(classPath, folderMeta[classPath]) : null;
  const suggestions = useMemo(() => (sources.length ? [] : suggestSources(note, notes, 2, classPath)), [sources.length, note, notes, classPath]);
  const pages = useMemo(() => (note.content.content ?? []).filter((b) => b.type === 'image'), [note.content]);
  const unreadPages = pages.filter((b) => needsReading(b.attrs)).length;
  // Read fresh, so an Undo from the snackbar doesn't roll back changes made since.
  const update = (patch: Partial<typeof hw>) => {
    const cur = useVault.getState().notes[note.meta.id]?.meta.homework ?? hw;
    useVault.getState().updateMeta(note.meta.id, { homework: { ...cur, ...patch } });
  };

  const missing = isMissing(hw);
  const late = hw.done && !!hw.due && hw.due < new Date(note.meta.updated).setHours(0, 0, 0, 0);
  const status = hw.done ? (late ? 'Done late' : 'Done') : missing ? 'Missing' : 'Assigned';
  const edited = note.meta.updated - note.meta.created > 60_000;
  const clsName = (folder: string) => {
    const p = classForFolder(folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]).name : null;
  };

  const markDone = (done: boolean) => {
    update({ done });
    if (done) toast.info('Marked as done', undefined, { label: 'Undo', run: () => update({ done: false }) });
  };

  const readPages = async () => {
    if (!visionModel(useAI.getState())) {
      setNeedsVision(true);
      toast.error('No vision model', 'Reading scanned pages needs a model that can see images (e.g. qwen2.5vl). Set one in Settings → Local AI.');
      return;
    }
    setReading(true);
    try {
      const n = await readScannedPages(note.meta.id);
      toast.success('Pages read', `${plural(n, 'page')} — the assistant can now see the questions`);
    } catch (e) {
      toast.error('Couldn’t read the pages', String((e as Error).message ?? e));
    } finally {
      setReading(false);
    }
  };

  // A scan or photo becomes pages of the homework, before "My work" (as when it's made from a scan).
  const addScan = async () => {
    setMenuOpen(false);
    const [f] = await pickFiles({ accept: SCAN_TYPES, multiple: false, title: 'Add a scan to your homework' });
    if (!f) return;
    let blocks: JSONContent[];
    try {
      blocks = await scanToBlocks(f);
    } catch (e) {
      toast.error('Couldn’t import this file', String((e as Error).message ?? e));
      return;
    }
    const ed = editors.get(note.meta.id);
    if (ed && !ed.isDestroyed) {
      let at = ed.state.doc.content.size;
      ed.state.doc.forEach((node, pos) => {
        if (at === ed.state.doc.content.size && node.type.name === 'heading' && node.textContent.trim() === 'My work') at = pos;
      });
      ed.chain().insertContentAt(at, blocks).run();
    } else {
      const content = note.content.content ?? [];
      useVault.getState().updateContent(note.meta.id, { ...note.content, content: [...blocks, ...content] });
    }
    if (useAI.getState().status === 'online' && visionModel()) void readScannedPages(note.meta.id, { priority: 'background' }).catch(() => undefined);
  };

  const createBlank = () => {
    setMenuOpen(false);
    const doc = useVault.getState().createNote({ folder: classPath ?? '', title: `Notes for ${note.meta.title || 'homework'}` });
    update({ sources: [...hw.sources, doc.meta.id] });
    useUI.getState().openNote(doc.meta.id, { newTab: true });
  };

  const scrollToPages = () => {
    const img = document.querySelector('.note-view:not(.is-hidden) .ProseMirror img');
    img?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const ask = () => {
    const prompt = question.trim();
    if (!prompt) return;
    toggleAssistant(true);
    void useAssistant.getState().ask(note.meta.id, { prompt });
    setQuestion('');
    setAsking(false);
  };

  // Attachments: linked classes and units, single notes, then the scanned pages.
  const folderTiles = hw.folders.map((f) => {
    const name = folderName(f, folderMeta);
    const count = sources.filter((n) => inFolder(n, f)).length;
    return (
      <Attachment
        key={`f:${f}`}
        source
        thumb={<Folder size={24} />}
        title={`All ${name} notes`}
        sub={`${plural(count, 'note')} · includes new ones`}
        onOpen={() => useUI.getState().setView(folderMeta[f]?.kind === 'class' ? { kind: 'class', path: f } : { kind: 'folder', path: f })}
        onRemove={hw.done ? undefined : () => update({ folders: hw.folders.filter((x) => x !== f) })}
      />
    );
  });
  const noteTiles = hw.sources
    .map((id) => notes[id])
    .filter((n): n is NoteDoc => !!n && !n.meta.trashed && !hw.folders.some((f) => inFolder(n, f)))
    .map((n) => {
      const c = clsName(n.meta.folder);
      return (
        <Attachment
          key={n.meta.id}
          source
          thumb={<FileText size={24} />}
          title={n.meta.title || 'Untitled'}
          sub={c ? `Note · ${c}` : 'Note'}
          onOpen={() => useUI.getState().openNote(n.meta.id, { newTab: true })}
          onRemove={hw.done ? undefined : () => update({ sources: hw.sources.filter((x) => x !== n.meta.id) })}
        />
      );
    });
  const firstPage = pages[0]?.attrs;

  return (
    <div className="hw-bar" style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}>
      <div className="hw-meta">
        {/* The class name links back to the class, like the page header's on ordinary notes. */}
        {cls ? (
          <button className="crumb is-class" onClick={() => useUI.getState().setView({ kind: 'class', path: cls.path })}>
            {cls.name}
          </button>
        ) : (
          'No class'
        )}
        {[
          '',
          cls?.instructor,
          `Added ${shortDate(note.meta.created)}${edited ? ` (Edited ${formatRelativeTime(note.meta.updated).replace(/^Just/, 'just')})` : ''}`,
        ]
          .filter((x) => x !== undefined)
          .join(' • ')}
      </div>
      <div className="hw-meta-row">
        <button className="hw-link-btn" onClick={() => openLinkPicker(note.meta.id)}>
          {sources.length ? plural(sources.length, 'linked note') : 'No linked notes'}
        </button>
        <button ref={dueBtn} className={cx('hw-due-btn', missing && 'is-missing')} onClick={() => setDueOpen((v) => !v)} aria-haspopup="dialog">
          {!hw.due ? 'No due date' : missing ? `Missing · was due ${shortDate(hw.due)}` : dueLine(hw.due)}
        </button>
      </div>
      {tags}
      <div className="hw-rule" />

      <section className="hw-work" aria-label="Your work">
        <div className="hw-work-head">
          <h2 className="hw-work-title">Your work</h2>
          <span className={cx('hw-status', `is-${status === 'Assigned' ? 'assigned' : status === 'Done' ? 'done' : 'missing'}`)}>{status}</span>
          <span className="grow" />
          <div className="hw-work-actions">
            {!hw.done && (
              <button ref={addBtn} className="btn is-secondary hw-add-btn" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
                <Plus size={18} /> Add or create
              </button>
            )}
            <button className={cx('btn hw-done', hw.done ? 'is-secondary is-on' : 'is-primary')} onClick={() => markDone(!hw.done)}>
              {hw.done ? 'Mark as not done' : 'Mark as done'}
            </button>
          </div>
        </div>
        <div className="hw-atts">
          {folderTiles}
          {noteTiles}
          {pages.length > 0 && (
            <div className="hw-att-group">
              <Attachment
                thumb={firstPage?.src ? <img src={String(firstPage.src)} alt="" /> : <FileText size={24} />}
                title={/\.\w{2,4}$/.test(String(firstPage?.title ?? '')) ? String(firstPage!.title) : 'Scanned worksheet'}
                sub={`Scan · ${plural(pages.length, 'page')}`}
                onOpen={scrollToPages}
              />
              {unreadPages > 0 && (
                <div className="hw-read-row">
                  <button className="btn is-ghost is-small hw-read" onClick={() => void readPages()} disabled={reading}>
                    {reading && <span className="spinner" />}
                    {reading ? 'Reading…' : `Read ${plural(unreadPages, 'page')}`}
                  </button>
                  {needsVision && <span className="hw-read-hint">Needs a vision model, set one in Settings → Local AI</span>}
                </div>
              )}
            </div>
          )}
          {!sources.length && (
            <div className="hw-no-sources">
              <span>No notes linked yet.</span>
              {!hw.done &&
                suggestions.map((s) => (
                  <button
                    key={s.note.meta.id}
                    className="btn is-ghost is-small hw-suggest"
                    onClick={() => update({ sources: [...hw.sources, s.note.meta.id] })}
                    title={s.terms.length ? `Matches ${s.terms.join(', ')}` : undefined}
                  >
                    <Plus size={18} /> {s.note.meta.title || 'Untitled'}
                  </button>
                ))}
            </div>
          )}
        </div>
      </section>
      <div className="hw-work-note">
        {sources.length ? 'The assistant answers only from these notes.' : 'Link notes so the assistant can answer from them.'}
      </div>

      <section className="hw-help" aria-label="Ask about this homework">
        <div className="hw-help-head">
          <MessageSquareText size={20} /> Ask about this homework
        </div>
        {asking ? (
          <div className="hw-help-input">
            <input
              autoFocus
              value={question}
              placeholder="Ask about problem 2…"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) ask();
                else if (e.key === 'Escape') setAsking(false);
              }}
              onBlur={() => !question.trim() && setAsking(false)}
            />
            <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={ask} disabled={!question.trim()} aria-label="Ask">
              <SendHorizontal size={20} />
            </button>
          </div>
        ) : (
          <button className="hw-help-link" onClick={() => setAsking(true)}>
            Ask the assistant about this homework
          </button>
        )}
      </section>

      <Popover anchor={addBtn.current} open={menuOpen} onClose={() => setMenuOpen(false)} align="start" offset={4} className="menu-pop">
        <div className="menu hw-add-menu" role="menu">
          <button
            className="menu-item"
            onClick={() => {
              setMenuOpen(false);
              openLinkPicker(note.meta.id);
            }}
          >
            <FileText size={20} />
            <span className="menu-label">Note…</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setMenuOpen(false);
              openLinkPicker(note.meta.id, 'all');
            }}
          >
            <Folder size={20} />
            <span className="menu-label">Whole class…</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => void addScan()}>
            <Paperclip size={20} />
            <span className="menu-label">Scan or file</span>
          </button>
          <div className="menu-sep" />
          <div className="menu-title">Create new</div>
          <button className="menu-item" onClick={createBlank}>
            <Plus size={20} />
            <span className="menu-label">{cls ? `Blank note in ${cls.name}` : 'Blank note'}</span>
          </button>
        </div>
      </Popover>
      <Popover anchor={dueBtn.current} open={dueOpen} onClose={() => setDueOpen(false)} align="end" offset={4}>
        <DuePicker
          value={hw.due}
          onDone={(due) => {
            update({ due });
            setDueOpen(false);
          }}
        />
      </Popover>
    </div>
  );
}
