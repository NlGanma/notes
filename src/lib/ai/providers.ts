import { httpJSON, httpStream, HttpError } from './transport';

export type ProviderKind = 'ollama' | 'openai';

export interface ProviderConfig {
  provider: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelInfo {
  name: string;
  size?: number;
  params?: string;
  family?: string;
  vision: boolean;
  embedding: boolean;
  thinking?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 PNG/JPEG images (no data: prefix). */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numCtx?: number;
  json?: boolean;
  signal?: AbortSignal;
  onToken?(text: string): void;
  onThinking?(text: string): void;
}

export interface ChatResult {
  text: string;
  thinking: string;
}

export const DEFAULT_URLS: Record<ProviderKind, string> = {
  ollama: 'http://localhost:11434',
  openai: 'http://localhost:1234/v1',
};

const VISION_RE =
  /(llava|bakllava|vision|[-_.]vl\b|[-_]vl[-_:]|qwen2\.5-?vl|qwen2-?vl|qwen3-?vl|gemma-?3|gemma3n|minicpm-?v|moondream|pixtral|llama-?4|mistral-small-?3\.[12]|internvl|smolvlm|granite.*vision|phi-?4-?multimodal|kimi-vl|glm-?4\.?\dv)/i;
const EMBED_RE = /(embed|bge-|\bbge\b|e5-|gte-|nomic|minilm|arctic-embed|mxbai|jina-embeddings|snowflake)/i;
const THINK_RE = /(qwen3|deepseek-r1|qwq|gpt-oss|magistral|phi-?4-?reasoning|r1-)/i;

export function guessCapabilities(name: string): Pick<ModelInfo, 'vision' | 'embedding' | 'thinking'> {
  return { vision: VISION_RE.test(name), embedding: EMBED_RE.test(name), thinking: THINK_RE.test(name) };
}

export function normalizeBase(cfg: ProviderConfig): string {
  let url = (cfg.baseUrl || DEFAULT_URLS[cfg.provider]).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (cfg.provider === 'openai' && !/\/v\d+$/.test(url)) url += '/v1';
  if (cfg.provider === 'ollama') url = url.replace(/\/(api|v1)$/, '');
  return url;
}

function authHeaders(cfg: ProviderConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

export async function listModels(cfg: ProviderConfig): Promise<ModelInfo[]> {
  const base = normalizeBase(cfg);
  if (cfg.provider === 'ollama') {
    const res = await httpJSON<{ models?: { name: string; size?: number; details?: { family?: string; parameter_size?: string; families?: string[] } }[] }>(
      `${base}/api/tags`,
      { timeout: 5000 },
    );
    const models = res.models ?? [];
    return Promise.all(
      models.map(async (m) => {
        const info: ModelInfo = {
          name: m.name,
          size: m.size,
          params: m.details?.parameter_size,
          family: m.details?.family,
          ...guessCapabilities(m.name + ' ' + (m.details?.families ?? []).join(' ')),
        };
        try {
          const show = await httpJSON<{ capabilities?: string[] }>(`${base}/api/show`, { body: { model: m.name }, timeout: 5000 });
          if (Array.isArray(show.capabilities)) {
            info.vision = show.capabilities.includes('vision');
            info.embedding = show.capabilities.includes('embedding') && !show.capabilities.includes('completion');
            info.thinking = show.capabilities.includes('thinking');
          }
        } catch {
          /* older Ollama: keep the name-based guess */
        }
        if ((m.details?.families ?? []).some((f) => /clip|mllama/i.test(f))) info.vision = true;
        if (/bert/i.test(m.details?.family ?? '')) info.embedding = true;
        return info;
      }),
    );
  }
  const res = await httpJSON<{ data?: { id: string; type?: string }[] }>(`${base}/models`, { headers: authHeaders(cfg), timeout: 5000 });
  return (res.data ?? []).map((m) => {
    const caps = guessCapabilities(m.id);
    if (m.type === 'vlm') caps.vision = true;
    if (m.type === 'embeddings') caps.embedding = true;
    return { name: m.id, ...caps };
  });
}

/** Splits `<think>…</think>` sections out of a token stream. */
class ThinkSplitter {
  private inThink = false;
  private buf = '';
  constructor(
    private onText: (t: string) => void,
    private onThink: (t: string) => void,
  ) {}
  push(chunk: string) {
    this.buf += chunk;
    for (;;) {
      if (!this.inThink) {
        const i = this.buf.indexOf('<think>');
        if (i < 0) {
          // Keep a possible partial tag at the end.
          const keep = partialTagLength(this.buf, '<think>');
          if (this.buf.length > keep) this.onText(this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        if (i > 0) this.onText(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 7);
        this.inThink = true;
      } else {
        const i = this.buf.indexOf('</think>');
        if (i < 0) {
          const keep = partialTagLength(this.buf, '</think>');
          if (this.buf.length > keep) this.onThink(this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        if (i > 0) this.onThink(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 8);
        this.inThink = false;
      }
    }
  }
  flush() {
    if (this.buf) (this.inThink ? this.onThink : this.onText)(this.buf);
    this.buf = '';
  }
}

function partialTagLength(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(s.length - n))) return n;
  return 0;
}

export async function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const base = normalizeBase(cfg);
  let text = '';
  let thinking = '';
  const split = new ThinkSplitter(
    (t) => {
      text += t;
      req.onToken?.(t);
    },
    (t) => {
      thinking += t;
      req.onThinking?.(t);
    },
  );
  const think = (t: string) => {
    thinking += t;
    req.onThinking?.(t);
  };

  if (cfg.provider === 'ollama') {
    let pending = '';
    let errorMsg: string | null = null;
    await httpStream(
      `${base}/api/chat`,
      {
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
        stream: true,
        keep_alive: '15m',
        ...(req.json ? { format: 'json' } : {}),
        options: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.numCtx ? { num_ctx: req.numCtx } : {}),
        },
      },
      (chunk) => {
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const lineText = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!lineText) continue;
          try {
            const obj = JSON.parse(lineText);
            if (obj.error) errorMsg = String(obj.error);
            if (obj.message?.thinking) think(obj.message.thinking);
            if (obj.message?.content) split.push(obj.message.content);
          } catch {
            /* partial line */
          }
        }
      },
      { signal: req.signal },
    );
    if (pending.trim()) {
      try {
        const obj = JSON.parse(pending);
        if (obj.error) errorMsg = String(obj.error);
        if (obj.message?.content) split.push(obj.message.content);
      } catch {
        /* ignore */
      }
    }
    split.flush();
    if (errorMsg) throw new HttpError(500, errorMsg);
    return { text, thinking };
  }

  // OpenAI-compatible (LM Studio, llama.cpp server, Jan, vLLM, LocalAI…)
  let pending = '';
  let streamError: string | null = null;
  await httpStream(
    `${base}/chat/completions`,
    {
      model: req.model,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: req.messages.map((m) =>
        m.images?.length
          ? {
              role: m.role,
              content: [
                { type: 'text', text: m.content },
                ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } })),
              ],
            }
          : { role: m.role, content: m.content },
      ),
    },
    (chunk) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const lineText = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!lineText.startsWith('data:')) continue;
        const data = lineText.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta ?? {};
          const r = delta.reasoning_content ?? delta.reasoning;
          if (r) think(r);
          if (delta.content) split.push(delta.content);
          if (obj.error) streamError = obj.error.message ?? String(obj.error);
        } catch {
          /* partial line */
        }
      }
    },
    { headers: authHeaders(cfg), signal: req.signal },
  );
  split.flush();
  if (streamError) throw new HttpError(500, streamError);
  return { text, thinking };
}

