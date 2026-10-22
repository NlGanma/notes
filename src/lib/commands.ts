import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import { useAssistant } from '../state/assistant';
import { editors } from '../editor/registry';
import { bridge, isElectron } from './platform';
import { toast } from '../components/common/toast';

/** App-wide commands, shared by the native menu, keyboard shortcuts and ⌘K. */

export function currentNoteId(): string | null {
  const v = useUI.getState().view;
  return v.kind === 'note' ? v.id : null;
}

export function currentFolder(): string {
  const v = useUI.getState().view;
  if (v.kind === 'folder') return v.path;
  if (v.kind === 'note') return useVault.getState().notes[v.id]?.meta.folder ?? '';
  return '';
}

export function newNote(folder = currentFolder(), opts: { newTab?: boolean } = {}) {
  const doc = useVault.getState().createNote({ folder });
  useUI.getState().openNote(doc.meta.id, { newTab: opts.newTab ?? true, focusTitle: true });
  return doc;
}

export async function newFolder(parent = currentFolder()) {
  const path = await useVault.getState().createFolder(`${parent ? parent + '/' : ''}New folder`);
  const ui = useUI.getState();
  if (parent) ui.toggleFolder(parent, true);
  ui.set({ renaming: `folder:${path}` });
  return path;
}

export function toggleAssistant(force?: boolean) {
  const ui = useUI.getState();
  const next = force ?? !ui.assistant;
  ui.setAssistant(next);
  if (next) useAssistant.getState().focus();
}

export function openLibrary() {
  useUI.getState().setView({ kind: 'library' });
}

export function undo() {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    document.execCommand('undo');
    return;
  }
  const id = currentNoteId();
  const ed = id ? editors.get(id) : null;
  ed?.chain().undo().run();
}

export function redo() {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    document.execCommand('redo');
    return;
  }
  const id = currentNoteId();
  const ed = id ? editors.get(id) : null;
  ed?.chain().redo().run();
}

export function zoom(dir: 'in' | 'out' | 'reset') {
  const ui = useUI.getState();
  if (dir === 'reset') ui.setZoom(1);
  else ui.setZoom(ui.zoom * (dir === 'in' ? 1.1 : 1 / 1.1));
}

export function closeCurrentTab() {
  const id = currentNoteId();
  if (id) useUI.getState().closeTab(id);
}

export function revealCurrent() {
  const id = currentNoteId();
  const backend = useVault.getState().backend;
  if (id && backend?.reveal) backend.reveal(id);
  else if (!isElectron) toast.info('Available in the Mac app', 'In the browser, notes are stored in this browser’s storage.');
}

export async function openVaultFolder() {
  if (!bridge) {
    toast.info('Available in the Mac app', 'The browser version stores notes in this browser.');
    return;
  }
  const root = await bridge.vault.choose();
  if (!root) return;
  useVault.getState().flush(true);
  localStorage.setItem('nib.vaultRoot', root);
  useUI.getState().set({ tabs: [], view: { kind: 'home' } });
  useVault.setState({ notes: {}, folders: [], folderMeta: {}, ready: false });
  await useVault.getState().init(root);
  toast.success('Vault opened', root);
}
