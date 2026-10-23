import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * How a question about the open note is routed, kept and retried. The model
 * is a scripted /api/chat stream in this process (no server, no ports); each
 * request's system prompt says which call it was: the notes, or the AI's own
 * knowledge.
 */

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
Object.assign(globalThis, {
  localStorage: storage,
  window: { localStorage: storage },
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

/** What the scripted model says, why it stopped, and every request it got. */
const script = { text: '', reason: 'stop', requests: [] as { role: string; content: string }[][] };
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (!String(url).endsWith('/api/chat')) throw new Error(`unexpected request ${url}`);
  script.requests.push(JSON.parse(String(init.body)).messages);
  const enc = new TextEncoder();
  const lines = [{ message: { role: 'assistant', content: script.text }, done: false }, { done: true, done_reason: script.reason, eval_count: 40 }];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n'));
        c.close();
      },
    }),
    { status: 200 },
  );
}) as typeof fetch;

const { useAI } = await import('../../src/state/ai');
const { useVault } = await import('../../src/state/vault');
const { LIBRARY_KEY, useAssistant, friendlyError } = await import('../../src/state/assistant');
const { buildSeedNotes } = await import('../../src/lib/vault/seed');
const { NOTE_STARTERS, TEXT_ACTIONS } = await import('../../src/lib/ai/prompts');

const seed = buildSeedNotes();
const lecture = seed.find((n) => /Lecture 4/.test(n.meta.title))!;
const KEY = lecture.meta.id;

/** Which call each request was: the notes prompt or the AI's own knowledge. */
const kinds = () => script.requests.map((m) => (/^You are Nib, a study assistant/.test(m[0].content) ? 'notes' : /from general knowledge/.test(m[0].content) ? 'general' : 'other'));
const thread = () => useAssistant.getState().threads[KEY]?.messages ?? [];
const last = (role: 'user' | 'assistant') => [...thread()].reverse().find((m) => m.role === role)!;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), 'timed out');
};
const settled = () => until(() => useAssistant.getState().streaming === null && last('assistant')?.status !== 'streaming');

beforeEach(() => {
  useAI.setState({
    status: 'online',
    provider: 'ollama',
    baseUrl: 'http://model.invalid',
    chatModel: 'mock',
    embedModel: '',
    models: [{ name: 'mock', vision: false, embedding: false, contextLength: 16384 }],
    doubleCheck: false,
    outsideKnowledge: 'auto',
  } as never);
  useVault.setState({ notes: Object.fromEntries(seed.map((n) => [n.meta.id, n])), folders: [], folderMeta: {} });
  useAssistant.setState({ threads: {}, streaming: null });
  script.text = 'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1].';
  script.reason = 'stop';
  script.requests = [];
});

test('the starters about the whole note are answered from the note, never sent to the coverage gate — Retry too', async () => {
  for (const prompt of Object.values(NOTE_STARTERS)) {
    useAssistant.setState({ threads: {} });
    script.requests = [];
    await useAssistant.getState().ask(KEY, { prompt });
    assert.equal(kinds()[0], 'notes', `${prompt} → ${kinds().join(', ')}`);
    assert.ok(!last('assistant').ownOnly, prompt);
    useAssistant.getState().regenerate(KEY);
    await settled();
    assert.deepEqual(kinds().filter((k) => k === 'notes').length, 2, `Retry: ${prompt} → ${kinds().join(', ')}`);
    assert.ok(!last('assistant').ownOnly);
  }
});

test('a menu action shows its name in the student’s bubble; the model, Retry and “Search anyway” keep the full prompt', async () => {
  const selection = { id: 'a1', kind: 'text' as const, label: 'Selected text', text: 'The professor said this one will definitely be on the exam.' };
  await useAssistant.getState().ask(KEY, { prompt: TEXT_ACTIONS.define, label: 'Define key terms', attachments: [selection] });
  const asked = last('user');
  assert.equal(asked.label, 'Define key terms');
  assert.equal(asked.content, TEXT_ACTIONS.define);
  assert.ok(script.requests[0].at(-1)!.content.includes(TEXT_ACTIONS.define), 'the model gets the full prompt');
  useAssistant.getState().regenerate(KEY);
  await settled();
  assert.equal(last('user').label, 'Define key terms');
  assert.equal(last('user').content, TEXT_ACTIONS.define);
  useAssistant.getState().forceNotes(KEY);
  await settled();
  assert.equal(last('user').label, 'Define key terms');
  assert.equal(last('user').content, TEXT_ACTIONS.define);
});

test('“Search my notes anyway”, then Retry, searches the notes again instead of going back to the gate', async () => {
  script.text = 'NOT IN NOTES: the capital of Peru';
  await useAssistant.getState().ask(KEY, { prompt: 'What is the capital of Peru?' });
  assert.deepEqual(kinds(), ['general'], 'the gate answered first');
  assert.ok(last('assistant').ownOnly && !last('assistant').forced);
  useAssistant.getState().forceNotes(KEY);
  await settled();
  assert.ok(last('user').forced && last('assistant').forced);
  assert.equal(kinds()[1], 'notes');
  const before = script.requests.length;
  useAssistant.getState().regenerate(KEY);
  await settled();
  assert.equal(kinds()[before], 'notes', `Retry → ${kinds().slice(before).join(', ')}`);
  assert.ok(last('assistant').forced);
});

test('a cut-off answer from the AI’s own knowledge offers no “continue” (there is nothing to continue it with)', async () => {
  script.text = 'Lima is the capital of Peru, and it';
  script.reason = 'length';
  await useAssistant.getState().ask(KEY, { prompt: 'What is the capital of Peru?' });
  const m = last('assistant');
  assert.ok(m.ownOnly && m.status === 'done');
  assert.ok(!m.truncated);
  assert.match(m.shown ?? '', /^:::outside\n[\s\S]*Lima[\s\S]*\n:::$/, 'still boxed as the AI’s own knowledge');
});

test('a server error is said in words, without its raw reply', () => {
  const busy = friendlyError(new Error('HTTP 503: {"error":"server busy, try again"}'));
  assert.ok(!/[{}"]/.test(busy), busy);
  assert.match(busy, /HTTP 503: server busy/);
  assert.match(busy, /try again in a moment/);
  // Errors relayed from the app's main process carry the status but may not start with "HTTP".
  const relayed = friendlyError(Object.assign(new Error('<html>Bad gateway</html>'), { status: 502 }));
  assert.equal(relayed, 'The model server had a problem (HTTP 502). It was retried automatically; try again in a moment.');
});

test('a study tool with nothing in the notes to make it from says so, marked, without asking the model', async () => {
  await useAssistant.getState().askLibrary({ prompt: '', scope: { kind: 'folder', path: 'An empty folder' }, tool: 'summary' });
  const reply = [...useAssistant.getState().threads[LIBRARY_KEY].messages].reverse().find((m) => m.role === 'assistant')!;
  assert.equal(reply.status, 'done');
  assert.ok(reply.insufficient, 'marked, so the page shows it as a reply and not as a summary');
  assert.match(reply.content, /isn’t enough in these notes/);
  assert.deepEqual(reply.sources, [], 'it cites nothing');
  assert.equal(script.requests.length, 0);
});
