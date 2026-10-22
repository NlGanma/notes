import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useVault } from '../../src/state/vault';
import { useAI } from '../../src/state/ai';
import { conceptsOf, dueCount, flushReview, parseReviewFile, useReview, type ReviewFile } from '../../src/state/review';
import { buildSeedNotes, SEED_CLASSES } from '../../src/lib/vault/seed';
import { isReviewable } from '../../src/lib/review/tree';
import { chunkNote } from '../../src/lib/ai/rag';
import { freshState } from '../../src/lib/review/mastery';
import type { NoteDoc, VaultBackend } from '../../src/lib/vault/types';

/** Review's file and the vault it belongs to: switching vaults, saving, damaged files, and what's kept. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const review = () => useReview.getState();
const notes = () => useVault.getState().notes;
const firstNote = () => Object.values(notes()).find(isReviewable)!;
const EMPTY: ReviewFile = { version: 1, modelConcepts: {}, extracted: {}, states: {}, questions: {}, bad: [], sessions: [] };
const learned = (o: Partial<ReturnType<typeof freshState>> = {}) => ({ ...freshState(Date.now()), attempts: 1, p: 0.5, ...o });

function vault(label: string, kv: Record<string, string> = {}, o: { slowRead?: number; sync?: boolean; failWrites?: boolean } = {}) {
  const writes: { key: string; sync?: boolean }[] = [];
  const backend: VaultBackend = {
    kind: 'browser',
    label,
    load: async () => ({ notes: [], folders: [], folderMeta: {} }),
    saveNote: async () => undefined,
    deleteNote: async () => undefined,
    createFolder: async () => undefined,
    renameFolder: async () => undefined,
    deleteFolder: async () => undefined,
    saveFolderMeta: async () => undefined,
    readKV: async (k) => {
      if (o.slowRead) await sleep(o.slowRead);
      return kv[k] ?? null;
    },
    writeKV: async (k, v) => {
      if (o.failWrites) throw new Error('disk full');
      kv[k] = v;
      writes.push({ key: k });
    },
    ...(o.sync
      ? {
          writeKVSync: (k: string, v: string) => {
            kv[k] = v;
            writes.push({ key: k, sync: true });
          },
        }
      : {}),
  };
  return { backend, kv, writes, saved: () => JSON.parse(kv.review ?? 'null') as ReviewFile | null };
}

/** Opens a vault (its own copy of the demo notes), as the app does, without reading its review file. */
function open(v: { backend: VaultBackend }) {
  const seed = buildSeedNotes();
  useVault.setState({
    backend: v.backend,
    notes: Object.fromEntries(seed.map((n) => [n.meta.id, n])),
    folders: [...new Set(seed.map((n) => n.meta.folder).filter(Boolean))],
    folderMeta: SEED_CLASSES,
    ready: true,
  });
}

useAI.setState({ status: 'offline', chatModel: '' });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  useAI.setState({ status: 'offline', chatModel: '' });
  if (review().session) review().end();
  review().closeSummary();
});

test('opening another vault mid-session: this vault’s answers are saved to it, and nothing carries over', async () => {
  const A = vault('A');
  open(A);
  await review().load();
  review().start([firstNote().meta.id]);
  review().dontKnow();
  review().next();
  const answered = Object.keys(review().file.states);
  assert.equal(answered.length, 1);
  const B = vault('B', { review: JSON.stringify({ ...EMPTY, sessions: [{ id: 'rs_b', label: 'B’s own' }] }) });
  open(B);
  await review().load();
  const r = review();
  assert.equal(r.session, null);
  assert.equal(r.current, null);
  assert.deepEqual(r.pool, []);
  assert.equal(r.summary, null);
  assert.deepEqual(r.selection, []);
  assert.deepEqual(
    r.file.sessions.map((s) => s.label),
    ['B’s own'],
  );
  assert.deepEqual(Object.keys(A.saved()!.states), answered, 'the answer went to its own vault');
  assert.equal(B.writes.length, 0);
  // Practising in B saves to B, with nothing of A's.
  review().start([firstNote().meta.id]);
  review().dontKnow();
  review().end();
  const b = B.saved()!;
  assert.ok(!answered.some((id) => id in b.states));
  assert.deepEqual(
    b.sessions.slice(1).map((s) => s.label),
    ['B’s own'],
  );
  assert.equal(A.saved()!.sessions.length, 0, 'and nothing of B’s went to A');
});

