import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileUp, PenLine, ScanText, X } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { Modal } from '../common/Modal';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAI, visionModel } from '../../state/ai';
import { classNotes, listClasses } from '../../lib/classes';
import { createHomework } from '../../lib/commands';
import { pickFiles, scanToBlocks, SCAN_TYPES, type InFile } from '../../lib/import';
import { readScannedPages } from '../../lib/scan';
import { ClassBadge } from '../classes/ClassIcon';
import { cx, plural } from '../../lib/util';
import { toast } from '../common/toast';

function toDateInput(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDateInput(s: string): number | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59).getTime();
}

/**
 * New homework: a blank page to write the problems on, or a scanned
 * worksheet. It lives in the class's Homework folder and, by default, uses
 * the class's notes as its only sources.
 */
export function NewHomeworkDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'newHomework';
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const notes = useVault((s) => s.notes);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);

  const [classPath, setClassPath] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [start, setStart] = useState<'blank' | 'scan'>('blank');
  const [file, setFile] = useState<InFile | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a second Enter while the first import is still running (state updates lag a render).
  const busyRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  // Before the first paint, so the dialog never shows the previous class picked for a moment.
  useLayoutEffect(() => {
    if (!open) return;
    setClassPath(dialog.classPath ?? classes[0]?.path ?? null);
    setFile(dialog.file ?? null);
    setStart(dialog.file ? 'scan' : 'blank');
    setTitle(dialog.file ? dialog.file.name.replace(/\.[^.]+$/, '') : '');
    setDue(toDateInput(Date.now() + 7 * 86_400_000));
    setBusy(false);
    busyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const close = () => !busy && useUI.getState().openDialog(null);
  const cls = classes.find((c) => c.path === classPath) ?? null;
  const sourceCount = classPath ? classNotes(classPath, notes).length : 0;
  const hasVision = !!visionModel(useAI.getState());

  const takeFile = (f: InFile) => {
    setFile(f);
    setStart('scan');
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const chooseFile = async () => {
    const [f] = await pickFiles({ accept: SCAN_TYPES, multiple: false, title: 'Choose your homework' });
    if (f) takeFile(f);
  };

  const create = async () => {
    if (busyRef.current) return;
    if (start === 'scan' && !file) {
      void chooseFile();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      let content: JSONContent | undefined;
      if (start === 'scan' && file) {
        const pages = await scanToBlocks(file);
        content = {
          type: 'doc',
          content: [...pages, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My work' }] }, { type: 'paragraph' }],
        };
      }
      busyRef.current = false;
      setBusy(false);
      const doc = createHomework({ classPath, title: title.trim() || (start === 'scan' ? 'Scanned homework' : ''), due: fromDateInput(due), content });
      useUI.getState().openDialog(null);
      if (start === 'scan') {
        // Scans without a text layer are read by the vision model so the assistant knows the questions.
        const ai = useAI.getState();
        if (ai.status === 'online' && visionModel()) {
          const id = toast.info('Reading your homework…', 'So the assistant can see the questions');
          readScannedPages(doc.meta.id, { priority: 'background' })
            .then((n) => n && toast.success('Homework read', `${plural(n, 'page')} — ask the assistant for help with any problem`))
            .catch(() => undefined)
            .finally(() => void id);
        }
      }
    } catch (e) {
      toast.error('Couldn’t create the homework', String((e as Error).message ?? e));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} width={560} title="New homework" className="hw-dialog">
      <div
        className={cx('hw-form', dragOver && 'is-drop')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
        onDrop={async (e) => {
          setDragOver(false);
          const f = [...e.dataTransfer.files].find((x) => SCAN_TYPES.includes(x.name.split('.').pop()?.toLowerCase() ?? ''));
          e.preventDefault();
          e.stopPropagation();
          if (f && !busyRef.current) takeFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
          else if (!f && e.dataTransfer.files.length) toast.error('Not a worksheet', 'Drop a PDF or a photo (PNG, JPG).');
        }}
      >
        <div className="hw-field">
          <span className="hw-label">Class</span>
          <div className="class-chips">
            {classes.map((c) => (
              <button
                key={c.path}
                className={cx('class-chip', c.path === classPath && 'is-active')}
                style={{ ['--class' as string]: c.color }}
                onClick={() => setClassPath(c.path)}
              >
                <ClassBadge cls={c} size={18} />
                {c.name}
              </button>
            ))}
            <button className={cx('class-chip', classPath === null && 'is-active')} onClick={() => setClassPath(null)}>
              No class
            </button>
          </div>
        </div>
        <div className="hw-row">
          <label className="hw-field grow">
            <span className="hw-label">Title</span>
            <input
              className="input"
              autoFocus
              placeholder={start === 'scan' ? 'Problem Set 5' : 'e.g. Problem Set 5, §2.3 #1–15'}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
              }}
            />
          </label>
          <label className="hw-field hw-due">
            <span className="hw-label">Due</span>
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <div className="hw-field">
          <span className="hw-label">Start with</span>
          <div className="hw-starts">
            <button className={cx('hw-start', start === 'blank' && 'is-active')} onClick={() => setStart('blank')}>
              <PenLine size={20} />
              <span className="hw-start-title">Blank page</span>
              <span className="hw-start-sub">Write or type the problems and your work</span>
            </button>
            <button className={cx('hw-start', start === 'scan' && 'is-active')} onClick={() => (file ? setStart('scan') : void chooseFile())}>
              <ScanText size={20} />
              <span className="hw-start-title">Scanned worksheet</span>
              <span className="hw-start-sub">{file ? file.name : 'A PDF or photo — write right on the pages'}</span>
              {file && (
                <span
                  className="hw-start-clear"
                  role="button"
                  aria-label="Remove file"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                    setStart('blank');
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          </div>
          {start === 'scan' && !hasVision && (
            <div className="hw-note">Tip: with a vision model (e.g. qwen2.5vl) Nib reads scanned pages so the assistant can see the questions.</div>
          )}
        </div>
        <div className="hw-sources-note">
          {cls ? (
            <>
              <b>Answers will come only from your {cls.name} notes</b> ({plural(sourceCount, 'note')}). You can narrow this to specific lectures once it’s
              created.
            </>
          ) : (
            <>Pick which notes the assistant may use once it’s created. Anything not in them is clearly marked.</>
          )}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="btn is-ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn is-primary" onClick={() => void create()} disabled={busy}>
          {busy ? (
            <>
              <span className="spinner is-light" /> Importing…
            </>
          ) : start === 'scan' && !file ? (
            <>
              <FileUp size={15} /> Choose file…
            </>
          ) : (
            'Create homework'
          )}
        </button>
      </div>
    </Modal>
  );
}
