import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { NoteGrid } from './components/NoteGrid';
import { LibraryView } from './components/library/LibraryView';
import { ClassView } from './components/classes/ClassView';
import { ClassDialog } from './components/classes/ClassDialog';
import { HomeworkView } from './components/homework/HomeworkView';
import { NewHomeworkDialog } from './components/homework/NewHomeworkDialog';
import { LinkNotesDialog } from './components/homework/LinkNotesDialog';
import { AssistantPanel } from './components/ai/AssistantPanel';
import { CommandPalette } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { ContextMenuHost } from './components/common/ContextMenu';
import { DialogHost } from './components/common/dialogs';
import { Toasts, toast } from './components/common/toast';
import { NoteEditor } from './editor/NoteEditor';
import { SlashMenu } from './editor/ui/SlashMenu';
import { useVault } from './state/vault';
import { useUI } from './state/ui';
import { useAI } from './state/ai';
import { bridge, isElectron, isMac } from './lib/platform';
import { runCommand, handleGlobalKey } from './lib/keys';
import { importDropped } from './lib/import';
import { cx } from './lib/util';

export function App() {
  const ready = useVault((s) => s.ready);
  const error = useVault((s) => s.error);
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const { view, tabs, sidebar, assistant } = useUI();
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('is-mac', isMac);
    document.documentElement.classList.toggle('is-electron', isElectron);
    void useVault.getState().init();
    void useAI.getState().refresh();
    // Keep an eye on the local model server: reconnect on its own when it comes back.
    let beat: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const change = await useAI.getState().heartbeat();
      if (change === 'lost') toast.error('Local AI disconnected', 'Nib will reconnect automatically when the model server is back.');
      if (change === 'restored') toast.success('Local AI reconnected', useAI.getState().chatModel);
      beat = setTimeout(tick, useAI.getState().status === 'online' ? 30_000 : 10_000);
    };
    beat = setTimeout(tick, 10_000);
    const onUnload = () => useVault.getState().flush(true);
    window.addEventListener('beforeunload', onUnload);
    const off = bridge?.onMenu((cmd, arg) => runCommand(cmd, arg));
    window.addEventListener('keydown', handleGlobalKey, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('keydown', handleGlobalKey, true);
      clearTimeout(beat);
      off?.();
    };
  }, []);

  // Keep the open note in the tab strip; drop tabs whose note is gone.
  useEffect(() => {
    if (!ready) return;
    const ui = useUI.getState();
    const valid = ui.tabs.filter((id) => notes[id] && !notes[id].meta.trashed);
    const v = ui.view;
    // A class or folder page whose folder is gone (deleted, or renamed outside Nib) goes home.
    if ((v.kind === 'class' && folderMeta[v.path]?.kind !== 'class') || ((v.kind === 'class' || v.kind === 'folder') && !folders.includes(v.path)))
      ui.set({ view: { kind: 'home' } });
    if (ui.libraryScope.kind === 'folder' && !folders.includes(ui.libraryScope.path)) ui.set({ libraryScope: { kind: 'all' } });
    if (v.kind === 'note' && (!notes[v.id] || notes[v.id].meta.trashed)) ui.set({ view: { kind: 'home' }, tabs: valid });
    else if (v.kind === 'note' && !valid.includes(v.id)) ui.set({ tabs: [...valid, v.id] });
    else if (valid.length !== ui.tabs.length) ui.set({ tabs: valid });
  }, [ready, notes, folderMeta, folders]);

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-mark" />
      </div>
    );
  }

  const activeNote = view.kind === 'note' ? view.id : null;

  return (
    <div
      className={cx('app', !sidebar && 'no-sidebar', assistant && 'has-assistant', dropping && 'is-dropping')}
      onDragOver={(e) => {
        // Dialogs handle (or refuse) their own drops; never import behind an open dialog.
        if ((e.target as HTMLElement).closest('.modal-backdrop')) return;
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDropping(false);
      }}
      // Capture phase: pages that handle a drop themselves stop propagation, but the overlay must still go.
      onDropCapture={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if ((e.target as HTMLElement).closest('.modal-backdrop')) return;
        if (e.dataTransfer.files.length && !(e.target as HTMLElement).closest('.ProseMirror')) {
          e.preventDefault();
          void importDropped(e.dataTransfer.files);
        }
      }}
    >
      {sidebar && <Sidebar />}
      <main className="main">
        <TopBar />
        <div className="content">
          {error && <div className="vault-error">Couldn’t open the vault: {error}</div>}
          {view.kind === 'library' && <LibraryView />}
          {(view.kind === 'class' || (view.kind === 'folder' && folderMeta[view.path]?.kind === 'class')) && <ClassView key={view.path} path={view.path} />}
          {view.kind === 'homework' && <HomeworkView filter={view.filter} />}
          {(view.kind === 'home' ||
            view.kind === 'tag' ||
            view.kind === 'favorites' ||
            view.kind === 'recent' ||
            view.kind === 'trash' ||
            (view.kind === 'folder' && folderMeta[view.path]?.kind !== 'class')) && <NoteGrid view={view} />}
          {tabs
            .filter((id) => notes[id] && !notes[id].meta.trashed)
            .map((id) => (
              <NoteEditor key={id} noteId={id} active={activeNote === id} />
            ))}
        </div>
      </main>
      {assistant && <AssistantPanel />}
      <SlashMenu />
      <CommandPalette />
      <SettingsModal />
      <ClassDialog />
      <NewHomeworkDialog />
      <LinkNotesDialog />
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