test('a save goes to the vault its file was read from, even before the other vault’s file is read', async () => {
  const A = vault('A');
  open(A);
  await review().load();
  review().start([firstNote().meta.id]);
  const B = vault('B', { review: JSON.stringify(EMPTY) });
  open(B);
  review().dontKnow();
  flushReview();
  assert.equal(B.writes.length, 0);
  assert.equal(Object.keys(A.saved()!.states).length, 1);
});

test('a model job started in one vault keeps nothing it found once another vault is open', async () => {
  globalThis.fetch = (async () => {
    await sleep(40);
    return new Response(`${JSON.stringify({ message: { content: JSON.stringify({ concepts: [] }) }, done: true })}\n`, { status: 200 });
  }) as typeof fetch;
  useAI.setState({ status: 'online', chatModel: 'stub', models: [] });
  const A = vault('A');
  open(A);
  await review().load();
  const job = review().readMore(Object.keys(notes()));
  await sleep(10);
  assert.ok(review().reading, 'the model is reading A’s notes');
  const B = vault('B', { review: JSON.stringify({ ...EMPTY, states: { c_b: learned() } }) });
  open(B);
  await review().load();
  await job;
  flushReview();
  assert.equal(B.writes.length, 0, 'nothing was written over B’s file');
  assert.deepEqual(Object.keys(review().file.states), ['c_b']);
  assert.deepEqual(review().file.extracted, {});
  assert.equal(review().reading, null);
});

test('reading a vault’s file once: a second call waits for the read in progress', async () => {
  const A = vault('A', { review: JSON.stringify({ ...EMPTY, states: { c_a: learned() } }) });
  open(A);
  await review().load();
  const B = vault('B', { review: JSON.stringify({ ...EMPTY, states: { c_b: learned() } }) }, { slowRead: 30 });
  open(B);
  const first = review().load();
  await review().load();
  assert.ok(review().loaded);
  assert.deepEqual(Object.keys(review().file.states), ['c_b']);
  await first;
  assert.deepEqual(Object.keys(review().file.states), ['c_b']);
});

const old = { ...EMPTY, states: { c_old: { attempts: 9, p: 0.97, due: Date.now() + 1e9 } }, sessions: [{ id: 'rs_old', label: 'Old session', items: 12 }] };

test('a review file this version can’t read is kept aside, never written over', async () => {
  for (const raw of [JSON.stringify(old).slice(0, 60), JSON.stringify({ ...old, version: 2 }), '[]']) {
    const V = vault('V', { review: raw });
    open(V);
    await review().load();
    assert.deepEqual(review().file, EMPTY);
    const aside = Object.keys(V.kv).find((k) => k.startsWith('review-unreadable-'));
    assert.ok(aside && V.kv[aside] === raw, `kept aside: ${raw.slice(0, 30)}`);
    // Practising saves a fresh file; the old one stays where it was put.
    review().start([firstNote().meta.id]);
    review().dontKnow();
    review().end();
    assert.equal(V.saved()!.version, 1);
    assert.equal(V.kv[aside!], raw);
  }
  // If it can't be kept aside, it isn't written over at all.
  const W = vault('W', { review: 'not json' }, { failWrites: true });
  open(W);
  await review().load();
  review().start([firstNote().meta.id]);
  review().dontKnow();
  review().end();
  assert.equal(W.kv.review, 'not json');
});

