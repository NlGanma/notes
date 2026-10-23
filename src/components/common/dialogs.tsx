import { create } from 'zustand';
import { useEffect, useRef, useState } from 'react';
import { Folder, FolderRoot } from 'lucide-react';
import { Modal } from './Modal';
import { useVault } from '../../state/vault';
import { classInfo } from '../../lib/classes';
import { cx } from '../../lib/util';

type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve(v: boolean): void }
  | { kind: 'folder'; title: string; current: string; only?: string[]; exclude?: string[]; action?: string; resolve(v: string | null): void }
  | { kind: 'prompt'; title: string; label: string; value: string; placeholder?: string; confirm: string; allowEmpty?: boolean; resolve(v: string | null): void };

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

/**
 * One field under a title (New folder, Rename), its text selected so typing replaces it. The button is
 * never greyed out: an empty answer falls back to what was there (or, with `allowEmpty`, comes back empty).
 */
export function promptDialog(opts: { title: string; label: string; value?: string; placeholder?: string; confirm?: string; allowEmpty?: boolean }): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'prompt', value: '', confirm: 'OK', ...opts, resolve }));
}

/** Picks a folder; `only` limits the choice (no top level then), `exclude` hides folders and what's in them. */
export function pickFolder(title: string, current = '', opts: { only?: string[]; exclude?: string[]; action?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'folder', title, current, ...opts, resolve }));
}

export function DialogHost() {
  const { dialog, close } = useDialogs();
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
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
      <Modal open onClose={() => finish(false)} width={400} bare className="dialog">
        <div className="dialog-body">
          <div className="dialog-title">{dialog.title}</div>
          <div className="dialog-message">{dialog.message}</div>
        </div>
        <div className="dialog-actions">
          <button className="btn is-secondary" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className={cx('btn', dialog.danger ? 'is-danger' : 'is-primary')} autoFocus onClick={() => finish(true)}>
            {dialog.confirm}
          </button>
        </div>
      </Modal>
    );
  }
  if (dialog.kind === 'prompt') return <PromptDialog key={dialog.title + dialog.value} dialog={dialog} finish={finish} />;
  const hidden = (f: string) => !!dialog.exclude?.some((x) => f === x || f.startsWith(x + '/'));
  const list = (dialog.only ?? folders).filter((f) => !hidden(f));
  return (
    <Modal open onClose={() => finish(null)} width={420} bare className="dialog">
      {/* Like every small dialog: a title, the choice, Cancel and the action (Esc closes it too), no ×. */}
      <div className="dialog-body folder-pick-head">
        <div className="dialog-title">{dialog.title}</div>
      </div>
      <div className="folder-pick">
        {!dialog.only && (
          <button className={cx('folder-pick-row', sel === '' && 'is-active')} onClick={() => setSel('')} onDoubleClick={() => finish('')}>
            <FolderRoot size={16} strokeWidth={1.5} /> No folder
          </button>
        )}
        {list.map((f) => {
          const cls = folderMeta[f]?.kind === 'class' ? classInfo(f, folderMeta[f]) : null;
          return (
            <button
              key={f}
              className={cx('folder-pick-row', sel === f && 'is-active')}
              style={{ paddingLeft: 10 + (f.split('/').length - 1) * 18 }}
              onClick={() => setSel(f)}
              onDoubleClick={() => finish(f)}
              title={f}
            >
              {cls ? <span className="class-square" style={{ background: cls.color }} /> : <Folder size={16} strokeWidth={1.5} />}
              <span className="folder-pick-name">{f.split('/').pop()}</span>
            </button>
          );
        })}
      </div>
      <div className="dialog-actions">
        <button className="btn is-secondary" onClick={() => finish(null)}>
          Cancel
        </button>
        <button className="btn is-primary" disabled={!!dialog.only && !dialog.only.includes(sel)} onClick={() => finish(sel)}>
          {dialog.action ?? 'Move'}
        </button>
      </div>
    </Modal>
  );
}

function PromptDialog({ dialog, finish }: { dialog: Extract<Dialog, { kind: 'prompt' }>; finish(v: string | null): void }) {
  const [value, setValue] = useState(dialog.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const submit = () => {
    const v = value.replace(/\s+/g, ' ').trim();
    finish(v || (dialog.allowEmpty ? '' : dialog.value.trim() || null));
  };
  return (
    <Modal open onClose={() => finish(null)} width={400} bare className="dialog prompt-dialog">
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="dialog-body">
          <div className="dialog-title">{dialog.title}</div>
          <input
            ref={input}
            className="input"
            value={value}
            aria-label={dialog.label}
            placeholder={dialog.placeholder ?? dialog.label}
            maxLength={100}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn is-secondary" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary">
            {dialog.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
