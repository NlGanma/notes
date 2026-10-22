import { create } from 'zustand';
import { useEffect, useRef, useState } from 'react';
import { Folder, FolderRoot } from 'lucide-react';
import { Modal } from './Modal';
import { Field } from './Field';
import { useVault } from '../../state/vault';
import { cx } from '../../lib/util';

type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve(v: boolean): void }
  | { kind: 'folder'; title: string; current: string; only?: string[]; action?: string; resolve(v: string | null): void }
  | { kind: 'prompt'; title: string; label: string; value: string; confirm: string; resolve(v: string | null): void };

interface DialogState {
  dialog: Dialog | null;
  open(d: Dialog): void;
  close(): void;
}

const useDialogs = create<DialogState>((set) => ({
  dialog: null,
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: null }),
}));

export function confirmDialog(opts: { title: string; message: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'confirm', confirm: opts.confirm ?? 'OK', ...opts, resolve }));
}

/** Google Drive's "New folder" / "Rename" dialog: one field, its text selected, Cancel and the action as text buttons. */
export function promptDialog(opts: { title: string; label: string; value?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'prompt', value: '', confirm: 'OK', ...opts, resolve }));
}

/** Picks a folder; `only` limits the choice (no "Top level" then), `action` names the button. */
export function pickFolder(title: string, current = '', opts: { only?: string[]; action?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'folder', title, current, ...opts, resolve }));
}

export function DialogHost() {
  const { dialog, close } = useDialogs();
  const folders = useVault((s) => s.folders);
  const [sel, setSel] = useState('');
  useEffect(() => {
    if (dialog?.kind === 'folder') setSel(dialog.current);
  }, [dialog]);
  if (!dialog) return null;
  const finish = (v: unknown) => {
    close();
    (dialog.resolve as (x: unknown) => void)(v);
  };
  if (dialog.kind === 'confirm') {
    return (
      <Modal open onClose={() => finish(false)} width={420} bare className="dialog">
        <div className="dialog-body">
          <div className="dialog-title">{dialog.title}</div>
          <div className="dialog-message">{dialog.message}</div>
        </div>
        <div className="dialog-actions">
          <button className="btn is-ghost" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className={cx('btn', dialog.danger ? 'is-danger-text' : 'is-ghost')} autoFocus onClick={() => finish(true)}>
            {dialog.confirm}
          </button>
        </div>
      </Modal>
    );
  }
  if (dialog.kind === 'prompt') return <PromptDialog key={dialog.title + dialog.value} dialog={dialog} finish={finish} />;
  return (
    <Modal open onClose={() => finish(null)} width={440} title={dialog.title} className="dialog">
      <div className="folder-pick">
        {!dialog.only && (
          <button className={cx('folder-pick-row', sel === '' && 'is-active')} onClick={() => setSel('')} onDoubleClick={() => finish('')}>
            <FolderRoot size={15} /> Top level
          </button>
        )}
        {(dialog.only ?? folders).map((f) => (
          <button
            key={f}
            className={cx('folder-pick-row', sel === f && 'is-active')}
            style={{ paddingLeft: 12 + (f.split('/').length - 1) * 16 }}
            onClick={() => setSel(f)}
            onDoubleClick={() => finish(f)}
          >
            <Folder size={15} /> {f.split('/').pop()}
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="btn is-ghost" onClick={() => finish(null)}>
          Cancel
        </button>
        <button className="btn is-ghost" disabled={!!dialog.only && !dialog.only.includes(sel)} onClick={() => finish(sel)}>
          {dialog.action ?? 'Move here'}
        </button>
      </div>
    </Modal>
  );
}

function PromptDialog({ dialog, finish }: { dialog: Extract<Dialog, { kind: 'prompt' }>; finish(v: string | null): void }) {
  const [value, setValue] = useState(dialog.value);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Drive selects the suggested name so typing replaces it.
  useEffect(() => input.current?.select(), []);
  const ok = !!value.trim();
  return (
    <Modal open onClose={() => finish(null)} width={400} bare className="dialog prompt-dialog">
      <form
        className="gdialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) finish(value.trim());
        }}
      >
        <h2 className="gdialog-title">{dialog.title}</h2>
        <div className="gdialog-fields">
          <Field label={dialog.label} value={value} onChange={setValue} autoFocus inputRef={input} />
        </div>
        <div className="gdialog-actions">
          <span className="grow" />
          <button type="button" className="btn is-ghost" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="btn is-ghost" disabled={!ok}>
            {dialog.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