test('a damaged part of the review file is left out, not fatal', async () => {
  const V = vault('V', { review: JSON.stringify({ ...old, states: null, modelConcepts: { c_x: null }, questions: { k: 'oops' }, bad: [3, 'k1'] }) });
  open(V);
  await review().load();
  const f = review().file;
  assert.deepEqual(f.states, {});
  assert.deepEqual(f.modelConcepts, {});
  assert.deepEqual(f.questions, {});
  assert.deepEqual(f.bad, ['k1']);
  assert.equal(f.sessions.length, 1, 'what can be read is kept');
  assert.doesNotThrow(() => dueCount());
  // An older state without the fields added since is filled in.
  const kept = parseReviewFile(JSON.stringify(old))!.states.c_old;
  assert.equal(kept.attempts, 9);
  assert.deepEqual(kept.recent, []);
  assert.deepEqual(kept.correctKeys, []);
});

test('the model’s findings for passages that no longer exist are dropped when the file is read; what was learned is kept', async () => {
  const V = vault('V');
  open(V);
  const n = firstNote();
  const live = chunkNote(n)[0].hash;
  const concept = (id: string, chunkHash: string, noteId = n.meta.id) => ({
    id,
    noteId,
    chunkHash,
    blockId: null,
    section: '',
    name: id,
    kind: 'fact',
    facts: [{ id: 'f', text: 'x', key: null, example: false, fromInk: false, item: false }],
    partners: [],
    cap: 0,
    thin: false,
    origin: 'model',
  });
  const question = [{ prompt: 'Why?', points: [], fact: 'x' }];
  V.kv.review = JSON.stringify({
    ...EMPTY,
    extracted: { [live]: { model: 'm', at: 1 }, gone: { model: 'm', at: 1 } },
    modelConcepts: { c_live: concept('c_live', live), c_gone: concept('c_gone', 'gone'), c_deleted: concept('c_deleted', live, 'no-such-note') },
    questions: { [`k#${live}`]: question, 'k#gone': question },
    states: { c_gone: learned() },
    bad: ['k#gone'],
  });
  await review().load();
  const f = review().file;
  assert.deepEqual(Object.keys(f.extracted), [live]);
  assert.deepEqual(Object.keys(f.modelConcepts), ['c_live']);
  assert.deepEqual(Object.keys(f.questions), [`k#${live}`]);
  assert.deepEqual(Object.keys(f.states), ['c_gone']);
  assert.deepEqual(f.bad, ['k#gone']);
});

test('closing the window saves what’s pending at once, synchronously where the vault can', async () => {
  const V = vault('V', {}, { sync: true });
  open(V);
  await review().load();
  review().start([firstNote().meta.id]);
  review().dontKnow();
  assert.equal(V.writes.length, 0, 'normally saved a moment later');
  flushReview(true);
  assert.deepEqual(V.writes, [{ key: 'review', sync: true }]);
  assert.equal(Object.keys(V.saved()!.states).length, 1);
});

test('starting with nothing due or new asks nothing and keeps no empty session', async () => {
  const V = vault('V');
  open(V);
  await review().load();
  const n = firstNote();
  const now = Date.now();
  const mastered = learned({ p: 0.99, attempts: 6, correct: 6, streak: 4, best: 3, level: 3, last: now, due: now + 20 * 864e5, interval: 20, codeCorrect: 4, correctKeys: ['a', 'b', 'c'] });
  useReview.setState({ file: { ...review().file, states: Object.fromEntries(conceptsOf(n as NoteDoc).map((c) => [c.id, mastered])) } });
  for (let i = 0; i < 3; i++) {
    review().start([n.meta.id]);
    assert.equal(review().session, null);
    assert.equal(review().summary, null);
  }
  flushReview();
  assert.deepEqual(review().file.sessions, []);
  // A note trashed after it was picked has nothing to ask either.
  const t = Object.values(notes()).filter(isReviewable)[1];
  useVault.getState().trashNote(t.meta.id);
  review().start([t.meta.id]);
  assert.equal(review().session, null);
  assert.equal(review().summary, null);
});
