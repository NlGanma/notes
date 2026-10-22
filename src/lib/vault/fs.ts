import type { NibBridge } from '../platform';
import { sanitizeFileName } from '../util';
import { parseNoteFile, serializeNote, type FolderMeta, type NoteDoc, type VaultBackend, type VaultSnapshot } from './types';

/**
 * Vault on disk (Electron). Notes are `<Folder>/<Title>.nib` JSON files, so the
 * vault can live in iCloud Drive / Dropbox and be browsed in Finder. Hidden
 * `.nib/` holds app data (folder colours, chat history, search index).
 */
export function createFsVault(bridge: NibBridge, root: string): VaultBackend {
  const v = bridge.vault;
  const paths = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();

  const desiredPath = (doc: NoteDoc) => {
    const name = `${sanitizeFileName(doc.meta.title)}.nib`;
    if (doc.meta.trashed) return `.trash/${name}`;
    return doc.meta.folder ? `${doc.meta.folder}/${name}` : name;
  };

  const enqueue = (id: string, job: () => Promise<void>) => {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.then(job, job).catch((err) => console.error('[vault] save failed', err));
    queues.set(id, next);
    return next;
  };

  return {
    kind: 'fs',
    label: root,
    async load(): Promise<VaultSnapshot> {
      const { notes, folders } = await v.scan(root);
      const docs: NoteDoc[] = [];
      const seen = new Set<string>();
      for (const n of notes) {
        const doc = parseNoteFile(n.text);
        if (!doc || seen.has(doc.meta.id)) continue;
        seen.add(doc.meta.id);
        // The file location is the source of truth for the folder.
        if (!n.path.startsWith('.trash/')) {
          const idx = n.path.lastIndexOf('/');
          doc.meta.folder = idx >= 0 ? n.path.slice(0, idx) : '';
          if (doc.meta.trashed) doc.meta.trashed = undefined;
        } else if (!doc.meta.trashed) doc.meta.trashed = Date.now();
        paths.set(doc.meta.id, n.path);
        docs.push(doc);
      }
      let folderMeta: Record<string, FolderMeta> = {};
      try {
        folderMeta = JSON.parse((await v.readText(root, '.nib/folders.json')) ?? '{}');
      } catch {
        /* ignore */
      }
      return { notes: docs, folders, folderMeta };
    },
    saveNote(doc) {
      return enqueue(doc.meta.id, async () => {
        const want = desiredPath(doc);
        let cur = paths.get(doc.meta.id);
        const text = serializeNote(doc);
        if (!cur) {
          cur = await v.create(root, want, text);
          paths.set(doc.meta.id, cur);
          return;
        }
        // Renames / moves keep a unique name ("Lecture 2.nib").
        const base = want.slice(0, -'.nib'.length);
        const same = cur === want || (cur.startsWith(base + ' ') && /^ \d+\.nib$/.test(cur.slice(base.length)));
        if (!same) {
          cur = await v.move(root, cur, want);
          paths.set(doc.meta.id, cur);
        }
        await v.write(root, cur, text);
      });
    },
    saveNoteSync(doc) {
      const cur = paths.get(doc.meta.id);
      if (cur) v.writeSync(root, cur, serializeNote(doc));
    },
    async deleteNote(id) {
      const cur = paths.get(id);
      if (cur) await v.remove(root, cur);
      paths.delete(id);
    },
    async createFolder(path) {
      await v.mkdir(root, path);
    },
    async renameFolder(from, to) {
      await v.renameDir(root, from, to);
      for (const [id, p] of paths) {
        if (p.startsWith(from + '/')) paths.set(id, to + p.slice(from.length));
      }
    },
    async deleteFolder(path) {
      await v.remove(root, path);
    },
    saveFolderMeta(meta) {
      // Writes are queued so a quick rename + edit can't race on folders.json.
      const text = JSON.stringify(meta, null, 2);
      return enqueue('\u0000folders', () => v.writeText(root, '.nib/folders.json', text).then(() => undefined));
    },
    async readKV(key) {
      return v.readText(root, `.nib/${key}.json`);
    },
    writeKV(key, value) {
      return enqueue(`\u0000kv:${key}`, () => v.writeText(root, `.nib/${key}.json`, value).then(() => undefined));
    },
    writeKVSync(key, value) {
      v.writeSync(root, `.nib/${key}.json`, value);
    },
    reveal(id) {
      const cur = paths.get(id);
      if (cur) v.reveal(root, cur);
    },
  };
}
