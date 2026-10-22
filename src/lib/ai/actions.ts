import type { ChatMessage } from './providers';
import { TRANSCRIBE_PROMPT } from './prompts';
import { useAI, visionModel } from '../../state/ai';
import { chatRobust, type Priority } from './engine';
import type { InkTranscript, Stroke } from '../ink/types';
import { rasterizeStrokes } from '../ink/raster';
import { parseJSONLoose } from './json';

export { parseJSONLoose } from './json';

export class NoVisionModelError extends Error {
  constructor() {
    super(
      'No model that can read images is configured. Pull one with “ollama pull qwen2.5vl:7b” (or gemma3, llama3.2-vision) and pick it in Settings → Local AI.',
    );
  }
}

export interface CompleteOpts {
  json?: boolean;
  signal?: AbortSignal;
  vision?: boolean;
  temperature?: number;
  /** Shown in Settings → Local AI → Activity. */
  label?: string;
  /** Background work yields to anything the student is waiting for. */
  priority?: Priority;
  maxTokens?: number;
}

/** One-shot completion with the configured chat (or vision) model, through the engine. */
export async function complete(messages: ChatMessage[], opts: CompleteOpts = {}) {
  const s = useAI.getState();
  const model = opts.vision ? visionModel() : s.chatModel;
  if (!model) throw opts.vision ? new NoVisionModelError() : new Error('No chat model selected. Open Settings → Local AI.');
  return chatRobust({
    label: opts.label ?? (opts.vision ? 'Vision' : 'Completion'),
    model,
    messages,
    json: opts.json,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens,
    priority: opts.priority ?? 'interactive',
    signal: opts.signal,
  });
}

export async function transcribeImage(image: string, signal?: AbortSignal, priority: Priority = 'interactive'): Promise<InkTranscript> {
  const res = await complete([{ role: 'user', content: TRANSCRIBE_PROMPT, images: [image] }], {
    json: true,
    vision: true,
    signal,
    temperature: 0,
    label: priority === 'background' ? 'Read handwriting (background)' : 'Read handwriting',
    priority,
  });
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

export async function transcribeStrokes(strokes: Stroke[], signal?: AbortSignal, priority: Priority = 'interactive'): Promise<InkTranscript | null> {
  const image = rasterizeStrokes(strokes, null, { maxSide: 1280, minScale: 1.5 });
  if (!image) return null;
  return transcribeImage(image, signal, priority);
}
