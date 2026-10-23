import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { CalendarDays, Check, ChevronDown, FileUp, RotateCcw, X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Popover } from '../common/Popover';
import { toast } from '../common/toast';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAI, visionModel } from '../../state/ai';
import { useSettings } from '../../state/settings';
import { homeworkFolderFor, listClasses } from '../../lib/classes';
import { createHomework } from '../../lib/commands';
import { homeworkSources } from '../../lib/homework';
import { pickFiles, scanToBlocks, SCAN_TYPES, type InFile } from '../../lib/import';
import { readScannedPages } from '../../lib/scan';
import { dateTitle } from '../../lib/displayTitle';
import { normalizePaper, type Paper } from '../../lib/paper';
import type { NoteDoc } from '../../lib/vault/types';
import { cx, plural } from '../../lib/util';
import { PaperPicker } from '../PaperPicker';
import { DuePicker } from './DuePicker';
import { NotePicker } from './NotePicker';
import { summarize, type SourceSelection } from './sources';

type Scan = { file: InFile; status: 'importing' | 'ready' | 'failed'; blocks?: JSONContent[] };

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');
const dueValue = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const isScan = (name: string) => SCAN_TYPES.includes(name.split('.').pop()?.toLowerCase() ?? '');
// Opened with no class in view (the Homework page), the dialog starts on the class used last.
let lastClass: string | null = null;

/**
 * New homework, as a small Claude dialog: an optional name, then the class, the due date, the paper, a
 * worksheet (a PDF or photo becomes the homework's pages) and the notes the helper answers from, which
 * start as the whole class. The homework's own page is where its instructions and work go.
 */
