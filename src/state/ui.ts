import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Scope } from '../lib/ai/rag';
import { migrateUI, UI_VERSION } from './migrate';

export type View =
  /** The Classes page: every class as a card. The start page. */
  | { kind: 'classes' }
  /** All notes. */
  | { kind: 'home' }
  | { kind: 'note'; id: string }
  | { kind: 'folder'; path: string }
  | { kind: 'trash' }
  | { kind: 'library' }
  | { kind: 'class'; path: string }
  | { kind: 'homework' }
  /** Review: `preset` picks these notes when it opens. */
  | { kind: 'review'; preset?: string[] };

/** Modal dialogs that several places can open. */
export type Dialog =
  | { kind: 'class'; path: string | null }
  | { kind: 'newHomework'; classPath: string | null; file?: { name: string; bytes: Uint8Array } }
  | { kind: 'linkNotes'; noteId: string };

export type SettingsSection = 'general' | 'writing' | 'ai' | 'shortcuts' | 'about';

export interface UIState {
  view: View;
  tabs: string[];
  /** The tab a note opened from a list replaces (the last one that was active). */
  lastTab: string | null;
  /** The last page that wasn't a note: where closing the last tab goes back to. */
  lastPage: View;
  sidebar: boolean;
  /**
   * The sidebar was put away for the window's sake (a narrow window, or the assistant needing the room)
   * and comes back when that passes. It is saved as shown, so a reload doesn't take it for a choice.
   */
  sidebarAuto: boolean;
  assistant: boolean;
  palette: boolean;
  settings: SettingsSection | null;
  /** The Settings pane last looked at this session (where ⌘, opens next). */
  settingsPane: SettingsSection;
  zoom: number;
  expanded: Record<string, boolean>;
  sort: 'updated' | 'title' | 'created';
  /** A note whose title should get focus once opened (new notes). */
  focusTitle: string | null;
  /** A new note made without picking a paper (⌘N, the palette): it offers the paper choice until written in. */
  paperStrip: string | null;
  /** Block to scroll to & flash when a note opens (citations). */
  reveal: { noteId: string; blockId: string; at: number } | null;
  /** What "Ask your notes" searches. */
  libraryScope: Scope;
  dialog: Dialog | null;
  openDialog(d: Dialog | null): void;
  openNote(id: string, opts?: { newTab?: boolean; focusTitle?: boolean; blockId?: string }): void;
  closeTab(id: string): void;
  setView(v: View): void;
  toggleSidebar(): void;
  setAssistant(open: boolean): void;
  setPalette(open: boolean): void;
  /** Opens Settings: on `section`, or on the pane last viewed (General the first time). Null closes it. */
  openSettings(section?: SettingsSection | 'vault' | null): void;
  setZoom(z: number): void;
  toggleFolder(path: string, open?: boolean): void;
  set(p: Partial<UIState>): void;
}

const MAX_TABS = 12;

/** What of the UI is kept across launches. */
export function savedUI(s: UIState): Partial<UIState> & { sidebar: boolean } {
  return {
    view: s.view.kind === 'library' || s.view.kind === 'review' ? { kind: 'classes' } : s.view,
    tabs: s.tabs,
    lastTab: s.lastTab,
    sidebar: s.sidebar || s.sidebarAuto,
    assistant: s.assistant,
    zoom: s.zoom,
    expanded: s.expanded,
    sort: s.sort,
    libraryScope: s.libraryScope,
  };
}

/** Below this the sidebar starts hidden and, when shown, floats over the page. */
export const NARROW = '(max-width: 899px)';

/**
 * A hidden sidebar is inert, and the button that shows it goes away once it is shown: either way the keyboard
 * focus would drop to the page. Called before the change, this hands focus that was in `from` to `to`, unless
 * something else (a click elsewhere) took it meanwhile. (In the next frame the browser may not have moved focus
 * off the inert sidebar yet, so focus still in `from` counts as lost too.)
 */
function keepFocus(from: string, to: string) {
  if (typeof document === 'undefined' || !document.activeElement?.closest(from)) return;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.closest(from)) document.querySelector<HTMLElement>(to)?.focus();
  });
}

