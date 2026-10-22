import { chat, type ChatMessage } from './providers';
import { TRANSCRIBE_PROMPT } from './prompts';
import { providerConfig, useAI, visionModel } from '../../state/ai';
import type { InkTranscript, Stroke } from '../ink/types';
import { rasterizeStrokes } from '../ink/raster';

/** Extracts the first JSON object/array from a model reply (tolerates code fences and chatter). */
export function parseJSONLoose<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through */
  }
  const starts = ['{', '['];
  for (const open of starts) {
    const close = open === '{' ? '}' : ']';
    const i = cleaned.indexOf(open);
    const j = cleaned.lastIndexOf(close);
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(cleaned.slice(i, j + 1)) as T;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

export class NoVisionModelError extends Error {
  constructor() {
    super('No model that can read images is configured. Pull one with “ollama pull qwen2.5vl:7b” (or gemma3, llama3.2-vision) and pick it in Settings → AI.');
  }
}

/** One-shot completion with the configured chat (or vision) model. */
export async function complete(messages: ChatMessage[], opts: { json?: boolean; signal?: AbortSignal; vision?: boolean; temperature?: number } = {}) {
  const s = useAI.getState();
  const model = opts.vision ? visionModel() : s.chatModel;
  if (!model) throw opts.vision ? new NoVisionModelError() : new Error('No chat model selected. Open Settings → AI.');
  const res = await chat(providerConfig(), {
    model,
    messages,
    json: opts.json,
    temperature: opts.temperature ?? 0.2,
    numCtx: s.numCtx,
    signal: opts.signal,
  });
  return { ...res, model };
}

export async function transcribeImage(image: string, signal?: AbortSignal): Promise<InkTranscript> {
  const res = await complete([{ role: 'user', content: TRANSCRIBE_PROMPT, images: [image] }], { json: true, vision: true, signal, temperature: 0 });
  const parsed = parseJSONLoose<Partial<InkTranscript>>(res.text);
  const kind = (['text', 'math', 'mixed', 'drawing'] as const).includes(parsed?.kind as never) ? (parsed!.kind as InkTranscript['kind']) : 'text';
  return {
    kind,
    text: String(parsed?.text ?? (parsed ? '' : res.text)).trim(),
    latex: parsed?.latex ? String(parsed.latex).trim() : undefined,
    description: parsed?.description ? String(parsed.description).trim() : undefined,
    model: res.model,
    at: Date.now(),
  };
}

export async function transcribeStrokes(strokes: Stroke[], signal?: AbortSignal): Promise<InkTranscript | null> {
  const image = rasterizeStrokes(strokes, null, { maxSide: 1280, minScale: 1.5 });
  if (!image) return null;
  return transcribeImage(image, signal);
}
