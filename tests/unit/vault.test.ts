import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useVault } from '../../src/state/vault';
import { useUI } from '../../src/state/ui';
import { homeworkSources } from '../../src/lib/homework';
import { classNotes, listClasses } from '../../src/lib/classes';
import type { FolderMeta, VaultBackend } from '../../src/lib/vault/types';

/** The vault store's folder and class operations against an in-memory backend. */

let saved: Record<string, FolderMeta> = {};
const backend: VaultBackend = {
  kind: 'browser',
  label: 'memory',
  load: async () => ({ notes: [], folders: [], folderMeta: {} }),
  saveNote: async () => undefined,
  deleteNote: async () => undefined,
  createFolder: async () => undefined,
  renameFolder: async () => undefined,
  deleteFolder: async () => undefined,
  saveFolderMeta: async (m) => {
    saved = structuredClone(m);
  },
  readKV: async () => null,
  writeKV: async () => undefined,
};

beforeEach(() => {
  saved = {};
  useVault.setState({ backend, notes: {}, folders: [], folderMeta: {}, ready: true });
  useUI.setState({ view: { kind: 'home' }, libraryScope: { kind: 'all' }, expanded: {} });
});

const vault = () => useVault.getState();

async function setupClass() {
  const cls = await vault().createClass({ name: 'Calculus I', code: 'MATH 1A' });
  const lecture = vault().createNote({ folder: cls, title: 'Lecture 4' });
  const hw = vault().createNote({ folder: `${cls}/Homework`, title: 'PS 4' });
  vault().updateMeta(hw.meta.id, { homework: { sources: [], folders: [cls] } });
  return { cls, lecture, hw: () => vault().notes[hw.meta.id] };
}

test('duplicating homework keeps it homework, so it is never cited as a class note', async () => {
  const { cls, hw } = await setupClass();
  vault().updateMeta(hw().meta.id, { homework: { ...hw().meta.homework!, done: true } });
  const copy = vault().duplicateNote(hw().meta.id)!;
  assert.ok(copy.meta.homework);
  // A copy keeps the original's state (a reference copy of finished work isn't suddenly overdue).
  assert.equal(copy.meta.homework!.done, true);
  assert.deepEqual(
    homeworkSources(hw(), vault().notes).map((n) => n.meta.title),
    ['Lecture 4'],
  );
  assert.ok(!classNotes(cls, vault().notes).some((n) => n.meta.id === copy.meta.id));
});

test('a plain note filed in Homework/ is not class material', async () => {
  const { cls, hw } = await setupClass();
  vault().createNote({ folder: `${cls}/Homework`, title: 'scratch' });
  assert.deepEqual(
    homeworkSources(hw(), vault().notes).map((n) => n.meta.title),
    ['Lecture 4'],
  );
  assert.deepEqual(
    classNotes(cls, vault().notes).map((n) => n.meta.title),
    ['Lecture 4'],
  );
});

test('deleting a class forgets its details, leaves its page and unlinks it from other homework', async () => {
  const { cls } = await setupClass();
  const other = vault().createNote({ folder: 'Biology/Homework', title: 'Bio HW' });
  vault().updateMeta(other.meta.id, { homework: { sources: [], folders: [cls, 'Biology'] } });
  useUI.setState({ view: { kind: 'class', path: cls }, libraryScope: { kind: 'folder', path: cls } });
  await vault().deleteFolder(cls);
  assert.equal(vault().folderMeta[cls], undefined);
  assert.equal(saved[cls], undefined);
  assert.equal(listClasses(vault().folders, vault().folderMeta).length, 0);
  assert.equal(useUI.getState().view.kind, 'home');
  assert.deepEqual(useUI.getState().libraryScope, { kind: 'all' });
  assert.deepEqual(vault().notes[other.meta.id].meta.homework!.folders, ['Biology']);
});

test('dropping a folder where it already is does nothing (no "Name 2")', async () => {
  const { cls } = await setupClass();
  assert.equal(await vault().moveFolder(cls, ''), cls);
  assert.equal(await vault().moveFolder(`${cls}/Homework`, cls), `${cls}/Homework`);
  assert.ok(vault().folders.includes(cls) && !vault().folders.includes(`${cls} 2`));
});

test('classes stay top-level', async () => {
  const { cls } = await setupClass();
  const bio = await vault().createClass({ name: 'Biology' });
  assert.equal(await vault().moveFolder(bio, cls), null);
  assert.ok(vault().folders.includes('Biology'));
});

test('renaming a class carries its details, view, scope and homework links along', async () => {
  const { cls, hw } = await setupClass();
  useUI.setState({ view: { kind: 'class', path: cls }, libraryScope: { kind: 'folder', path: cls } });
  const next = await vault().updateClass(cls, { name: 'Calc', instructor: 'Dr. Lee' });
  assert.equal(next, 'Calc');
  assert.equal(vault().folderMeta.Calc.code, 'MATH 1A');
  assert.equal(vault().folderMeta.Calc.instructor, 'Dr. Lee');
  assert.equal(vault().folderMeta[cls], undefined);
  assert.deepEqual(useUI.getState().view, { kind: 'class', path: 'Calc' });
  assert.deepEqual(hw().meta.homework!.folders, ['Calc']);
  assert.equal(hw().meta.folder, 'Calc/Homework');
});

test('a case-only rename works; renaming onto another folder fails loudly', async () => {
  const { cls } = await setupClass();
  assert.equal(await vault().updateClass(cls, { name: 'calculus i' }), 'calculus i');
  await vault().createFolder('Drafts');
  await assert.rejects(vault().updateClass('calculus i', { name: 'drafts' }), /already a folder/);
});

test('class and folder names are cleaned: no separators, no hidden dot-folders', async () => {
  assert.equal(await vault().createClass({ name: '.NET Development' }), 'NET Development');
  assert.equal(await vault().createClass({ name: 'a/b:c' }), 'a b c');
  assert.equal(await vault().createClass({ name: '...' }), 'New class');
});
