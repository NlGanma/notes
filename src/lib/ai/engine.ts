import { create } from 'zustand';
import { chat as rawChat, type ChatRequest, type ChatResult } from './providers';
import { HttpError } from './transport';
import { providerConfig, useAI } from '../../state/ai';
import { uid } from '../util';

/**
 * The harness around the local model.
 *
 * A laptop runs one model at a time, so every completion goes through a small
 * scheduler:
 *  - interactive requests (the student is waiting) jump the queue and pre-empt
 *    background work such as reading handwriting, which simply retries later;
 *  - transient failures (server restarting, model still loading) are retried
 *    with backoff before any token has been shown;
 *  - slow first tokens surface a "loading the model" status;
 *  - every request is measured (latency, tokens/s) and logged for Settings.
 */

export type Priority = 'interactive' | 'background';

export class PreemptedError extends Error {
  constructor() {
    super('Paused for a question you asked');
    this.name = 'PreemptedError';
  }
}

export interface Metrics {
  firstTokenMs: number | null;
  totalMs: number;
  /** Time spent waiting behind other requests before this one started. */
  queuedMs?: number;
  tokens: number;
  tokensPerSec: number | null;
}

export interface RobustResult extends ChatResult {
  model: string;
  metrics: Metrics;
  truncated: boolean;
}

export interface ActivityEntry {
  id: string;
  label: string;
  model: string;
  priority: Priority;
  at: number;
  status: 'queued' | 'running' | 'ok' | 'error' | 'stopped' | 'paused';
  metrics?: Metrics;
  error?: string;
  attempts: number;
}

interface ActivityState {
  entries: ActivityEntry[];
  push(e: ActivityEntry): void;
  patch(id: string, p: Partial<ActivityEntry>): void;
  clear(): void;
}

export const useActivity = create<ActivityState>((set, get) => ({
  entries: [],
  push: (e) => set({ entries: [e, ...get().entries].slice(0, 60) }),
  patch: (id, p) => set({ entries: get().entries.map((e) => (e.id === id ? { ...e, ...p } : e)) }),
  clear: () => set({ entries: [] }),
}));

interface Job {
  priority: Priority;
  ctrl: AbortController;
  start(): void;
  fail(e: unknown): void;
}

class Scheduler {
  private running: Job | null = null;
  private queue: Job[] = [];

  run<T>(priority: Priority, fn: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController();
      const job: Job = {
        priority,
        ctrl,
        fail: reject,
        start: () => {
          this.running = job;
          fn(ctrl.signal)
            .then(resolve, (e) => reject(ctrl.signal.reason instanceof PreemptedError ? ctrl.signal.reason : e))
            .finally(() => {
              if (this.running === job) this.running = null;
              this.next();
            });
        },
      };
      external?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(job);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
          ctrl.abort();
        },
        { once: true },
      );
      if (priority === 'interactive') {
        const firstBg = this.queue.findIndex((j) => j.priority === 'background');
        this.queue.splice(firstBg < 0 ? this.queue.length : firstBg, 0, job);
        if (this.running?.priority === 'background') this.running.ctrl.abort(new PreemptedError());
      } else this.queue.push(job);
      this.next();
    });
  }

  private next() {
    if (this.running) return;
    const job = this.queue.shift();
    if (job) job.start();
  }

  get busy() {
    return !!this.running || this.queue.length > 0;
  }
}

export const scheduler = new Scheduler();

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export function isTransient(e: unknown): boolean {
  if (e instanceof HttpError) {
    if ([0, 429, 502, 503, 504].includes(e.status)) return true;
    return /loading|busy|overloaded|ECONNRESET|socket hang up|EPIPE|try again/i.test(e.message);
  }
  return /network|Failed to fetch|fetch failed|ECONNRESET/i.test(String((e as Error)?.message ?? e));
}

export interface RobustRequest extends Omit<ChatRequest, 'model' | 'numCtx'> {
  label: string;
  model: string;
  priority?: Priority;
  numCtx?: number;
  /** Called with 'loading' when the first token is slow, 'retrying' between attempts, null when streaming. */
  onStatus?(status: 'loading' | 'retrying' | null): void;
}

/** The context window actually available: the user's setting capped by what the model supports. */
export function effectiveCtx(model: string, requested?: number): number {
  const ai = useAI.getState();
  const info = ai.models.find((m) => m.name === model);
  return Math.max(2048, Math.min(requested ?? ai.numCtx, info?.contextLength ?? Infinity));
}

