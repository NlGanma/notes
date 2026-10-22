import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import { useAssistant } from '../state/assistant';
import { editors } from '../editor/registry';
import { bridge, isElectron } from './platform';
import { toast } from '../components/common/toast';
import { classForFolder, homeworkFolderFor } from './classes';
import { isReviewable } from './review/tree';
import type { Scope } from './ai/rag';
import type { JSONContent } from '@tiptap/core';

/** App-wide commands, shared by the native menu, keyboard shortcuts and ⌘K. */

export function currentNoteId(): string | null {
  const v = useUI.getState().view;
  return v.kind === 'note' ? v.id : null;
}

export function currentFolder(): string {
  const v = useUI.getState().view;
  if (v.kind === 'folder' || v.kind === 'class') return v.path;
  if (v.kind === 'note') {
    const n = useVault.getState().notes[v.id];
    if (!n) return '';
    // New notes made while doing homework belong with the class's notes, not in Homework/.
    if (n.meta.homework) return classForFolder(n.meta.folder, useVault.getState().folderMeta) ?? '';
    return n.meta.folder;
  }
  return '';
}

/** The class the user is looking at (a class page, or a note or folder inside a class). */
export function currentClass(): string | null {
  const v = useUI.getState().view;
  const { notes, folderMeta } = useVault.getState();
  if (v.kind === 'class') return v.path;
  if (v.kind === 'folder') return classForFolder(v.path, folderMeta);
  if (v.kind === 'note') return classForFolder(notes[v.id]?.meta.folder ?? '', folderMeta);
  return null;
}

export function newNote(folder = currentFolder(), opts: { newTab?: boolean } = {}) {
  // Notes never land inside a Homework folder by accident.
  const fm = useVault.getState().folderMeta;
  const cls = classForFolder(folder, fm);
  if (cls && (folder === homeworkFolderFor(cls) || folder.startsWith(homeworkFolderFor(cls) + '/'))) folder = cls;
  const doc = useVault.getState().createNote({ folder });
  useUI.getState().openNote(doc.meta.id, { newTab: opts.newTab ?? true, focusTitle: true });
  return doc;
}

export function newClass() {
  useUI.getState().openDialog({ kind: 'class', path: null });
}

export function editClass(path: string) {
  useUI.getState().openDialog({ kind: 'class', path });
}

/** Opens the "New homework" sheet, for the current class unless one is given. */
export function newHomework(classPath: string | null = currentClass(), file?: { name: string; bytes: Uint8Array }) {
  useUI.getState().openDialog({ kind: 'newHomework', classPath, file });
}

/**
 * Creates a homework assignment. By default its sources are all of its
 * class's notes; the student can narrow that to specific lectures.
 */
export function createHomework(opts: { classPath: string | null; title: string; due?: number; content?: JSONContent; sources?: string[] }) {
  const folder = homeworkFolderFor(opts.classPath);
  const vault = useVault.getState();
  const doc = vault.createNote({
    folder,
    title: opts.title,
    content: opts.content ?? {
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My work' }] }, { type: 'paragraph' }],
    },
  });
  vault.updateMeta(doc.meta.id, {
    homework: { sources: opts.sources ?? [], folders: opts.sources?.length ? [] : opts.classPath ? [opts.classPath] : [], due: opts.due },
  });
  if (opts.classPath) useUI.getState().toggleFolder(opts.classPath, true);
  useUI.getState().toggleFolder(folder, true);
  useUI.getState().openNote(doc.meta.id, { newTab: true, focusTitle: !opts.title });
  return doc;
}

export function linkNotes(noteId: string) {
  useUI.getState().openDialog({ kind: 'linkNotes', noteId });
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

export function openLibrary(scope?: Scope) {
  const ui = useUI.getState();
  ui.set({ view: { kind: 'library' }, ...(scope ? { libraryScope: scope } : {}) });
}

export function openClass(path: string) {
  useUI.getState().setView({ kind: 'class', path });
  useUI.getState().toggleFolder(path, true);
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

/** Opens Review, optionally with these notes picked. */
export function openReview(noteIds?: string[]) {
  useUI.getState().setView({ kind: 'review', preset: noteIds });
}

/** Review every reviewable note in a folder or class (its chapters included). */
export function reviewFolder(path: string) {
  const { notes } = useVault.getState();
  const ids = Object.values(notes)
    .filter((n) => isReviewable(n) && (n.meta.folder === path || n.meta.folder.startsWith(`${path}/`)))
    .map((n) => n.meta.id);
  openReview(ids);
}

export function reviewNote(id: string) {
  openReview([id]);
}
