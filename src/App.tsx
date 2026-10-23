import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainBar } from './components/MainBar';
import { NotesPage } from './components/NoteGrid';
import { LibraryView } from './components/library/LibraryView';
import { ClassView } from './components/classes/ClassView';
import { ClassesView } from './components/classes/ClassesView';
import { ClassDialog, CustomizeDialog } from './components/classes/ClassDialog';
import { HomeworkView } from './components/homework/HomeworkView';
import { ReviewView } from './components/review/ReviewView';
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
import { NARROW, useUI } from './state/ui';
import { useAI } from './state/ai';
import { flushReview, useReview } from './state/review';
import { bridge, isElectron, isMac } from './lib/platform';
import { runCommand, handleGlobalKey } from './lib/keys';
import { importDropped } from './lib/import';
import { displayTitle } from './lib/displayTitle';
import { cx } from './lib/util';

/** True while the window is narrower than the query's width. */
function useNarrow(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

const KNOWN = new Set(['classes', 'home', 'note', 'folder', 'trash', 'library', 'class', 'homework', 'review']);

export function App() {
  const ready = useVault((s) => s.ready);
  const error = useVault((s) => s.error);
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const backend = useVault((s) => s.backend);
  const { view, tabs, sidebar, assistant } = useUI();
  const [dropping, setDropping] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // Under 900px the sidebar starts hidden and, when shown, floats over the page.
  const narrow = useNarrow(NARROW);

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
    const onUnload = () => {
      useVault.getState().flush(true);
      flushReview(true);
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    const off = bridge?.onMenu((cmd, arg) => runCommand(cmd, arg));
    window.addEventListener('keydown', handleGlobalKey, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('keydown', handleGlobalKey, true);
      clearTimeout(beat);
      off?.();
    };
  }, []);

  // The vault's review file is read as soon as the vault is open (what's due shows with the sidebar
  // hidden too), and read again — nothing of the last vault's kept — when another vault is opened.
  useEffect(() => {
    if (backend) void useReview.getState().load();
  }, [backend]);

  // The window title names the open note, so Mission Control and the Window menu can tell windows apart.
  const openTitle = view.kind === 'note' && notes[view.id] ? displayTitle(notes[view.id]) : null;
  useEffect(() => {
    document.title = openTitle ? `${openTitle} — Nib` : 'Nib';
  }, [openTitle]);

  // Keep the open note in the tab strip; drop tabs whose note is gone.
  useEffect(() => {
    if (!ready) return;
    const ui = useUI.getState();
    const valid = ui.tabs.filter((id) => notes[id] && !notes[id].meta.trashed);
    const v = ui.view;
    // A class or folder page whose folder is gone (deleted, or renamed outside Nib) goes home.
    if ((v.kind === 'class' && folderMeta[v.path]?.kind !== 'class') || ((v.kind === 'class' || v.kind === 'folder') && !folders.includes(v.path)))
      ui.set({ view: { kind: 'classes' } });
    if (ui.libraryScope.kind === 'folder' && !folders.includes(ui.libraryScope.path)) ui.set({ libraryScope: { kind: 'all' } });
    if (v.kind === 'note' && (!notes[v.id] || notes[v.id].meta.trashed)) ui.set({ view: { kind: 'classes' }, tabs: valid });
    else if (v.kind === 'note' && !valid.includes(v.id)) ui.set({ tabs: [...valid, v.id] });
    else if (valid.length !== ui.tabs.length) ui.set({ tabs: valid });
  }, [ready, notes, folderMeta, folders]);

  // A window that gets narrow puts the sidebar away; widening it again brings it back.
  useEffect(() => {
    const ui = useUI.getState();
    if (narrow && ui.sidebar) ui.set({ sidebar: false, sidebarAuto: true });
    else if (!narrow && ui.sidebarAuto) ui.set({ sidebar: true, sidebarAuto: false });
  }, [narrow]);

  // The assistant needs room: when it would leave the page under 760px, the sidebar steps aside, and
  // comes back when the assistant closes (only if it was put away for the room, not by hand).
  const crowded = assistant && view.kind === 'note';
  useEffect(() => {
    const ui = useUI.getState();
    if (!ready || narrow) return;
    if (crowded && ui.sidebar) {
      const panel = document.querySelector('.assistant')?.getBoundingClientRect().width ?? 400;
      const sidebarW = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 272;
      if (window.innerWidth - sidebarW - panel < 760) ui.set({ sidebar: false, sidebarAuto: true });
    } else if (!crowded && ui.sidebarAuto) ui.set({ sidebar: true, sidebarAuto: false });
  }, [crowded, narrow, ready]);

  // The floating sidebar goes away on a click outside it, on Esc, and when a page is picked.
  const overlay = narrow && sidebar;
  useEffect(() => {
    if (!overlay) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sidebar, .popover, .context-menu, .modal-backdrop, .mainbar-show')) return;
      useUI.getState().set({ sidebar: false });
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useUI.getState().set({ sidebar: false });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [overlay]);
  const viewKey = JSON.stringify(view);
  useEffect(() => {
    if (useUI.getState().sidebar && window.matchMedia(NARROW).matches) useUI.getState().set({ sidebar: false });
    setScrolled(false);
  }, [viewKey]);

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-mark" />
      </div>
    );
  }

  const activeNote = view.kind === 'note' ? view.id : null;
  // The assistant answers about the open note; elsewhere it could only say "Open a note" (Ask your notes has its own).
  const showAssistant = assistant && !!activeNote;

  return (
    <div
      className={cx('app', !sidebar && 'no-sidebar', narrow && 'is-narrow', showAssistant && 'has-assistant', dropping && 'is-dropping')}
      onDragOver={(e) => {
        // Dialogs handle (or refuse) their own drops; never import behind an open dialog, and never
        // let the browser open the file instead.
        if ((e.target as HTMLElement).closest('.modal-backdrop')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'none';
          return;
        }
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
        if ((e.target as HTMLElement).closest('.modal-backdrop')) {
          e.preventDefault();
          return;
        }
        if (e.dataTransfer.files.length && !(e.target as HTMLElement).closest('.ProseMirror')) {
          e.preventDefault();
          void importDropped(e.dataTransfer.files);
        }
      }}
    >
      <Sidebar overlay={narrow} />
      <main className="main">
        <MainBar scrolled={scrolled} />
        {/* Any page scrolling under the bar gives the bar its hairline. */}
        <div className="content" onScrollCapture={(e) => setScrolled((e.target as HTMLElement).scrollTop > 2)}>
          {error && <div className="vault-error">Couldn’t open the vault: {error}</div>}
          {view.kind === 'library' && <LibraryView />}
          {(view.kind === 'class' || (view.kind === 'folder' && folderMeta[view.path]?.kind === 'class')) && <ClassView key={view.path} path={view.path} tab={view.kind === 'class' ? view.tab : undefined} />}
          {view.kind === 'classes' && <ClassesView />}
          {view.kind === 'homework' && <HomeworkView filter={view.filter} />}
          {view.kind === 'review' && <ReviewView preset={view.preset} />}
          {(view.kind === 'home' || view.kind === 'trash' || (view.kind === 'folder' && folderMeta[view.path]?.kind !== 'class')) && <NotesPage view={view} />}
          {tabs
            .filter((id) => notes[id] && !notes[id].meta.trashed)
            .map((id) => (
              <NoteEditor key={id} noteId={id} active={activeNote === id} />
            ))}
          {/* A view nothing else draws (e.g. saved by a newer version) shows the Classes page. */}
          {!KNOWN.has(view.kind) && <ClassesView />}
        </div>
      </main>
      {showAssistant && <AssistantPanel />}
      <SlashMenu />
      <CommandPalette />
      <SettingsModal />
      <ClassDialog />
      <CustomizeDialog />
      <NewHomeworkDialog />
      <LinkNotesDialog />
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