/** Puts the floating sidebar away (Esc, a click outside it, a page picked), keeping the keyboard focus. */
export function hideSidebar() {
  keepFocus('.sidebar', '.mainbar-show');
  useUI.getState().set({ sidebar: false });
}

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      view: { kind: 'classes' },
      tabs: [],
      lastTab: null,
      lastPage: { kind: 'classes' },
      sidebar: true,
      sidebarAuto: false,
      assistant: false,
      palette: false,
      settings: null,
      settingsPane: 'general',
      zoom: 1,
      expanded: {},
      sort: 'updated',
      focusTitle: null,
      paperStrip: null,
      reveal: null,
      libraryScope: { kind: 'all' },
      dialog: null,
      openDialog: (d) => set({ dialog: d }),
      openNote: (id, opts = {}) => {
        const { tabs, lastTab } = get();
        let next = tabs;
        if (!tabs.includes(id)) {
          // A note opened from a list, the palette or a citation takes the place of the last tab used;
          // "Open in new tab", ⌘-click and new notes get a tab of their own.
          const i = lastTab ? tabs.indexOf(lastTab) : -1;
          if (opts.newTab || i < 0) next = [...tabs, id];
          else {
            next = [...tabs];
            next[i] = id;
          }
        }
        set({
          tabs: next.slice(-MAX_TABS),
          view: { kind: 'note', id },
          focusTitle: opts.focusTitle ? id : get().focusTitle,
          reveal: opts.blockId ? { noteId: id, blockId: opts.blockId, at: Date.now() } : get().reveal,
        });
      },
      closeTab: (id) => {
        const { tabs, view, lastPage } = get();
        const i = tabs.indexOf(id);
        const next = tabs.filter((t) => t !== id);
        if (view.kind === 'note' && view.id === id) {
          // The tab to the right takes its place, else the one to the left; the last tab goes back to the page before.
          const neighbour = next[i] ?? next[i - 1];
          set({ tabs: next, view: neighbour ? { kind: 'note', id: neighbour } : lastPage });
        } else set({ tabs: next });
      },
      setView: (v) => set({ view: v }),
      // Showing or hiding it by hand is a choice, except over a narrow window, where it only floats.
      toggleSidebar: () => {
        if (get().sidebar) keepFocus('.sidebar', '.mainbar-show');
        else keepFocus('.mainbar-show', '.sidebar-hide');
        set({ sidebar: !get().sidebar, sidebarAuto: get().sidebarAuto && window.matchMedia(NARROW).matches });
      },
      setAssistant: (open) => set({ assistant: open }),
      setPalette: (open) => set({ palette: open }),
      openSettings: (section) => {
        if (section === null) return set({ settings: null });
        const pane = section === 'vault' ? 'general' : (section ?? get().settingsPane);
        set({ settings: pane, settingsPane: pane });
      },
      setZoom: (z) => set({ zoom: Math.min(2.5, Math.max(0.5, Math.round(z * 100) / 100)) }),
      toggleFolder: (path, open) => set({ expanded: { ...get().expanded, [path]: open ?? !get().expanded[path] } }),
      set: (p) => set(p),
    }),
    {
      name: 'nib.ui',
      version: UI_VERSION,
      migrate: (s, v) => migrateUI(s, v) as unknown as UIState,
      partialize: savedUI,
    },
  ),
);

// Remember the last tab used and the last page that wasn't a note, whichever way the view changed.
// A new note's paper choice goes once the note is left.
useUI.subscribe((s, prev) => {
  if (s.view === prev.view) return;
  if (s.paperStrip && !(s.view.kind === 'note' && s.view.id === s.paperStrip)) useUI.setState({ paperStrip: null });
  if (s.view.kind === 'note') {
    if (s.lastTab !== s.view.id) useUI.setState({ lastTab: s.view.id });
  } else useUI.setState({ lastPage: s.view });
  recordHistory(prev.view, s.view);
});

/* Back and forward through the pages visited (⌘[ and ⌘]), like a browser. */
const back: View[] = [];
const forward: View[] = [];
let travelling = false;
const same = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

function recordHistory(from: View, to: View) {
  if (travelling || same(from, to)) return;
  back.push(from);
  if (back.length > 50) back.shift();
  forward.length = 0;
}

function travel(from: View[], to: View[]) {
  const ui = useUI.getState();
  const v = from.pop();
  if (!v) return;
  to.push(ui.view);
  travelling = true;
  if (v.kind === 'note') ui.openNote(v.id);
  else ui.setView(v);
  travelling = false;
}

export const goBack = () => travel(back, forward);
export const goForward = () => travel(forward, back);