export function NewHomeworkDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'newHomework';
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const notes = useVault((s) => s.notes);
  const lastPaper = useSettings((s) => s.paper);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);

  const [classPath, setClassPath] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState<number | undefined>(undefined);
  const [paper, setPaper] = useState<Paper>('ruled');
  // null = the default: the whole class.
  const [answers, setAnswers] = useState<SourceSelection | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [classOpen, setClassOpen] = useState(false);
  // A second Create while the first still runs is ignored (state lags a render).
  const busyRef = useRef(false);
  const scanPromise = useRef<Promise<JSONContent[]> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dueBtn = useRef<HTMLButtonElement>(null);
  const classBtn = useRef<HTMLButtonElement>(null);

  const importScan = (file: InFile) => {
    const p = scanToBlocks(file);
    scanPromise.current = p;
    setScan({ file, status: 'importing' });
    setTitle((t) => (t.trim() ? t : baseName(file.name)));
    p.then(
      (blocks) => scanPromise.current === p && setScan({ file, status: 'ready', blocks }),
      () => scanPromise.current === p && setScan({ file, status: 'failed' }),
    );
  };
  const removeScan = () => {
    scanPromise.current = null;
    setScan(null);
  };

  // Before the first paint, so the dialog never shows the previous homework for a moment.
  useLayoutEffect(() => {
    if (!open) return;
    setClassPath(dialog.classPath ?? (classes.some((c) => c.path === lastClass) ? lastClass : (classes[0]?.path ?? null)));
    setTitle('');
    setDue(undefined);
    setPaper(normalizePaper(lastPaper));
    setAnswers(null);
    removeScan();
    setBusy(false);
    busyRef.current = false;
    if (dialog.file) importScan(dialog.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cls = classes.find((c) => c.path === classPath) ?? null;
  const sel: SourceSelection = answers ?? { sources: [], folders: classPath ? [classPath] : [] };
  // The homework as it will be: for counting its notes and for the picker's suggestions.
  const draft = useMemo<NoteDoc>(
    () => ({
      version: 1,
      meta: { id: '', title, folder: homeworkFolderFor(classPath), tags: [], created: Date.now(), updated: 0, homework: { ...sel, due } },
      content: { type: 'doc', content: [] },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, classPath, answers, due],
  );
  const sourceCount = useMemo(() => (open ? homeworkSources(draft, notes).length : 0), [open, draft, notes]);

  if (!open) return null;
  const close = () => useUI.getState().openDialog(null);

  const chooseFile = async () => {
    const [f] = await pickFiles({ accept: SCAN_TYPES, multiple: false, title: 'Choose a worksheet' });
    if (f && !busyRef.current) importScan(f);
  };

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const pages = scanPromise.current ? await scanPromise.current : [];
      const content: JSONContent | undefined = pages.length
        ? { type: 'doc', content: [...pages, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My work' }] }, { type: 'paragraph' }] }
        : undefined;
      const doc = createHomework({ classPath, title: title.trim(), due, content, paper });
      lastClass = classPath;
      const hw = useVault.getState().notes[doc.meta.id]?.meta.homework ?? { sources: [], folders: [] };
      useVault.getState().updateMeta(doc.meta.id, { homework: { ...hw, due, sources: sel.sources, folders: sel.folders } });
      // A scan without a text layer is read by the vision model, so the helper knows the questions.
      if (pages.length && useAI.getState().status === 'online' && visionModel()) {
        toast.info('Reading your homework…', 'So the assistant can see the questions');
        readScannedPages(doc.meta.id, { priority: 'background' })
          .then((n) => n && toast.success('Homework read', `${plural(n, 'page')} — ask the assistant about any problem`))
          .catch(() => undefined);
      }
      close();
    } catch (e) {
      toast.error('Couldn’t create the homework', String((e as Error).message ?? e));
      busyRef.current = false;
      setBusy(false);
    }
  };

  const pagesOf = scan?.blocks?.filter((b) => b.type === 'image') ?? [];
  const thumb = pagesOf[0]?.attrs?.src ? String(pagesOf[0].attrs.src) : null;
  const usesLabel = sourceCount ? summarize(sel, notes, folderMeta) || plural(sourceCount, 'note') : cls && !answers ? `${cls.name} has no notes yet` : 'No notes';
  const placeholder = dateTitle({ ...draft, meta: { ...draft.meta, title: '' } });

  return (
    // Esc with a menu open closes just the menu.
    <Modal open onClose={() => !classOpen && !dueOpen && close()} width={520} bare className="hw-dialog">
      <div
        className={cx('hw-new', dragOver && 'is-drop')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void create();
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const f = [...e.dataTransfer.files].find((x) => isScan(x.name));
          if (f && !busyRef.current) importScan({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
          else if (!f && e.dataTransfer.files.length) toast.error('Not a worksheet', 'Drop a PDF or a photo (PNG, JPG).');
        }}
      >
        <div className="hw-new-body">
          <div className="hw-new-kicker">New homework</div>
          <input
            ref={titleRef}
            className="hw-title-input"
            value={title}
            autoFocus
            maxLength={200}
            placeholder={placeholder}
            aria-label="Name"
            spellCheck={false}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void create();
              }
            }}
          />

          <div className="hw-props">
            <div className="hw-prop">
              <span className="hw-prop-label">Class</span>
              <button ref={classBtn} className={cx('chip hw-for', classOpen && 'is-on')} onClick={() => setClassOpen(!classOpen)} aria-haspopup="menu" title={cls?.name}>
                {cls && <span className="class-square" style={{ background: cls.color }} />}
                <span className="hw-chip-text">{cls?.name ?? 'No class'}</span>
                <ChevronDown size={14} strokeWidth={1.5} />
              </button>
            </div>
            <div className="hw-prop">
              <span className="hw-prop-label">Due</span>
              <button ref={dueBtn} className={cx('chip hw-due-pick', dueOpen && 'is-on')} onClick={() => setDueOpen(!dueOpen)} aria-haspopup="dialog">
                <CalendarDays size={14} strokeWidth={1.5} />
                <span className={cx('hw-chip-text', !due && 'is-none')}>{due ? dueValue(due) : 'No due date'}</span>
                <ChevronDown size={14} strokeWidth={1.5} />
              </button>
            </div>
            <div className="hw-prop is-paper">
              <span className="hw-prop-label">Paper</span>
              <PaperPicker value={paper} onChange={setPaper} size="m" />
            </div>
            <div className="hw-prop">
              <span className="hw-prop-label">Worksheet</span>
              {scan ? (
                <div className={cx('hw-sheet', scan.status === 'failed' && 'is-failed')}>
                  <span className="hw-sheet-thumb">{scan.status === 'importing' ? <span className="spinner" /> : thumb ? <img src={thumb} alt="" /> : <FileUp size={14} />}</span>
                  <span className="hw-sheet-name" title={scan.file.name}>
                    {scan.file.name}
                  </span>
                  <span className="hw-sheet-sub">
                    {scan.status === 'importing' ? 'Importing…' : scan.status === 'failed' ? 'Couldn’t import it' : plural(pagesOf.length, 'page')}
                  </span>
                  {scan.status === 'failed' && (
                    <button className="icon-btn is-tiny" onClick={() => importScan(scan.file)} aria-label="Try again" title="Try again">
                      <RotateCcw size={14} strokeWidth={1.5} />
                    </button>
                  )}
                  <button className="icon-btn is-tiny" onClick={removeScan} aria-label={`Remove ${scan.file.name}`} title="Remove">
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </div>
              ) : (
                <button className="chip hw-worksheet-add" onClick={() => void chooseFile()} disabled={busy}>
                  <FileUp size={14} strokeWidth={1.5} /> Add a PDF or photo
                </button>
              )}
            </div>
            <div className="hw-prop">
              <span className="hw-prop-label">Uses notes</span>
              <span className={cx('hw-uses', !sourceCount && 'is-none')} title={usesLabel}>
                {usesLabel}
              </span>
              <button className="btn is-ghost is-quiet hw-uses-change" onClick={() => setPickerOpen(true)}>
                Change
              </button>
            </div>
          </div>
        </div>
        <div className="dialog-actions">
          <span className="hw-new-hint">{dragOver ? 'Drop to attach the worksheet' : ''}</span>
          <span className="grow" />
          <button className="btn is-secondary" onClick={close}>
            Cancel
          </button>
          <button className="btn is-primary hw-create" onClick={() => void create()} disabled={busy}>
            {busy && <span className="spinner is-light" />}
            Create
          </button>
        </div>
      </div>

      <Popover anchor={classBtn.current} open={classOpen} onClose={() => setClassOpen(false)} align="start" offset={4} className="menu-pop hw-pop">
        <div className="menu hw-class-menu" role="menu">
          {[...classes.map((c) => ({ path: c.path as string | null, name: c.name, color: c.color })), { path: null, name: 'No class', color: '' }].map((c) => (
            <button
              key={c.path ?? ''}
              className="menu-item"
              role="menuitemradio"
              aria-checked={classPath === c.path}
              onClick={() => {
                setClassPath(c.path);
                // Notes picked for the old class don't carry over: start again from the new class.
                setAnswers(null);
                setClassOpen(false);
              }}
            >
              {c.color ? <span className="class-square" style={{ background: c.color }} /> : <span className="class-square is-none" />}
              <span className="menu-label">{c.name}</span>
              {classPath === c.path && <Check size={16} strokeWidth={1.5} />}
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={dueBtn.current} open={dueOpen} onClose={() => setDueOpen(false)} align="start" offset={4} className="due-pop hw-pop">
        <DuePicker
          value={due}
          onDone={(d) => {
            setDue(d);
            setDueOpen(false);
          }}
        />
      </Popover>
      <NotePicker
        open={pickerOpen}
        classPath={classPath}
        initial={sel}
        query={draft}
        onClose={() => setPickerOpen(false)}
        onInsert={(s) => {
          setAnswers(s);
          setPickerOpen(false);
        }}
      />
    </Modal>
  );
}
