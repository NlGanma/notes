import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { bridge } from '../lib/platform';
import { createBrowserVault } from '../lib/vault/browser';
import { createFsVault } from '../lib/vault/fs';
import { EMPTY_DOC, type FolderMeta, type NoteDoc, type NoteMeta, type VaultBackend } from '../lib/vault/types';
import { sanitizeFolderName, uid } from '../lib/util';
import { normalizeDocJSON } from '../editor/extensions/blockAttrs';
import { useSettings } from './settings';
import { useUI } from './ui';

const VAULT_ROOT_KEY = 'nib.vaultRoot';
const SEEDED_KEY = 'nib.seeded';

export interface VaultState {
  ready: boolean;
  error: string | null;
  backend: VaultBackend | null;
  notes: Record<string, NoteDoc>;
  folders: string[];
  folderMeta: Record<string, FolderMeta>;
  /** Bumped whenever note content changes (for search / index invalidation). */
  revision: number;
  init(root?: string): Promise<void>;
  createNote(opts?: { folder?: string; title?: string; content?: JSONContent; tags?: string[] }): NoteDoc;
  updateContent(id: string, content: JSONContent): void;
  updateMeta(id: string, patch: Partial<NoteMeta>): void;
  duplicateNote(id: string): NoteDoc | null;
  moveNote(id: string, folder: string): void;
  trashNote(id: string): void;
  restoreNote(id: string): void;
  deleteForever(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  createFolder(path: string): Promise<string>;
  renameFolder(path: string, newName: string): Promise<string | null>;
  moveFolder(path: string, parent: string): Promise<string | null>;
  deleteFolder(path: string): Promise<void>;
  setFolderMeta(path: string, meta: FolderMeta): void;
  /** Creates a class (a top-level folder with class metadata) and returns its path. */
  createClass(info: ClassDraft): Promise<string>;
  /** Updates a class's details; renames its folder when the name changes. Returns the (new) path. */
  updateClass(path: string, info: Partial<ClassDraft>): Promise<string>;
  /** Turns an existing folder into a class, or a class back into a plain folder. */
  setIsClass(path: string, isClass: boolean): void;
  flush(sync?: boolean): void;
}

export interface ClassDraft {
  name: string;
  code?: string;
  instructor?: string;
  term?: string;
  color?: string;
  icon?: string;
  archived?: boolean;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let initPromise: { root: string | undefined; p: Promise<void> } | null = null;
const dirty = new Set<string>();

function parentsOf(path: string): string[] {
  if (!path) return [];
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function uniqueFolderName(existing: string[], parent: string, name: string): string {
  const base = (parent ? parent + '/' : '') + name;
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const c = `${base} ${i}`;
    if (!existing.includes(c)) return c;
  }
}

export const useVault = create<VaultState>((set, get) => {
  const persist = (id: string, delay = 450) => {
    dirty.add(id);
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const doc = get().notes[id];
        const backend = get().backend;
        dirty.delete(id);
        if (doc && backend) backend.saveNote(doc).catch((e) => console.error(e));
      }, delay),
    );
  };

  const patchNote = (id: string, fn: (d: NoteDoc) => NoteDoc, delay?: number) => {
    const cur = get().notes[id];
    if (!cur) return;
    const next = fn(cur);
    set({ notes: { ...get().notes, [id]: next }, revision: get().revision + 1 });
    persist(id, delay);
  };

