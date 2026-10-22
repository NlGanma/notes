import type { FolderMeta, NoteDoc, VaultBackend, VaultSnapshot } from './types';

/** IndexedDB vault used by the browser build (and for automated tests). */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nib-vault', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'meta.id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function createBrowserVault(): Promise<VaultBackend> {
  const db = await openDb();
  const getKV = (key: string) => tx<string | undefined>(db, 'kv', 'readonly', (s) => s.get(key));
  const setKV = (key: string, value: string) => tx(db, 'kv', 'readwrite', (s) => s.put(value, key));

  const readFolders = async (): Promise<string[]> => {
    try {
      return JSON.parse((await getKV('folders')) ?? '[]');
    } catch {
      return [];
    }
  };
  const writeFolders = (list: string[]) => setKV('folders', JSON.stringify([...new Set(list)].sort()));

  return {
    kind: 'browser',
    label: 'This browser',
    async load(): Promise<VaultSnapshot> {
      const notes = (await tx<NoteDoc[]>(db, 'notes', 'readonly', (s) => s.getAll())) ?? [];
      const folders = await readFolders();
      let folderMeta: Record<string, FolderMeta> = {};
      try {
        folderMeta = JSON.parse((await getKV('folderMeta')) ?? '{}');
      } catch {
        /* ignore */
      }
      return { notes, folders, folderMeta };
    },
    async saveNote(doc) {
      await tx(db, 'notes', 'readwrite', (s) => s.put(doc));
      if (doc.meta.folder) {
        const folders = await readFolders();
        const parts = doc.meta.folder.split('/');
        const needed = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
        if (needed.some((f) => !folders.includes(f))) await writeFolders([...folders, ...needed]);
      }
    },
    async deleteNote(id) {
      await tx(db, 'notes', 'readwrite', (s) => s.delete(id));
    },
    async createFolder(path) {
      const folders = await readFolders();
      const parts = path.split('/');
      await writeFolders([...folders, ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]);
    },
    async renameFolder(from, to) {
      const folders = await readFolders();
      await writeFolders(folders.map((f) => (f === from || f.startsWith(from + '/') ? to + f.slice(from.length) : f)));
    },
    async deleteFolder(path) {
      const folders = await readFolders();
      await writeFolders(folders.filter((f) => f !== path && !f.startsWith(path + '/')));
    },
    async saveFolderMeta(meta) {
      await setKV('folderMeta', JSON.stringify(meta));
    },
    async readKV(key) {
      return (await getKV(`kv:${key}`)) ?? null;
    },
    async writeKV(key, value) {
      await setKV(`kv:${key}`, value);
    },
  };
}