/** A completion with scheduling, retries, metrics and logging. */
export async function chatRobust(req: RobustRequest): Promise<RobustResult> {
  const numCtx = effectiveCtx(req.model, req.numCtx);
  const priority = req.priority ?? 'interactive';
  const entry: ActivityEntry = { id: uid('r'), label: req.label, model: req.model, priority, at: Date.now(), status: 'queued', attempts: 0 };
  useActivity.getState().push(entry);
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt++) {
    let gotToken = false;
    const enqueued = performance.now();
    // The clock starts when the job runs, not while it waits in the queue.
    let t0 = enqueued;
    let first: number | null = null;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await scheduler.run(
        priority,
        (signal) => {
          t0 = performance.now();
          useActivity.getState().patch(entry.id, { status: 'running', attempts: attempt });
          loadingTimer = setTimeout(() => !gotToken && req.onStatus?.('loading'), 2500);
          const onFirst = () => {
            if (gotToken) return;
            gotToken = true;
            first = performance.now() - t0;
            clearTimeout(loadingTimer);
            req.onStatus?.(null);
          };
          return rawChat(providerConfig(), {
            ...req,
            numCtx,
            signal,
            onToken: (t) => {
              onFirst();
              req.onToken?.(t);
            },
            onThinking: (t) => {
              onFirst();
              req.onThinking?.(t);
            },
          });
        },
        req.signal,
      );
      clearTimeout(loadingTimer);
      const totalMs = performance.now() - t0;
      // Without server stats, estimate from everything generated (reasoning included), since the timing covers it too.
      const tokens = res.evalCount ?? Math.round((res.text.length + (res.thinking?.length ?? 0)) / 3.8);
      const genMs = res.evalMs ?? (first !== null ? totalMs - first : totalMs);
      const metrics: Metrics = {
        firstTokenMs: first,
        totalMs,
        queuedMs: Math.round(t0 - enqueued),
        tokens,
        tokensPerSec: genMs > 50 ? (tokens / genMs) * 1000 : null,
      };
      useActivity.getState().patch(entry.id, { status: 'ok', metrics });
      return { ...res, model: req.model, metrics, truncated: res.finishReason === 'length' };
    } catch (e) {
      clearTimeout(loadingTimer);
      req.onStatus?.(null);
      if (e instanceof PreemptedError) {
        useActivity.getState().patch(entry.id, { status: 'paused' });
        throw e;
      }
      const aborted = (e as Error).name === 'AbortError' || req.signal?.aborted;
      if (aborted) {
        useActivity.getState().patch(entry.id, { status: 'stopped' });
        throw e;
      }
      if (!gotToken && attempt < maxAttempts && isTransient(e)) {
        req.onStatus?.('retrying');
        try {
          await sleep(700 * 3 ** (attempt - 1), req.signal);
        } catch (stopped) {
          // Stopped while waiting to retry.
          req.onStatus?.(null);
          useActivity.getState().patch(entry.id, { status: 'stopped' });
          throw stopped;
        }
        continue;
      }
      useActivity.getState().patch(entry.id, { status: 'error', error: String((e as Error).message ?? e) });
      throw e;
    }
  }
}

/**
 * Asks for JSON, validates it, and makes one repair attempt if the model
 * returned something unusable (common with small local models).
 */
export async function chatJSON<T>(
  req: RobustRequest,
  validate: (raw: unknown) => T | null,
  parse: (text: string) => unknown,
): Promise<{ value: T; result: RobustResult }> {
  const first = await chatRobust({ ...req, json: true });
  const v1 = validate(parse(first.text));
  if (v1 !== null) return { value: v1, result: first };
  const repair = await chatRobust({
    ...req,
    label: `${req.label} (repair)`,
    json: true,
    onToken: undefined,
    messages: [
      ...req.messages,
      { role: 'assistant', content: first.text.slice(0, 6000) },
      { role: 'user', content: 'That reply was not valid JSON in the requested shape. Reply again with ONLY the JSON object, no prose, no code fences.' },
    ],
  });
  const v2 = validate(parse(repair.text));
  if (v2 !== null) return { value: v2, result: repair };
  throw new Error('The model did not return the expected format. Try again, or pick a larger model in Settings → Local AI.');
}