  return {
    ready: false,
    error: null,
    backend: null,
    notes: {},
    folders: [],
    folderMeta: {},
    revision: 0,

    init(rootOverride) {
      if (initPromise && initPromise.root === rootOverride) return initPromise.p;
      const p = doInit(rootOverride);
      initPromise = { root: rootOverride, p };
      return p;
    },

    createNote(opts = {}) {
      const now = Date.now();
      const doc: NoteDoc = {
        version: 1,
        meta: {
          id: uid('n'),
          title: opts.title ?? '',
          folder: opts.folder ?? '',
          tags: opts.tags ?? [],
          created: now,
          updated: now,
          paper: useSettings.getState().paper,
        },
        content: normalizeDocJSON(structuredClone(opts.content ?? EMPTY_DOC) as never),
      };
      const folders = [...new Set([...get().folders, ...parentsOf(doc.meta.folder)])].sort();
      set({ notes: { ...get().notes, [doc.meta.id]: doc }, folders, revision: get().revision + 1 });
      persist(doc.meta.id, 50);
      return doc;
    },

    updateContent(id, content) {
      patchNote(id, (d) => ({ ...d, content, meta: { ...d.meta, updated: Date.now() } }));
    },

    updateMeta(id, patch) {
      patchNote(id, (d) => ({ ...d, meta: { ...d.meta, ...patch, updated: patch.updated ?? Date.now() } }), 300);
    },

    duplicateNote(id) {
      const src = get().notes[id];
      if (!src) return null;
      const copy = get().createNote({
        folder: src.meta.folder,
        title: `${src.meta.title || 'Untitled'} copy`,
        content: structuredClone(src.content),
        tags: [...src.meta.tags],
      });
      // A copy of homework is homework too — otherwise it would count as class notes and be cited as a source.
      if (src.meta.homework) get().updateMeta(copy.meta.id, { homework: { ...structuredClone(src.meta.homework), done: false } });
      return get().notes[copy.meta.id] ?? copy;
    },

    moveNote(id, folder) {
      const folders = [...new Set([...get().folders, ...parentsOf(folder)])].sort();
      set({ folders });
      patchNote(id, (d) => ({ ...d, meta: { ...d.meta, folder, trashed: undefined } }), 50);
    },

    trashNote(id) {
      patchNote(id, (d) => ({ ...d, meta: { ...d.meta, trashed: Date.now(), pinned: false } }), 50);
    },

    restoreNote(id) {
      patchNote(id, (d) => ({ ...d, meta: { ...d.meta, trashed: undefined } }), 50);
    },

    async deleteForever(id) {
      const { backend, notes } = get();
      const next = { ...notes };
      delete next[id];
      set({ notes: next, revision: get().revision + 1 });
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
      dirty.delete(id);
      await backend?.deleteNote(id);
    },

    async emptyTrash() {
      const ids = Object.values(get().notes)
        .filter((n) => n.meta.trashed)
        .map((n) => n.meta.id);
      for (const id of ids) await get().deleteForever(id);
    },

    async createFolder(path) {
      const idx = path.lastIndexOf('/');
      const parent = idx >= 0 ? path.slice(0, idx) : '';
      const name = idx >= 0 ? path.slice(idx + 1) : path;
      const full = uniqueFolderName(get().folders, parent, sanitizeFolderName(name) || 'New folder');
      await get().backend?.createFolder(full);
      set({ folders: [...new Set([...get().folders, ...parentsOf(full)])].sort() });
      return full;
    },

    async renameFolder(path, newName) {
      const name = sanitizeFolderName(newName);
      if (!name) return null;
      const idx = path.lastIndexOf('/');
      const parent = idx >= 0 ? path.slice(0, idx) : '';
      const target = (parent ? parent + '/' : '') + name;
      if (target === path) return path;
      // Case-insensitive: on macOS "biology" and "Biology" are the same folder. A case-only rename of itself is fine.
      if (get().folders.some((f) => f !== path && f.toLowerCase() === target.toLowerCase())) return null;
      return relocateFolder(path, target);
    },

    async moveFolder(path, parent) {
      const idx = path.lastIndexOf('/');
      const name = path.slice(idx + 1);
      // Already there (e.g. dropped on its own parent or on the tree background): nothing to do.
      if ((idx >= 0 ? path.slice(0, idx) : '') === parent) return path;
      if (parent === path || parent.startsWith(path + '/')) return null;
      // Classes stay top-level; a class inside another class would leak its notes into the parent's scope.
      if (parent && get().folderMeta[path]?.kind === 'class') return null;
      const target = uniqueFolderName(get().folders, parent, name);
      if (target === path) return path;
      return relocateFolder(path, target);
    },

    async deleteFolder(path) {
      const inside = (f: string) => f === path || f.startsWith(path + '/');
      const { notes } = get();
      for (const n of Object.values(notes)) {
        if (inside(n.meta.folder)) get().trashNote(n.meta.id);
      }
      get().flush();
      await new Promise((r) => setTimeout(r, 120));
      await get().backend?.deleteFolder(path);
      // Forget the folder's class details too, or the class would come back (and a new folder with
      // the same name would inherit them).
      const folderMeta = Object.fromEntries(Object.entries(get().folderMeta).filter(([k]) => !inside(k)));
      set({ folders: get().folders.filter((f) => !inside(f)), folderMeta });
      await get().backend?.saveFolderMeta(folderMeta);
      const ui = useUI.getState();
      const v = ui.view;
      if ((v.kind === 'class' || v.kind === 'folder') && inside(v.path)) ui.set({ view: { kind: 'home' } });
      if (ui.libraryScope.kind === 'folder' && inside(ui.libraryScope.path)) ui.set({ libraryScope: { kind: 'all' } });
      for (const [id, n] of Object.entries(get().notes)) {
        const hw = n.meta.homework;
        if (hw?.folders.some(inside)) get().updateMeta(id, { homework: { ...hw, folders: hw.folders.filter((f) => !inside(f)) }, updated: n.meta.updated });
      }
    },

    setFolderMeta(path, meta) {
      const folderMeta = { ...get().folderMeta, [path]: { ...get().folderMeta[path], ...meta } };
      set({ folderMeta });
      get().backend?.saveFolderMeta(folderMeta);
    },

    async createClass(info) {
      const name = sanitizeFolderName(info.name) || 'New class';
      const path = await get().createFolder(name);
      const { name: _n, ...rest } = info;
      void _n;
      get().setFolderMeta(path, { ...clean(rest), kind: 'class', created: Date.now() });
      return path;
    },

    async updateClass(path, info) {
      let target = path;
      const name = info.name !== undefined ? sanitizeFolderName(info.name) : '';
      if (name && name !== path.split('/').pop()) {
        const renamed = await get().renameFolder(path, name);
        if (!renamed) throw new Error(`There is already a folder called “${name}”.`);
        target = renamed;
      }
      const { name: _n, ...rest } = info;
      void _n;
      get().setFolderMeta(target, { ...rest, kind: 'class' });
      return target;
    },

    setIsClass(path, isClass) {
      get().setFolderMeta(path, isClass ? { kind: 'class', created: get().folderMeta[path]?.created ?? Date.now() } : { kind: undefined });
    },

    flush(sync = false) {
      const backend = get().backend;
      for (const [id, t] of timers) {
        clearTimeout(t);
        timers.delete(id);
      }
      for (const id of [...dirty]) {
        const doc = get().notes[id];
        dirty.delete(id);
        if (!doc || !backend) continue;
        if (sync && backend.saveNoteSync) backend.saveNoteSync(doc);
        else backend.saveNote(doc).catch((e) => console.error(e));
      }
    },
  };

