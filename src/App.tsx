import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { NoteGrid } from './components/NoteGrid';
import { LibraryView } from './components/library/LibraryView';
import { AssistantPanel } from './components/ai/AssistantPanel';
import { CommandPalette } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { ContextMenuHost } from './components/common/ContextMenu';
import { DialogHost } from './components/common/dialogs';
import { Toasts } from './components/common/toast';
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
  const { view, tabs, sidebar, assistant } = useUI();
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('is-mac', isMac);
    document.documentElement.classList.toggle('is-electron', isElectron);
    void useVault.getState().init();
    void useAI.getState().refresh();
    const onUnload = () => useVault.getState().flush(true);
    window.addEventListener('beforeunload', onUnload);
    const off = bridge?.onMenu((cmd, arg) => runCommand(cmd, arg));
    window.addEventListener('keydown', handleGlobalKey, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('keydown', handleGlobalKey, true);
      off?.();
    };
  }, []);

  // Keep the open note in the tab strip; drop tabs whose note is gone.
  useEffect(() => {
    if (!ready) return;
    const ui = useUI.getState();
    const valid = ui.tabs.filter((id) => notes[id] && !notes[id].meta.trashed);
    const v = ui.view;
    if (v.kind === 'note' && (!notes[v.id] || notes[v.id].meta.trashed)) ui.set({ view: { kind: 'home' }, tabs: valid });
    else if (v.kind === 'note' && !valid.includes(v.id)) ui.set({ tabs: [...valid, v.id] });
    else if (valid.length !== ui.tabs.length) ui.set({ tabs: valid });
  }, [ready, notes]);

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
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
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
          {view.kind !== 'note' && view.kind !== 'library' && <NoteGrid view={view} />}
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
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
