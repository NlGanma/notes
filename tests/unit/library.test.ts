import { test } from 'node:test';
import assert from 'node:assert/strict';
import { note, p, vault } from './fixtures';

// The stores persist to localStorage; give them one in memory.
const mem = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
});

const { scopeFromPick, scopeName, scopeNotes, selectionFor } = await import('../../src/components/library/notebook');
const { conversationTitle, pastConversations, reopenConversation, startConversation } = await import('../../src/components/library/history');
const { LIBRARY_KEY, useAssistant } = await import('../../src/state/assistant');
type Msg = import('../../src/state/assistant').ChatMsg;

const classMeta = { 'Calculus I': { kind: 'class' as const }, Biology: { kind: 'class' as const } };

test('Choose notes…: one folder on its own stays that folder, so new notes in it count', () => {
  const v = vault();
  assert.deepEqual(scopeFromPick({ sources: [], folders: ['Calculus I'] }, v.notes), { kind: 'folder', path: 'Calculus I' });
  // A note inside the picked folder is already in it.
  assert.deepEqual(scopeFromPick({ sources: [v.lecture4.meta.id], folders: ['Calculus I'] }, v.notes), { kind: 'folder', path: 'Calculus I' });
});

test('Choose notes…: anything else is a list, read the way a notebook is (no homework, trash or AI-written notes)', () => {
  const v = vault();
  const flash = note('Calculus I flashcards', 'Calculus I', [p('Card')], { generated: true });
  const notes = { ...v.notes, [flash.meta.id]: flash };
  const sc = scopeFromPick({ sources: [v.cells.meta.id, v.hw.meta.id, flash.meta.id], folders: ['Calculus I'] }, notes);
  assert.equal(sc.kind, 'notes');
  const ids = new Set(sc.kind === 'notes' ? sc.ids : []);
  assert.deepEqual(
    [...ids].map((id) => notes[id].meta.title).sort(),
    ['Cell Structure', 'Lecture 4 — Limits & Continuity', 'Lecture 5 — Derivatives'],
    'the folder’s own notes and the loose one; never its homework, trash or flashcards',
  );
  assert.deepEqual(scopeFromPick({ sources: [], folders: [] }, notes), { kind: 'all' }, 'nothing picked reads every note');
});

test('the scope chip names a scope, and the picker starts from it', () => {
  const v = vault();
  assert.equal(scopeName({ kind: 'all' }, v.notes, classMeta), 'All notes');
  assert.equal(scopeName({ kind: 'folder', path: 'Calculus I' }, v.notes, classMeta), 'Calculus I');
  assert.equal(scopeName({ kind: 'note', id: v.cells.meta.id }, v.notes, classMeta), 'Cell Structure');
  assert.equal(scopeName({ kind: 'notes', ids: [v.cells.meta.id, v.lecture4.meta.id] }, v.notes, classMeta), '2 notes');
  // A picked note trashed since no longer counts.
  assert.equal(scopeName({ kind: 'notes', ids: [v.cells.meta.id, v.trashed.meta.id] }, v.notes, classMeta), 'Cell Structure');
  assert.deepEqual(
    scopeNotes({ kind: 'folder', path: 'Calculus I' }, v.notes).map((n) => n.meta.title),
    ['Lecture 4 — Limits & Continuity', 'Lecture 5 — Derivatives'],
  );
  assert.deepEqual(selectionFor({ kind: 'folder', path: 'Biology' }), { sources: [], folders: ['Biology'] });
  assert.deepEqual(selectionFor({ kind: 'all' }), { sources: [], folders: [] });
});

const ask = (id: string, content: string, at: number, extra: Partial<Msg> = {}): Msg[] => [
  { id: `${id}u`, role: 'user', content, at, scope: { kind: 'folder', path: 'Biology' }, ...extra },
  { id: `${id}a`, role: 'assistant', content: 'An answer.', status: 'done', grounding: 'library', at: at + 1 },
];

test('a conversation is named by its first question, or the study tool it started with', () => {
  assert.equal(conversationTitle(ask('a', 'What  is a\nlimit?', 1)), 'What is a limit?');
  assert.equal(conversationTitle(ask('b', 'Flashcards', 1, { tool: 'flashcards' })), 'Flashcards');
  assert.equal(conversationTitle(ask('c', 'Quiz me', 1, { tool: 'quiz', focus: 'limits' })), 'Quiz me: limits');
});

test('New conversation keeps the old one in History, and History brings it back with its scope', () => {
  useAssistant.setState({ threads: { [LIBRARY_KEY]: { key: LIBRARY_KEY, messages: ask('a', 'What is ATP?', 10) } }, streaming: null });
  startConversation();
  let threads = useAssistant.getState().threads;
  assert.equal(threads[LIBRARY_KEY], undefined, 'the page starts empty');
  const past = pastConversations(threads);
  assert.deepEqual(
    past.map((x) => x.title),
    ['What is ATP?'],
  );
  // An empty conversation isn't kept.
  startConversation();
  assert.equal(pastConversations(useAssistant.getState().threads).length, 1);

  useAssistant.setState({ threads: { ...useAssistant.getState().threads, [LIBRARY_KEY]: { key: LIBRARY_KEY, messages: ask('b', 'What is mitosis?', 20) } } });
  const scope = reopenConversation(past[0].key);
  threads = useAssistant.getState().threads;
  assert.deepEqual(scope, { kind: 'folder', path: 'Biology' });
  assert.equal(threads[LIBRARY_KEY].messages[0].content, 'What is ATP?');
  assert.deepEqual(
    pastConversations(threads).map((x) => x.title),
    ['What is mitosis?'],
    'the one it replaced is in History now',
  );
});

test('History keeps the newest twenty, and a reply cut short by New conversation reads as stopped', () => {
  const threads: Record<string, { key: string; messages: Msg[] }> = {};
  for (let i = 0; i < 25; i++) threads[`${LIBRARY_KEY}:old${i}`] = { key: `${LIBRARY_KEY}:old${i}`, messages: ask(`o${i}`, `Question ${i}`, 100 + i) };
  const live = ask('n', 'Still answering', 1000);
  live[1] = { ...live[1], status: 'streaming' };
  useAssistant.setState({ threads: { ...threads, [LIBRARY_KEY]: { key: LIBRARY_KEY, messages: live } }, streaming: null });
  startConversation();
  const past = pastConversations(useAssistant.getState().threads);
  assert.equal(past.length, 20);
  assert.equal(past[0].title, 'Still answering');
  assert.ok(!past.some((x) => x.title === 'Question 0'), 'the oldest went');
  const parked = useAssistant.getState().threads[past[0].key].messages;
  assert.equal(parked[1].status, 'stopped');
});
