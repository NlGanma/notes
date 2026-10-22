import { bridge } from '../platform';
import { uid } from '../util';

/**
 * HTTP to the local model server. Inside the Mac app every request goes
 * through the main process (no CORS setup needed in Ollama / LM Studio);
 * the browser build uses fetch directly.
 */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function httpJSON<T = unknown>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeout?: number } = {},
): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const method = init.method ?? (body ? 'POST' : 'GET');
  if (bridge) {
    const res = await bridge.http.request({ url, method, headers, body, timeout: init.timeout ?? 20000 });
    if (!res.ok) throw new HttpError(res.status, res.error || res.text.slice(0, 300) || `HTTP ${res.status}`);
    return (res.text ? JSON.parse(res.text) : {}) as T;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeout ?? 20000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text.slice(0, 300) || `HTTP ${res.status}`);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(0, (e as Error).name === 'AbortError' ? 'Timed out' : String((e as Error).message || e));
  } finally {
    clearTimeout(timer);
  }
}

/** POSTs `body` and streams the response text to `onText` until done. */
export function httpStream(
  url: string,
  body: unknown,
  onText: (chunk: string) => void,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<void> {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (bridge) {
    const b = bridge;
    return new Promise((resolve, reject) => {
      const id = uid('h');
      const onAbort = () => b.http.abort(id);
      if (opts.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      b.http.stream(id, { url, method: 'POST', headers, body: JSON.stringify(body) }, (type, data) => {
        if (type === 'chunk' && data) onText(data);
        else if (type === 'end') {
          opts.signal?.removeEventListener('abort', onAbort);
          resolve();
        } else if (type === 'abort') reject(new DOMException('Aborted', 'AbortError'));
        else if (type === 'error') {
          opts.signal?.removeEventListener('abort', onAbort);
          const m = /^HTTP (\d+)/.exec(data ?? '');
          reject(new HttpError(m ? Number(m[1]) : 0, data ?? 'Request failed'));
        }
      });
    });
  }
  return (async () => {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new HttpError(0, String((e as Error).message || e));
    }
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(dec.decode(value, { stream: true }));
    }
  })();
}
