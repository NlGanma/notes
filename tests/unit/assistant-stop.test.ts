import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlabeled as outsideLabels } from './fixtures';

/**
 * A grounded reply that ends early — Stop, a newer question, a dropped
 * connection — is checked like a finished one: what arrived is never shown,
 * copied or sent back to the model unchecked. The model is a scripted
 * /api/chat stream in this process (no server, no ports).
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

/** What the scripted model says next, and whether the connection drops after some words. */
const script = { text: '', dropAfter: Infinity };
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (!String(url).endsWith('/api/chat')) throw new Error(`unexpected request ${url}`);
  const words = script.text.match(/\S+\s*/g) ?? [];
  const enc = new TextEncoder();
  let sent = 0;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    async pull(c) {
      if (init.signal?.aborted) return;
      if (sent >= script.dropAfter) return c.error(new TypeError('network connection was lost'));
      if (sent < words.length) {
        c.enqueue(enc.encode(JSON.stringify({ message: { role: 'assistant', content: words[sent++] }, done: false }) + '\n'));
        await new Promise((r) => setTimeout(r, 4));
        return;
      }
      c.enqueue(enc.encode(JSON.stringify({ done: true, done_reason: 'stop', eval_count: 40 }) + '\n'));
      c.close();
    },
  });
  init.signal?.addEventListener('abort', () => ctl.error(new DOMException('Aborted', 'AbortError')), { once: true });
  return new Response(body, { status: 200 });
}) as typeof fetch;

const { useAI } = await import('../../src/state/ai');
const { useVault } = await import('../../src/state/vault');
const { useAssistant, LIBRARY_KEY } = await import('../../src/state/assistant');
const { buildSeedNotes } = await import('../../src/lib/vault/seed');
const { shownOf } = await import('../../src/lib/ai/answer');
const { renderMarkdown } = await import('../../src/lib/ai/markdown');

const ANSWER =
  'If $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [1]. The squeeze theorem was first proved by Archimedes in 250 BC. Newton used it in 1687 to compute the orbits of the planets around the sun.';

const bot = () => [...(useAssistant.getState().threads[LIBRARY_KEY]?.messages ?? [])].reverse().find((m) => m.role === 'assistant')!;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), 'timed out');
};
/** Text of a reply the student can see outside every caution box and inline mark. */
const unlabeled = (md: string) => outsideLabels(renderMarkdown(md));

beforeEach(() => {
  const seed = buildSeedNotes();
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
  useAssistant.setState({ threads: {} });
  script.text = ANSWER;
  script.dropAfter = Infinity;
});

test('Stop while the answer streams: what arrived is checked, not shown raw', async () => {
  const asking = useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  await until(() => /250 BC\./.test(bot()?.content ?? ''));
  useAssistant.getState().stop();
  await asking;
  const m = bot();
  assert.equal(m.status, 'stopped');
  const md = shownOf(m);
  assert.match(unlabeled(md), /near/, 'the part from the notes is still shown');
  assert.ok(!unlabeled(md).includes('Archimedes'), md);
});

test('a dropped connection mid-answer: the same', async () => {
  script.dropAfter = 30;
  await useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  const m = bot();
  assert.equal(m.status, 'error');
  assert.ok(m.content.includes('Archimedes'), 'the test reached the invented sentence');
  assert.ok(!unlabeled(shownOf(m)).includes('Archimedes'));
});

test('an answer stopped mid-stream and reloaded is still shown boxed', async () => {
  const asking = useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  await until(() => /250 BC\./.test(bot()?.content ?? ''));
  // What persist saves for a reply still streaming: no checked text yet.
  const saved = { ...bot(), status: 'stopped' as const, shown: undefined };
  useAssistant.getState().stop();
  await asking;
  assert.ok(!unlabeled(shownOf(saved)).includes('Archimedes'));
});

test('set to answer only from the notes, the AI’s own sentences are left out entirely', async () => {
  useAI.setState({ outsideKnowledge: 'never' } as never);
  await useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  const md = shownOf(bot());
  assert.ok(!/Archimedes|Newton/.test(md), md);
  assert.match(md, /Left out — not in your notes/);
});

test('asked while the model server is still being found, a question waits for it instead of failing', async () => {
  useAI.setState({ status: 'checking' } as never);
  const asking = useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bot().status, 'streaming', 'still waiting, no error');
  assert.equal(bot().phase, undefined, 'the typing dots show, not "Searching your notes"');
  assert.equal(useAssistant.getState().streaming, LIBRARY_KEY, 'Stop shows while it waits');
  useAI.setState({ status: 'online' } as never);
  await asking;
  assert.equal(bot().status, 'done');
  assert.match(bot().content, /near/);
});

test('…and says the server isn’t reachable only once that is known', async () => {
  useAI.setState({ status: 'checking' } as never);
  const asking = useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bot().status, 'streaming');
  useAI.setState({ status: 'offline' } as never);
  await asking;
  assert.equal(bot().status, 'error');
  assert.match(bot().error ?? '', /isn’t reachable/);
  assert.equal(useAssistant.getState().streaming, null);
});

test('…and Stop while it waits stops it', async () => {
  useAI.setState({ status: 'unknown' } as never);
  const asking = useAssistant.getState().askLibrary({ prompt: 'What does the squeeze theorem say?', scope: { kind: 'all' } });
  await new Promise((r) => setTimeout(r, 30));
  useAssistant.getState().stop();
  await asking;
  assert.equal(bot().status, 'stopped');
  assert.equal(useAssistant.getState().streaming, null);
  useAI.setState({ status: 'online' } as never);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bot().status, 'stopped', 'the model coming up later doesn’t revive it');
});
