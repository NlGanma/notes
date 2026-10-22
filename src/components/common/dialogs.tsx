import { create } from 'zustand';
import { useEffect, useState } from 'react';
import { Folder, FolderRoot } from 'lucide-react';
import { Modal } from './Modal';
import { useVault } from '../../state/vault';
import { cx } from '../../lib/util';

type Dialog =
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve(v: boolean): void }
  | { kind: 'folder'; title: string; current: string; resolve(v: string | null): void };

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

export function pickFolder(title: string, current = ''): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().open({ kind: 'folder', title, current, resolve }));
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
          <button className={cx('btn', dialog.danger ? 'is-danger' : 'is-primary')} autoFocus onClick={() => finish(true)}>
            {dialog.confirm}
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={() => finish(null)} width={440} title={dialog.title} className="dialog">
      <div className="folder-pick">
        <button className={cx('folder-pick-row', sel === '' && 'is-active')} onClick={() => setSel('')} onDoubleClick={() => finish('')}>
          <FolderRoot size={15} /> Top level
        </button>
        {folders.map((f) => (
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
        <button className="btn is-primary" onClick={() => finish(sel)}>
          Move here
        </button>
      </div>
    </Modal>
  );
}
