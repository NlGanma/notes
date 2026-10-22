import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { Bold, BookOpen, ClipboardList, FileText, Folder, Italic, Link2, List, Plus, RemoveFormatting, Underline, Upload, X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Field } from '../common/Field';
import { Popover } from '../common/Popover';
import { toast } from '../common/toast';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAI, visionModel } from '../../state/ai';
import { classForFolder, classInfo, HOMEWORK_SUBFOLDER, homeworkFolderFor, inFolder, listClasses } from '../../lib/classes';
import { createHomework } from '../../lib/commands';
import { homeworkSources } from '../../lib/homework';
import { pickFiles, scanToBlocks, SCAN_TYPES, type InFile } from '../../lib/import';
import { readScannedPages } from '../../lib/scan';
import type { NoteDoc } from '../../lib/vault/types';
import { cx, plural } from '../../lib/util';
import { DuePicker } from './DuePicker';
import { NotePicker } from './NotePicker';
import { editableToBlocks } from './richText';
import { folderName, summarize, type SourceSelection } from './sources';

type Scan = { file: InFile; status: 'importing' | 'ready' | 'failed'; blocks?: JSONContent[]; error?: string };

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');
const dueValue = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const withScheme = (url: string) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);

const FORMAT: { cmd: string; label: string; Icon: typeof Bold }[] = [
  { cmd: 'bold', label: 'Bold', Icon: Bold },
  { cmd: 'italic', label: 'Italic', Icon: Italic },
  { cmd: 'underline', label: 'Underline', Icon: Underline },
  { cmd: 'insertUnorderedList', label: 'Bulleted list', Icon: List },
  { cmd: 'removeFormat', label: 'Clear formatting', Icon: RemoveFormatting },
];

