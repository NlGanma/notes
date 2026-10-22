import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { chatRobust, PreemptedError, scheduler, useActivity, isTransient } from '../../src/lib/ai/engine';
import { listModels, chat } from '../../src/lib/ai/providers';
import { HttpError } from '../../src/lib/ai/transport';
import { useAI } from '../../src/state/ai';

/**
 * The model harness against the mock server: retries, truncation, metrics,
 * pre-emption of background work, and both server APIs.
 */

const PORT = 11500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

const mock = (faults: Record<string, number>) =>
  fetch(`${BASE}/__mock`, { method: 'POST', body: JSON.stringify(faults) }).then((r) => r.json() as Promise<{ stats: { chat: number; failed: number } }>);

before(async () => {
  server = spawn(process.execPath, [path.resolve('scripts/mock-llm.mjs'), String(PORT)], {
    env: { ...process.env, MOCK_QUIET: '1', MOCK_DELAY: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/tags`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const models = await listModels({ provider: 'ollama', baseUrl: BASE });
  useAI.setState({ provider: 'ollama', baseUrl: BASE, apiKey: '', models, chatModel: 'qwen3:8b', status: 'online', numCtx: 8192 });
});

after(() => {
  server.kill();
});

const ask = (extra: Partial<Parameters<typeof chatRobust>[0]> = {}) =>
  chatRobust({ label: 'test', model: 'qwen3:8b', messages: [{ role: 'user', content: 'Summarise this.' }], ...extra });

test('models are listed with capabilities from the server', async () => {
  const models = useAI.getState().models;
  assert.ok(models.find((m) => m.name === 'qwen2.5vl:7b')?.vision);
  assert.ok(models.find((m) => m.name.startsWith('nomic'))?.embedding);
  assert.ok(models.find((m) => m.name === 'qwen3:8b')?.thinking);
});

test('a completion streams, separates thinking, and reports metrics', async () => {
  let streamed = '';
  const res = await ask({ onToken: (t) => (streamed += t) });
  assert.match(res.text, /Limits/);
  assert.equal(streamed, res.text);
  assert.ok(res.thinking.length > 0, 'thinking model streams its reasoning separately');
  assert.equal(res.truncated, false);
  assert.ok(res.metrics.tokens > 10);
  assert.ok(res.metrics.firstTokenMs !== null);
  assert.equal(useActivity.getState().entries[0].status, 'ok');
});

test('transient server errors are retried before any token is shown', async () => {
  const before = (await mock({})).stats;
  const statuses: (string | null)[] = [];
  const res = await ask({ onStatus: (s) => statuses.push(s) });
  void res;
  await mock({ fail: 2, status: 503 });
  const res2 = await ask({ onStatus: (s) => statuses.push(s) });
  assert.match(res2.text, /Limits/);
  const after = (await mock({})).stats;
  assert.equal(after.failed - before.failed, 2);
  assert.ok(statuses.includes('retrying'));
  assert.equal(useActivity.getState().entries[0].attempts, 3);
});

test('it gives up after three attempts with the server’s error', async () => {
  await mock({ fail: 5, status: 503 });
  await assert.rejects(ask(), (e: unknown) => e instanceof HttpError && e.status === 503);
  await mock({ fail: 0 });
  assert.equal(useActivity.getState().entries[0].status, 'error');
});

test('non-transient errors are not retried', async () => {
  await assert.rejects(chatRobust({ label: 'bad', model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }), /not found/);
  assert.equal(useActivity.getState().entries[0].attempts, 1);
});

test('a reply cut off by the token limit is flagged as truncated', async () => {
  await mock({ truncate: 1 });
  const res = await ask();
  assert.equal(res.truncated, true);
  assert.equal(res.finishReason, 'length');
});

test('a slow first token reports that the model is loading', async () => {
  await mock({ firstTokenMs: 2800 });
  const statuses: (string | null)[] = [];
  await ask({ onStatus: (s) => statuses.push(s) });
  assert.deepEqual(statuses.slice(0, 2), ['loading', null]);
});

test('interactive requests pre-empt background work', async () => {
  await mock({ firstTokenMs: 1500 });
  const bg = chatRobust({ label: 'background', model: 'qwen3:8b', priority: 'background', messages: [{ role: 'user', content: 'Summarise this.' }] });
  await new Promise((r) => setTimeout(r, 150));
  const fg = ask();
  await assert.rejects(bg, (e: unknown) => e instanceof PreemptedError);
  const res = await fg;
  assert.match(res.text, /Limits/);
  assert.equal(scheduler.busy, false);
  await mock({ firstTokenMs: 0 });
});

test('stopping aborts the request', async () => {
  const ctrl = new AbortController();
  const p = ask({ signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  assert.equal(useActivity.getState().entries[0].status, 'stopped');
});

test('stopping while waiting to retry ends the request cleanly', async () => {
  await mock({ fail: 3, status: 503 });
  const ctrl = new AbortController();
  const p = ask({ signal: ctrl.signal, onStatus: (st) => st === 'retrying' && setTimeout(() => ctrl.abort(), 30) });
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  assert.equal(useActivity.getState().entries[0].status, 'stopped');
  await mock({ fail: 0 });
});

test('the OpenAI-compatible API works the same way', async () => {
  const res = await chat({ provider: 'openai', baseUrl: BASE }, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'Summarise this.' }] });
  assert.match(res.text, /Limits/);
  assert.equal(res.finishReason, 'stop');
});

test('which errors count as transient', () => {
  assert.equal(isTransient(new HttpError(503, 'busy')), true);
  assert.equal(isTransient(new HttpError(0, 'connection reset')), true);
  assert.equal(isTransient(new HttpError(404, 'model not found')), false);
  assert.equal(isTransient(new Error('Failed to fetch')), true);
});
