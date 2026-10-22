import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Scope } from '../lib/ai/rag';

export type View =
  | { kind: 'home' }
  | { kind: 'note'; id: string }
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'trash' }
  | { kind: 'library' }
  | { kind: 'class'; path: string }
  | { kind: 'homework'; filter?: 'todo' | 'done' }
  /** Review: `preset` picks these notes when it opens. */
  | { kind: 'review'; preset?: string[] };

/** Modal dialogs that several places can open. */
export type Dialog =
  | { kind: 'class'; path: string | null }
  | { kind: 'newHomework'; classPath: string | null; file?: { name: string; bytes: Uint8Array } }
  | { kind: 'linkNotes'; noteId: string };

export type SettingsSection = 'ai' | 'writing' | 'vault' | 'shortcuts' | 'about';

export interface UIState {
  view: View;
  tabs: string[];
  sidebar: boolean;
  assistant: boolean;
  palette: boolean;
  settings: SettingsSection | null;
  zoom: number;
  expanded: Record<string, boolean>;
  gridMode: 'grid' | 'list';
  sort: 'updated' | 'title' | 'created';
  /** A note whose title should get focus once opened (new notes). */
  focusTitle: string | null;
  /** Block to scroll to & flash when a note opens (citations). */
  reveal: { noteId: string; blockId: string; at: number } | null;
  /** Sidebar item being renamed inline ("folder:<path>" or "note:<id>"). */
  renaming: string | null;
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
  openSettings(section?: SettingsSection | null): void;
  setZoom(z: number): void;
  toggleFolder(path: string, open?: boolean): void;
  set(p: Partial<UIState>): void;
}

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      view: { kind: 'home' },
      tabs: [],
      sidebar: true,
      assistant: false,
      palette: false,
      settings: null,
      zoom: 1,
      expanded: {},
      gridMode: 'grid',
      sort: 'updated',
      focusTitle: null,
      reveal: null,
      renaming: null,
      libraryScope: { kind: 'all' },
      dialog: null,
      openDialog: (d) => set({ dialog: d }),
      openNote: (id, opts = {}) => {
        const { tabs, view } = get();
        let next = tabs;
        if (!tabs.includes(id)) {
          if (opts.newTab || view.kind !== 'note' || !tabs.length) next = [...tabs, id];
          else {
            // Replace the current tab (Obsidian-style) unless asked for a new one.
            const i = tabs.indexOf((view as { id: string }).id);
            next = [...tabs];
            if (i >= 0) next[i] = id;
            else next.push(id);
          }
        }
        set({
          tabs: next.slice(-12),
          view: { kind: 'note', id },
          focusTitle: opts.focusTitle ? id : get().focusTitle,
          reveal: opts.blockId ? { noteId: id, blockId: opts.blockId, at: Date.now() } : get().reveal,
        });
      },
      closeTab: (id) => {
        const { tabs, view } = get();
        const i = tabs.indexOf(id);
        const next = tabs.filter((t) => t !== id);
        if (view.kind === 'note' && view.id === id) {
          const neighbour = next[Math.min(i, next.length - 1)];
          set({ tabs: next, view: neighbour ? { kind: 'note', id: neighbour } : { kind: 'home' } });
        } else set({ tabs: next });
      },
      setView: (v) => set({ view: v }),
      toggleSidebar: () => set({ sidebar: !get().sidebar }),
      setAssistant: (open) => set({ assistant: open }),
      setPalette: (open) => set({ palette: open }),
      openSettings: (section = 'ai') => set({ settings: section }),
      setZoom: (z) => set({ zoom: Math.min(2.5, Math.max(0.5, Math.round(z * 100) / 100)) }),
      toggleFolder: (path, open) => set({ expanded: { ...get().expanded, [path]: open ?? !get().expanded[path] } }),
      set: (p) => set(p),
    }),
    {
      name: 'nib.ui',
      partialize: (s) => ({
        view: s.view.kind === 'library' || s.view.kind === 'review' ? { kind: 'home' } : s.view,
        tabs: s.tabs,
        sidebar: s.sidebar,
        assistant: s.assistant,
        zoom: s.zoom,
        expanded: s.expanded,
        gridMode: s.gridMode,
        sort: s.sort,
        libraryScope: s.libraryScope,
      }),
    },
  ),
);
