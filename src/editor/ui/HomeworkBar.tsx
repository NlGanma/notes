import { useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { CalendarDays, Check, FilePlus, FileText, Folder, Paperclip, Plus, ScanText, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI, visionModel } from '../../state/ai';
import { classForFolder, classInfo, inFolder, themeVars } from '../../lib/classes';
import { dueLabel, homeworkSources, suggestSources } from '../../lib/homework';
import { linkNotes, newNote } from '../../lib/commands';
import { displayTitle } from '../../lib/displayTitle';
import { pickFiles, scanToBlocks, SCAN_TYPES } from '../../lib/import';
import { needsReading, readScannedPages } from '../../lib/scan';
import { editors } from '../registry';
import { Popover } from '../../components/common/Popover';
import { toast } from '../../components/common/toast';
import { DuePicker } from '../../components/homework/DuePicker';
import { setDone } from '../../components/homework/HomeworkRow';
import { folderName, shortDate } from '../../components/homework/sources';
import { cx, plural } from '../../lib/util';

/**
 * Under a homework's title: one quiet row with its class, when it's due and Mark done; then the notes it uses
 * (× unlinks one, Change… picks them), the worksheet's pages and whether they've been read, and the line
 * saying the homework helper answers only from these notes.
 */
export function HomeworkBar({ note }: { note: NoteDoc }) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const hw = note.meta.homework!;
  const [reading, setReading] = useState(false);
  const [needsVision, setNeedsVision] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const dueBtn = useRef<HTMLButtonElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  const sources = useMemo(() => homeworkSources(note, notes), [note, notes]);
  const classPath = classForFolder(note.meta.folder, folderMeta);
  const cls = classPath ? classInfo(classPath, folderMeta[classPath]) : null;
  const suggestions = useMemo(() => (sources.length || hw.done ? [] : suggestSources(note, notes, 2, classPath)), [sources.length, hw.done, note, notes, classPath]);
  const pages = useMemo(() => (note.content.content ?? []).filter((b) => b.type === 'image'), [note.content]);
  const unread = pages.filter((b) => needsReading(b.attrs)).length;

  // Read fresh, so an Undo from a toast never rolls back changes made since.
  const update = (patch: Partial<typeof hw>) => {
    const cur = useVault.getState().notes[note.meta.id]?.meta.homework ?? hw;
    useVault.getState().updateMeta(note.meta.id, { homework: { ...cur, ...patch } });
  };

  const due = hw.done ? (hw.due ? { text: `Due ${shortDate(hw.due)}`, tone: 'later' as const } : null) : dueLabel(hw.due);

  const readPages = async () => {
    if (!visionModel(useAI.getState())) {
      setNeedsVision(true);
      return;
    }
    setReading(true);
    try {
      const n = await readScannedPages(note.meta.id);
      toast.success('Pages read', `${plural(n, 'page')}. The homework helper can see the questions now.`);
    } catch (e) {
      console.warn('Reading the pages failed', e);
      toast.error('Couldn’t read the pages', 'Check that the local AI is running, then try again.');
    } finally {
      setReading(false);
    }
  };

  // A scan or photo becomes pages of the homework, before "My work" (as when it's made from a scan).
  const addScan = async () => {
    setAddOpen(false);
    const [f] = await pickFiles({ accept: SCAN_TYPES, multiple: false, title: 'Add a scan to your homework' });
    if (!f) return;
    let blocks: JSONContent[];
    try {
      blocks = await scanToBlocks(f);
    } catch (e) {
      console.warn('Importing the scan failed', e);
      toast.error('Couldn’t import this file', 'It may be damaged, or not a PDF or image.');
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

  // A note to work things out in, filed with the class and used as one of the homework's notes. It opens
  // offering the paper choice, as every new note does.
  const createNote = () => {
    setAddOpen(false);
    const doc = newNote(classPath ?? '', { newTab: true });
    useVault.getState().updateMeta(doc.meta.id, { title: `Notes for ${displayTitle(note)}` });
    update({ sources: [...hw.sources, doc.meta.id] });
  };

  const scrollToPages = () => {
    document.querySelector('.note-view:not(.is-hidden) .ProseMirror img')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const looseNotes = hw.sources.map((id) => notes[id]).filter((n): n is NoteDoc => !!n && !n.meta.trashed && !hw.folders.some((f) => inFolder(n, f)));
  const firstPage = pages[0]?.attrs;
  const sheetName = /\.\w{2,4}$/.test(String(firstPage?.title ?? '')) ? String(firstPage!.title) : 'Worksheet';

  return (
    <div className="hw-bar" style={cls ? (themeVars(cls.theme) as React.CSSProperties) : undefined}>
      <div className="hw-meta-row">
        {cls ? (
          <button className="hw-chip hw-class" onClick={() => useUI.getState().setView({ kind: 'class', path: cls.path })} title={`Open ${cls.name}`}>
            <span className="class-square" style={{ background: cls.color }} />
            <span className="hw-chip-text">{cls.name}</span>
          </button>
        ) : (
          <span className="hw-chip hw-class is-none">No class</span>
        )}
        <button
          ref={dueBtn}
          className={cx('hw-chip hw-due-btn', due?.tone === 'overdue' && 'is-overdue', !due && 'is-none', dueOpen && 'is-on')}
          onClick={() => setDueOpen(!dueOpen)}
          aria-haspopup="dialog"
        >
          <CalendarDays size={14} strokeWidth={1.5} />
          {due ? due.text : 'No due date'}
        </button>
        <span className="grow" />
        {!hw.done && (
          <button ref={addBtn} className={cx('btn is-ghost is-quiet hw-add', addOpen && 'is-on')} onClick={() => setAddOpen(!addOpen)} aria-haspopup="menu">
            <Plus size={14} strokeWidth={1.75} /> Add
          </button>
        )}
        <button className={cx('btn is-small hw-done', hw.done ? 'is-on' : 'is-secondary')} aria-pressed={!!hw.done} onClick={() => setDone(note, !hw.done)}>
          {hw.done && <Check size={14} strokeWidth={2} />}
          {hw.done ? 'Done' : 'Mark done'}
        </button>
      </div>

      {/* The notes it uses, said once: the chips, and the one button that changes them. */}
      {(!hw.done || sources.length > 0 || pages.length > 0) && (
        <div className="hw-sources">
          {hw.folders.map((f) => (
            <span key={`f:${f}`} className="hw-source-chip is-folder">
              <button
                className="hw-source-open"
                onClick={() => useUI.getState().setView(folderMeta[f]?.kind === 'class' ? { kind: 'class', path: f } : { kind: 'folder', path: f })}
                title={`${plural(sources.filter((n) => inFolder(n, f)).length, 'note')}, and new ones`}
              >
                <Folder size={13} strokeWidth={1.5} />
                <span className="hw-source-name">All {folderName(f, folderMeta)} notes</span>
              </button>
              {!hw.done && (
                <button className="hw-source-x" onClick={() => update({ folders: hw.folders.filter((x) => x !== f) })} aria-label={`Remove All ${folderName(f, folderMeta)} notes`}>
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </span>
          ))}
          {looseNotes.map((n) => (
            <span key={n.meta.id} className="hw-source-chip">
              <button className="hw-source-open" onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })} title={displayTitle(n)}>
                <FileText size={13} strokeWidth={1.5} />
                <span className="hw-source-name">{displayTitle(n)}</span>
              </button>
              {!hw.done && (
                <button className="hw-source-x" onClick={() => update({ sources: hw.sources.filter((x) => x !== n.meta.id) })} aria-label={`Remove ${displayTitle(n)}`}>
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </span>
          ))}
          {!sources.length && suggestions.length > 0 && (
            <span className="hw-suggestions">
              <span className="hw-suggestions-text">Try</span>
              {suggestions.map((s) => (
                <button
                  key={s.note.meta.id}
                  className="hw-suggest"
                  onClick={() => update({ sources: [...hw.sources, s.note.meta.id] })}
                  title={s.terms.length ? `Matches ${s.terms.join(', ')}` : undefined}
                >
                  <Plus size={12} strokeWidth={2} />
                  <span className="hw-source-name">{displayTitle(s.note)}</span>
                </button>
              ))}
            </span>
          )}
          {!hw.done && (
            <button className="btn is-ghost is-quiet hw-link-btn" onClick={() => linkNotes(note.meta.id)}>
              {sources.length ? (
                'Change…'
              ) : (
                <>
                  <Plus size={14} strokeWidth={1.75} /> Link notes
                </>
              )}
            </button>
          )}
          {pages.length > 0 && (
            <span className="hw-sheet-group">
              <button className="hw-source-chip is-sheet hw-source-open" onClick={scrollToPages} title={sheetName}>
                <ScanText size={13} strokeWidth={1.5} />
                <span className="hw-source-name">
                  {sheetName} · {plural(pages.length, 'page')}
                </span>
              </button>
              {unread > 0 && (
                <button className="btn is-ghost is-quiet hw-read" onClick={() => void readPages()} disabled={reading}>
                  {reading && <span className="spinner" />}
                  {reading ? 'Reading…' : `Read ${plural(unread, 'page')}`}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {needsVision && unread > 0 && <div className="hw-read-hint">Needs a vision model. Set one in Settings → Local AI.</div>}
      {/* What the homework helper may use, said plainly: a notes-only label. */}
      <div className="hw-work-note">
        {sources.length ? 'The homework helper answers only from these notes.' : 'No notes linked yet. The homework helper answers only from linked notes.'}
      </div>

      <Popover anchor={dueBtn.current} open={dueOpen} onClose={() => setDueOpen(false)} align="start" offset={4} className="due-pop">
        <DuePicker
          value={hw.due}
          onDone={(d) => {
            update({ due: d });
            setDueOpen(false);
          }}
        />
      </Popover>
      <Popover anchor={addBtn.current} open={addOpen} onClose={() => setAddOpen(false)} align="end" offset={4} className="menu-pop">
        <div className="menu" role="menu">
          <button className="menu-item" role="menuitem" onClick={() => void addScan()}>
            <Paperclip size={16} strokeWidth={1.5} />
            <span className="menu-label">Scan or photo…</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={createNote}>
            <FilePlus size={16} strokeWidth={1.5} />
            <span className="menu-label">New note for this homework</span>
          </button>
        </div>
      </Popover>
    </div>
  );
}