  async function doInit(rootOverride?: string) {
    try {
      let backend: VaultBackend;
      if (bridge) {
        const root = rootOverride || localStorage.getItem(VAULT_ROOT_KEY) || (await bridge.vault.defaultRoot());
        localStorage.setItem(VAULT_ROOT_KEY, root);
        backend = createFsVault(bridge, root);
      } else {
        backend = await createBrowserVault();
      }
      const snap = await backend.load();
      const notes: Record<string, NoteDoc> = {};
      for (const n of snap.notes) {
        normalizeDocJSON(n.content as never);
        notes[n.meta.id] = n;
      }
      const folders = [...new Set([...snap.folders, ...snap.notes.flatMap((n) => parentsOf(n.meta.folder))])].sort();
      // Details of folders that no longer exist (deleted outside Nib) are dropped; classes are top-level only.
      const folderMeta = Object.fromEntries(
        Object.entries(snap.folderMeta ?? {}).filter(([k, m]) => folders.includes(k) && m && typeof m === 'object' && !(m.kind === 'class' && k.includes('/'))),
      );
      set({ backend, notes, folders, folderMeta, ready: true, error: null, revision: get().revision + 1 });

      const seededKey = `${SEEDED_KEY}:${backend.label}`;
      if (!snap.notes.length && !localStorage.getItem(seededKey)) {
        localStorage.setItem(seededKey, '1');
        const { buildSeedNotes, SEED_CLASSES } = await import('../lib/vault/seed');
        const seeds = buildSeedNotes();
        for (const s of seeds) normalizeDocJSON(s.content as never);
        for (const s of seeds) {
          for (const f of parentsOf(s.meta.folder)) if (!get().folders.includes(f)) await backend.createFolder(f);
          await backend.saveNote(s);
        }
        const all = { ...get().notes };
        for (const s of seeds) all[s.meta.id] = s;
        const folderMeta = { ...get().folderMeta, ...SEED_CLASSES };
        set({
          notes: all,
          folders: [...new Set([...get().folders, ...seeds.flatMap((s) => parentsOf(s.meta.folder))])].sort(),
          folderMeta,
          revision: get().revision + 1,
        });
        await backend.saveFolderMeta(folderMeta);
        useUI.getState().openNote(seeds[0].meta.id, { newTab: true });
      }
    } catch (err) {
      console.error(err);
      set({ error: String((err as Error)?.message ?? err), ready: true });
    }
  }

