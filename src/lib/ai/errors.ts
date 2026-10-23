/**
 * Errors in plain words, for a reply or a toast. The raw message stays where a developer looks for it:
 * Settings › Activity for model calls, the console for the rest.
 */
export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const missing = /model ["'“]?([^"'”\s]+)["'”]? not found/i.exec(msg)?.[1];
  if (missing || /not found, try pulling/i.test(msg))
    return `${missing ? `The model ${missing}` : 'That model'} isn’t installed. Pull it with Ollama or pick another in Settings → Local AI.`;
  if (/does not support (images|vision)|image input/i.test(msg))
    return 'This model can’t read images. Choose a vision model (e.g. qwen2.5vl, gemma3, llama3.2-vision) in Settings → Local AI.';
  if (/ECONNREFUSED|Failed to fetch|fetch failed|NetworkError|Load failed|HTTP 0/i.test(msg)) return 'Couldn’t reach your local model server. Is Ollama / LM Studio running?';
  if (/timed? ?out|ETIMEDOUT/i.test(msg)) return 'The local AI took too long to answer. Try again in a moment.';
  if (/context|too long|num_ctx/i.test(msg)) return 'That’s more than the model can read at once. Try a shorter question or raise the context size in Settings → Local AI.';
  // The status and the server's own words, never its raw reply ('{"error":…}').
  const code = (e as { status?: number })?.status ?? 0;
  const status = /HTTP (5\d\d)/.exec(msg)?.[1] ?? (code >= 500 && code < 600 ? String(code) : undefined);
  if (status) {
    const why = serverReason(msg);
    return `The model server had a problem (HTTP ${status}${why ? `: ${why}` : ''}). It was retried automatically; try again in a moment.`;
  }
  // A program's own words ("TypeError: x is undefined", a JSON reply, a page of HTML) mean nothing to a student.
  if (/[{}<>]|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|undefined|null|NaN)\b/.test(msg)) {
    console.error(e);
    return 'Something went wrong. Try again.';
  }
  return msg;
}

/** The reason in a JSON error reply ('{"error":"server busy"}' → "server busy"), or ''. */
function serverReason(msg: string): string {
  if (!msg.includes('{')) return '';
  try {
    const j = JSON.parse(msg.slice(msg.indexOf('{'))) as { error?: unknown };
    const why = typeof j.error === 'object' && j.error ? (j.error as { message?: unknown }).message : j.error;
    return typeof why === 'string' ? why.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  } catch {
    return '';
  }
}