export async function embed(cfg: ProviderConfig, model: string, input: string[]): Promise<number[][]> {
  const base = normalizeBase(cfg);
  if (cfg.provider === 'ollama') {
    try {
      const res = await httpJSON<{ embeddings: number[][] }>(`${base}/api/embed`, { body: { model, input, truncate: true }, timeout: 120000 });
      return res.embeddings;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
      // Older Ollama: one prompt at a time.
      const out: number[][] = [];
      for (const prompt of input) {
        const r = await httpJSON<{ embedding: number[] }>(`${base}/api/embeddings`, { body: { model, prompt }, timeout: 60000 });
        out.push(r.embedding);
      }
      return out;
    }
  }
  const res = await httpJSON<{ data: { embedding: number[]; index: number }[] }>(`${base}/embeddings`, {
    body: { model, input },
    headers: authHeaders(cfg),
    timeout: 120000,
  });
  return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export interface DetectedServer {
  provider: ProviderKind;
  baseUrl: string;
  label: string;
  models: ModelInfo[];
}

const CANDIDATES: { provider: ProviderKind; baseUrl: string; label: string }[] = [
  { provider: 'ollama', baseUrl: 'http://localhost:11434', label: 'Ollama' },
  { provider: 'openai', baseUrl: 'http://localhost:1234/v1', label: 'LM Studio' },
  { provider: 'openai', baseUrl: 'http://localhost:8080/v1', label: 'llama.cpp server' },
  { provider: 'openai', baseUrl: 'http://localhost:1337/v1', label: 'Jan' },
  { provider: 'openai', baseUrl: 'http://localhost:8000/v1', label: 'vLLM / LocalAI' },
];

/** Probes the usual local ports and returns every server that answers. */
export async function detectServers(extra?: ProviderConfig): Promise<DetectedServer[]> {
  const list = [...CANDIDATES];
  if (extra && !list.some((c) => c.baseUrl === normalizeBase(extra))) list.unshift({ ...extra, label: 'Custom server' });
  const results = await Promise.all(
    list.map(async (c) => {
      try {
        const models = await listModels(c);
        return { ...c, models } as DetectedServer;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is DetectedServer => !!r);
}

const CHAT_PREFERENCE = [/qwen2\.5-?vl/i, /qwen3-?vl/i, /gemma-?3/i, /qwen3/i, /llama-?3\.[123]/i, /qwen2\.5/i, /mistral/i, /phi-?4/i, /llama/i];

/** Picks sensible default models from a server's model list. */
export function pickDefaults(models: ModelInfo[]) {
  const chatCandidates = models.filter((m) => !m.embedding);
  const ranked = [...chatCandidates].sort((a, b) => {
    const ra = CHAT_PREFERENCE.findIndex((r) => r.test(a.name));
    const rb = CHAT_PREFERENCE.findIndex((r) => r.test(b.name));
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  const chatModel = ranked[0]?.name ?? '';
  const vision = ranked.find((m) => m.vision)?.name ?? '';
  const embedModel = models.find((m) => m.embedding)?.name ?? '';
  return { chatModel, visionModel: vision, embedModel };
}