  async function relocateFolder(from: string, to: string): Promise<string> {
    get().flush();
    await get().backend?.renameFolder(from, to);
    const remap = (f: string) => (f === from || f.startsWith(from + '/') ? to + f.slice(from.length) : f);
    const notes = { ...get().notes };
    for (const [id, n] of Object.entries(notes)) {
      if (n.meta.folder === from || n.meta.folder.startsWith(from + '/')) {
        notes[id] = { ...n, meta: { ...n.meta, folder: remap(n.meta.folder) } };
        persist(id, 200);
      }
    }
    const folderMeta: Record<string, FolderMeta> = {};
    for (const [k, m] of Object.entries(get().folderMeta)) folderMeta[remap(k)] = m;
    set({ notes, folders: [...new Set(get().folders.map(remap))].sort(), folderMeta });
    get().backend?.saveFolderMeta(folderMeta);
    // Keep the open class/folder page and Ask-your-notes scope pointing at the renamed folder.
    const ui = useUI.getState();
    const v = ui.view;
    if ((v.kind === 'class' || v.kind === 'folder') && (v.path === from || v.path.startsWith(from + '/'))) ui.set({ view: { ...v, path: remap(v.path) } });
    const sc = ui.libraryScope;
    if (sc.kind === 'folder' && (sc.path === from || sc.path.startsWith(from + '/'))) ui.set({ libraryScope: { kind: 'folder', path: remap(sc.path) } });
    const expanded = Object.fromEntries(Object.entries(ui.expanded).map(([k, val]) => [remap(k), val]));
    ui.set({ expanded });
    // Homework linked to a renamed folder follows it.
    for (const [id, n] of Object.entries(get().notes)) {
      const hw = n.meta.homework;
      if (hw?.folders.some((f) => f === from || f.startsWith(from + '/')))
        get().updateMeta(id, { homework: { ...hw, folders: hw.folders.map(remap) }, updated: n.meta.updated });
    }
    return to;
  }
});

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

export const notesList = (notes: Record<string, NoteDoc>) => Object.values(notes);
export const liveNotes = (notes: Record<string, NoteDoc>) => Object.values(notes).filter((n) => !n.meta.trashed);