/** An attached item in the form: thumbnail, title, type line, remove. */
function AttachedRow({
  thumb,
  title,
  sub,
  error,
  onRemove,
  action,
}: {
  thumb: React.ReactNode;
  title: string;
  sub: string;
  error?: boolean;
  onRemove(): void;
  action?: React.ReactNode;
}) {
  return (
    <div className="hw-attached-row">
      <span className="hw-attached-thumb">{thumb}</span>
      <span className="hw-attached-text">
        <span className="hw-attached-title">{title}</span>
        <span className={cx('hw-attached-sub', error && 'is-error')}>{sub}</span>
      </span>
      {action}
      <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${title}`} title="Remove">
        <X size={20} />
      </button>
    </div>
  );
}

/**
 * New homework, as Google Classroom's full-window "Create assignment" form:
 * X, type icon and title in the app bar with Create at the right; Title and
 * Instructions, then Attach, on the left; For (class), Answers from, Due and
 * Unit in the right panel. A scanned worksheet (PDF or photo) becomes the
 * homework's pages; the notes it answers from default to the whole class.
 */
export function NewHomeworkDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'newHomework';
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const notes = useVault((s) => s.notes);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);

  const [classPath, setClassPath] = useState<string | null>(null);
  const [unit, setUnit] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [instr, setInstr] = useState('');
  const [instrFocus, setInstrFocus] = useState(false);
  const [due, setDue] = useState<number | undefined>(undefined);
  // null = the default (the whole class, or the chosen unit).
  const [answers, setAnswers] = useState<SourceSelection | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [blanks, setBlanks] = useState(0);
  const [links, setLinks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // Guards against a second Create while the first is still running (state updates lag a render).
  const busyRef = useRef(false);
  const scanPromise = useRef<Promise<JSONContent[]> | null>(null);
  const instrRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const dueBtn = useRef<HTMLButtonElement>(null);
  const splitBtn = useRef<HTMLButtonElement>(null);

  const importScan = (file: InFile) => {
    const p = scanToBlocks(file);
    scanPromise.current = p;
    setScan({ file, status: 'importing' });
    setTitle((t) => (t.trim() ? t : baseName(file.name)));
    p.then(
      (blocks) => scanPromise.current === p && setScan({ file, status: 'ready', blocks }),
      (e) => scanPromise.current === p && setScan({ file, status: 'failed', error: String((e as Error).message ?? e) }),
    );
  };
  const removeScan = () => {
    scanPromise.current = null;
    setScan(null);
  };

  const reset = (keepClass: boolean) => {
    if (!keepClass) {
      setClassPath(dialog?.kind === 'newHomework' ? (dialog.classPath ?? classes[0]?.path ?? null) : null);
      setUnit('');
      setDue(undefined);
    }
    setTitle('');
    setTitleTouched(false);
    setInstr('');
    if (instrRef.current) instrRef.current.innerHTML = '';
    setAnswers(null);
    removeScan();
    setBlanks(0);
    setLinks([]);
    setBusy(false);
    busyRef.current = false;
  };

  // Before the first paint, so the form never shows the previous homework for a moment.
  useLayoutEffect(() => {
    if (!open) return;
    reset(false);
    if (dialog.file) importScan(dialog.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chooseFile = async () => {
    const [f] = await pickFiles({ accept: SCAN_TYPES, multiple: false, title: 'Choose your homework' });
    if (f && !busyRef.current) importScan(f);
  };
  // The Homework page's "Homework from a scan…" opens the form, then asks it for the file.
  const chooseRef = useRef(chooseFile);
  chooseRef.current = chooseFile;
  useEffect(() => {
    const on = () => useUI.getState().dialog?.kind === 'newHomework' && void chooseRef.current();
    window.addEventListener('nib:homework-scan', on);
    return () => window.removeEventListener('nib:homework-scan', on);
  }, []);

  const units = useMemo(
    () =>
      classPath
        ? folders
            .filter((f) => f.startsWith(classPath + '/') && !f.slice(classPath.length + 1).includes('/') && f !== homeworkFolderFor(classPath))
            .map((f) => f.slice(classPath.length + 1))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        : [],
    [folders, classPath],
  );
  const cls = classes.find((c) => c.path === classPath) ?? null;
  const defaultSel: SourceSelection = { sources: [], folders: classPath ? [unit ? `${classPath}/${unit}` : classPath] : [] };
  const sel = answers ?? defaultSel;

  // The homework as it will be, for counting its notes and matching suggestions against.
  const draft = useMemo<NoteDoc>(
    () => ({
      version: 1,
      meta: { id: '', title, folder: homeworkFolderFor(classPath), tags: [], created: 0, updated: 0, homework: { ...sel } },
      content: { type: 'doc', content: [{ type: 'paragraph', content: instr.trim() ? [{ type: 'text', text: instr }] : [] }] },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, instr, classPath, answers, unit],
  );
  const sourceCount = useMemo(() => (open ? homeworkSources(draft, notes).length : 0), [open, draft, notes]);

  if (!open) return null;

  const dirty = !!(title.trim() || instr.trim() || scan || blanks || links.length || answers);
  const requestClose = () => {
    if (busy || dueOpen || splitOpen) return;
    if (dirty) setDiscarding(true);
    else useUI.getState().openDialog(null);
  };

  const answersLabel = sourceCount ? summarize(sel, notes, folderMeta) || plural(sourceCount, 'note') : classPath && !answers ? 'No notes yet' : 'Choose notes';
  const loose = sel.sources.map((id) => notes[id]).filter((n): n is NoteDoc => !!n && !n.meta.trashed && !sel.folders.some((f) => inFolder(n, f)));
  const clsName = (folder: string) => {
    const p = classForFolder(folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]).name : null;
  };

  const create = async (another = false) => {
    if (busyRef.current) return;
    const t = title.trim();
    if (!t) {
      setTitleTouched(true);
      titleRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const pages = scanPromise.current ? await scanPromise.current : [];
      const top = [
        ...(instrRef.current ? editableToBlocks(instrRef.current) : []),
        ...links.map((href) => ({ type: 'paragraph', content: [{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }] })),
      ];
      const content: JSONContent | undefined =
        top.length || pages.length
          ? {
              type: 'doc',
              content: [
                ...top,
                ...(pages.length ? pages : [{ type: 'paragraph' }]),
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My work' }] },
                { type: 'paragraph' },
              ],
            }
          : undefined;
      // Blank notes are made first, so the homework can link them.
      const blankIds = Array.from(
        { length: blanks },
        (_, i) => useVault.getState().createNote({ folder: classPath ?? '', title: `Notes for ${t}${blanks > 1 ? ` (${i + 1})` : ''}` }).meta.id,
      );
      const doc = createHomework({ classPath, title: t, due, content });
      const hw = useVault.getState().notes[doc.meta.id]?.meta.homework ?? { sources: [], folders: [] };
      useVault.getState().updateMeta(doc.meta.id, { homework: { ...hw, due, sources: [...sel.sources, ...blankIds], folders: sel.folders } });
      if (pages.length) {
        // Scans without a text layer are read by the vision model so the assistant knows the questions.
        const ai = useAI.getState();
        if (ai.status === 'online' && visionModel()) {
          toast.info('Reading your homework…', 'So the assistant can see the questions');
          readScannedPages(doc.meta.id, { priority: 'background' })
            .then((n) => n && toast.success('Homework read', `${plural(n, 'page')} — ask the assistant for help with any problem`))
            .catch(() => undefined);
        }
      }
      if (another) {
        reset(true);
        toast.success('Homework created', t);
        titleRef.current?.focus();
      } else useUI.getState().openDialog(null);
    } catch (e) {
      toast.error('Couldn’t create the homework', String((e as Error).message ?? e));
      busyRef.current = false;
      setBusy(false);
    }
  };

  const canCreate = !!title.trim() && !busy;
  const scanPages = scan?.blocks?.filter((b) => b.type === 'image') ?? [];

  return (
    <Modal open onClose={requestClose} width={0} bare className="hw-dialog hw-create">
      <div
        className={cx('hw-create-frame', dragOver && 'is-drop')}
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
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragOver(false)}
        onDrop={async (e) => {
          setDragOver(false);
          const f = [...e.dataTransfer.files].find((x) => SCAN_TYPES.includes(x.name.split('.').pop()?.toLowerCase() ?? ''));
          e.preventDefault();
          e.stopPropagation();
          if (f && !busyRef.current) importScan({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
          else if (!f && e.dataTransfer.files.length) toast.error('Not a worksheet', 'Drop a PDF or a photo (PNG, JPG).');
        }}
      >
        <header className="hw-appbar">
          <button className="icon-btn hw-appbar-close" onClick={requestClose} aria-label="Close">
            <X size={24} />
          </button>
          <span className="hw-appbar-icon">
            <ClipboardList size={20} />
          </span>
          <h1 className="hw-appbar-title">Homework</h1>
          <span className="grow" />
          {scan?.status === 'importing' && <span className="hw-appbar-status">Importing scan…</span>}
          <div className="hw-split">
            <button className="btn is-primary hw-create-btn" onClick={() => void create()} disabled={!canCreate}>
              {busy && <span className="spinner is-light" />}
              Create
            </button>
            <button
              ref={splitBtn}
              className="hw-split-arrow"
              onClick={() => setSplitOpen((v) => !v)}
              disabled={!canCreate}
              aria-label="More ways to create"
              aria-haspopup="menu"
            >
              <span className="hw-caret" />
            </button>
          </div>
        </header>

        <div className="hw-create-body">
          <div className="hw-form">
            <section className="hw-card">
              <Field
                className="hw-title"
                label="Title*"
                value={title}
                autoFocus
                inputRef={titleRef}
                helper="*Required"
                error={titleTouched && !title.trim() ? 'Title is required' : undefined}
                onChange={(v) => {
                  setTitle(v);
                  setTitleTouched(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
                }}
              />
              <div className={cx('hw-instr', !!instr.trim() && 'has-value', instrFocus && 'is-focused')}>
                <div
                  ref={instrRef}
                  className="hw-instr-input"
                  contentEditable={!busy}
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline
                  aria-labelledby="hw-instr-label"
                  onInput={(e) => setInstr(e.currentTarget.textContent ?? '')}
                  onFocus={() => setInstrFocus(true)}
                  onBlur={() => setInstrFocus(false)}
                  onPaste={(e) => {
                    // Plain text only: the page gets its own formatting.
                    e.preventDefault();
                    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
                  }}
                />
                <span className="hw-instr-label" id="hw-instr-label">
                  Instructions (optional)
                </span>
                <div className="hw-instr-tools">
                  {FORMAT.map(({ cmd, label, Icon }) => (
                    <button
                      key={cmd}
                      className="icon-btn"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (document.activeElement !== instrRef.current) instrRef.current?.focus();
                        document.execCommand(cmd);
                        setInstr(instrRef.current?.textContent ?? '');
                      }}
                      aria-label={label}
                      title={label}
                    >
                      <Icon size={20} />
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="hw-card">
              <h2 className="hw-card-title">Attach</h2>
              <div className="hw-attach-tiles">
                <button className="hw-attach-tile is-notes" onClick={() => setPickerOpen(true)}>
                  <span className="hw-attach-circle">
                    <FileText size={24} />
                  </span>
                  Notes
                </button>
                <button className="hw-attach-tile is-scan" onClick={() => void chooseFile()} disabled={busy}>
                  <span className="hw-attach-circle">
                    <Upload size={24} />
                  </span>
                  Scan
                </button>
                <button className="hw-attach-tile is-blank" onClick={() => setBlanks((n) => n + 1)}>
                  <span className="hw-attach-circle">
                    <Plus size={24} />
                  </span>
                  Blank note
                </button>
                <button className="hw-attach-tile is-link" onClick={() => setLinkDraft('')}>
                  <span className="hw-attach-circle">
                    <Link2 size={24} />
                  </span>
                  Link
                </button>
              </div>
              {(sel.folders.length > 0 || loose.length > 0 || scan || blanks > 0 || links.length > 0) && (
                <div className="hw-attached">
                  {scan && (
                    <AttachedRow
                      thumb={
                        scan.status === 'importing' ? (
                          <span className="spinner" />
                        ) : scanPages[0]?.attrs?.src ? (
                          <img src={String(scanPages[0].attrs.src)} alt="" />
                        ) : (
                          <Upload size={24} />
                        )
                      }
                      title={scan.file.name}
                      sub={
                        scan.status === 'importing'
                          ? 'Importing…'
                          : scan.status === 'failed'
                            ? 'Couldn’t import this file'
                            : `Scan · ${plural(scanPages.length, 'page')}`
                      }
                      error={scan.status === 'failed'}
                      action={
                        scan.status === 'failed' && (
                          <button className="btn is-ghost" onClick={() => importScan(scan.file)}>
                            Try again
                          </button>
                        )
                      }
                      onRemove={removeScan}
                    />
                  )}
                  {sel.folders.map((f) => (
                    <AttachedRow
                      key={f}
                      thumb={<Folder size={24} />}
                      title={`All ${folderName(f, folderMeta)} notes`}
                      sub={`Folder · ${plural(Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && inFolder(n, f) && !n.meta.folder.split('/').includes(HOMEWORK_SUBFOLDER)).length, 'note')}, and new ones`}
                      onRemove={() => setAnswers({ ...sel, folders: sel.folders.filter((x) => x !== f) })}
                    />
                  ))}
                  {loose.map((n) => (
                    <AttachedRow
                      key={n.meta.id}
                      thumb={<FileText size={24} />}
                      title={n.meta.title || 'Untitled'}
                      sub={clsName(n.meta.folder) ? `Note · ${clsName(n.meta.folder)}` : 'Note'}
                      onRemove={() => setAnswers({ ...sel, sources: sel.sources.filter((x) => x !== n.meta.id) })}
                    />
                  ))}
                  {Array.from({ length: blanks }, (_, i) => (
                    <AttachedRow
                      key={`blank${i}`}
                      thumb={<Plus size={24} />}
                      title={`Notes for ${title.trim() || 'this homework'}${blanks > 1 ? ` (${i + 1})` : ''}`}
                      sub={cls ? `New note in ${cls.name}` : 'New note'}
                      onRemove={() => setBlanks((n) => n - 1)}
                    />
                  ))}
                  {links.map((href) => (
                    <AttachedRow
                      key={href}
                      thumb={<Link2 size={24} />}
                      title={href.replace(/^https?:\/\//, '')}
                      sub="Link"
                      onRemove={() => setLinks(links.filter((l) => l !== href))}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="hw-side">
            <div className="hw-side-group">
              <div className="hw-side-label">For</div>
              <label className="hw-select hw-for">
                {cls && <span className="hw-select-dot" style={{ background: cls.theme.main }} />}
                <select
                  value={classPath ?? ''}
                  onChange={(e) => {
                    setClassPath(e.target.value || null);
                    setUnit('');
                    // Picked notes belonged to the old class's choice; start again from the new class.
                    setAnswers(null);
                  }}
                  aria-label="For"
                >
                  {classes.map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.name}
                    </option>
                  ))}
                  <option value="">No class</option>
                </select>
              </label>
            </div>
            <div className="hw-side-group">
              <div className="hw-side-label">Answers from</div>
              <button className="hw-answers" onClick={() => setPickerOpen(true)}>
                <BookOpen size={18} />
                <span>{answersLabel}</span>
              </button>
            </div>
            <div className="hw-side-group">
              <div className="hw-side-label">Due</div>
              <button ref={dueBtn} className="hw-select hw-due-select" onClick={() => setDueOpen((v) => !v)} aria-haspopup="dialog">
                {due ? dueValue(due) : 'No due date'}
              </button>
            </div>
            <div className="hw-side-group">
              <div className="hw-side-label">Unit</div>
              <label className={cx('hw-select is-filled hw-unit', !classPath && 'is-disabled')}>
                <select value={unit} disabled={!classPath} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
                  <option value="">No unit</option>
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </aside>
        </div>
        {dragOver && <div className="hw-drop">Drop to attach this scan</div>}
      </div>

      <Popover anchor={dueBtn.current} open={dueOpen} onClose={() => setDueOpen(false)} align="start" offset={4} className="hw-pop">
        <DuePicker
          value={due}
          onDone={(d) => {
            setDue(d);
            setDueOpen(false);
          }}
        />
      </Popover>
      <Popover anchor={splitBtn.current} open={splitOpen} onClose={() => setSplitOpen(false)} align="end" offset={4} className="menu-pop hw-pop">
        <div className="menu" role="menu">
          <button
            className="menu-item"
            onClick={() => {
              setSplitOpen(false);
              void create();
            }}
          >
            <span className="menu-label">Create</span>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setSplitOpen(false);
              void create(true);
            }}
          >
            <span className="menu-label">Create and add another</span>
          </button>
        </div>
      </Popover>

      <NotePicker
        open={pickerOpen}
        title={title.trim() ? `Link notes to “${title.trim()}”` : 'Link notes'}
        classPath={classPath}
        initial={sel}
        query={draft}
        onClose={() => setPickerOpen(false)}
        onInsert={(s) => {
          setAnswers(s);
          setPickerOpen(false);
        }}
      />
      <Modal open={linkDraft !== null} onClose={() => setLinkDraft(null)} width={456} bare className="hw-small-dialog">
        <form
          className="gdialog"
          onSubmit={(e) => {
            e.preventDefault();
            const url = (linkDraft ?? '').trim();
            if (url) setLinks((l) => (l.includes(withScheme(url)) ? l : [...l, withScheme(url)]));
            setLinkDraft(null);
          }}
        >
          <h2 className="gdialog-title">Add link</h2>
          <Field label="Link" value={linkDraft ?? ''} onChange={setLinkDraft} autoFocus />
          <div className="gdialog-actions">
            <button type="button" className="btn is-ghost" onClick={() => setLinkDraft(null)}>
              Cancel
            </button>
            <button type="submit" className="btn is-ghost" disabled={!linkDraft?.trim()}>
              Add link
            </button>
          </div>
        </form>
      </Modal>
      <Modal open={discarding} onClose={() => setDiscarding(false)} width={312} bare className="hw-small-dialog">
        <div className="gdialog">
          <h2 className="gdialog-title">Discard homework?</h2>
          <div className="gdialog-actions">
            <button className="btn is-ghost" onClick={() => setDiscarding(false)}>
              Cancel
            </button>
            <button
              className="btn is-ghost"
              autoFocus
              onClick={() => {
                setDiscarding(false);
                useUI.getState().openDialog(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}
