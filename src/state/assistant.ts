import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage } from '../lib/ai/providers';
import { chatRobust, effectiveCtx, type Metrics } from '../lib/ai/engine';
import {
  HOMEWORK_MODES,
  MODE_INSTRUCTIONS,
  homeworkSystemPrompt,
  librarySystemPrompt,
  modeQuestion,
  noteSystemPrompt,
  STUDY_TOOLS,
  type AskMode,
  type StudyTool,
} from '../lib/ai/prompts';
import { blockToText, docToText, estimateTokens, fitToBudget } from '../lib/ai/context';
import { chunkVault, formatExcerpts, type Hit, type Scope } from '../lib/ai/rag';
import { parseStudyJSON } from '../lib/ai/study';
import { homeworkSources } from '../lib/homework';
import { classInfo, classOfNote } from '../lib/classes';
import { useAI, visionModel } from './ai';
import { useVault } from './vault';
import { editors } from '../editor/registry';
import { uid } from '../lib/util';
import { sampleLibrary, searchLibrary } from './library';

export interface Attachment {
  id: string;
  kind: 'image' | 'text';
  label: string;
  /** Base64 PNG for images. */
  image?: string;
  /** Text content (selection, transcript, typed text in a region). */
  text?: string;
}

export interface SourceRef {
  n: number;
  noteId: string;
  title: string;
  section: string;
  folder: string;
  blockId: string | null;
  text: string;
}

export type MsgPhase = 'reading' | 'loading' | 'retrying' | 'repairing';

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  attachments?: Attachment[];
  mode?: AskMode;
  tool?: StudyTool;
  status?: 'streaming' | 'done' | 'error' | 'stopped';
  /** What the harness is doing before tokens arrive. */
  phase?: MsgPhase;
  error?: string;
  model?: string;
  sources?: SourceRef[];
  /** Block the question was about — replies are inserted right after it. */
  anchor?: string;
  /** The reply hit the token limit; it can be continued. */
  truncated?: boolean;
  metrics?: Metrics;
  /** Answers that must come from the notes get a grounding check in the UI. */
  grounding?: 'homework' | 'library';
  /** Library questions remember their scope (for retry). */
  scope?: Scope;
  scopeLabel?: string;
  at: number;
}

export interface Thread {
  key: string;
  messages: ChatMsg[];
}

interface Draft {
  attachments: Attachment[];
  text: string;
  mode: 'chat' | 'tutor';
}

interface AssistantState {
  threads: Record<string, Thread>;
  drafts: Record<string, Draft>;
  streaming: string | null;
  /** Bumped to ask the composer to focus. */
  focusTick: number;
  draft(key: string): Draft;
  setDraft(key: string, patch: Partial<Draft>): void;
  attach(key: string, att: Omit<Attachment, 'id'>): void;
  detach(key: string, id: string): void;
  ask(noteId: string, opts: { prompt?: string; mode?: AskMode; attachments?: Attachment[]; anchor?: string }): Promise<void>;
  askLibrary(opts: { prompt: string; scope: Scope; scopeLabel?: string; tool?: StudyTool }): Promise<void>;
  /** Picks up a reply that stopped at the token limit. */
  continueReply(key: string, msgId: string): Promise<void>;
  regenerate(key: string): void;
  stop(): void;
  clear(key: string): void;
  focus(): void;
}

let controller: AbortController | null = null;

interface StreamOpts {
  label: string;
  temperature?: number;
  json?: boolean;
  /** Text already shown (when continuing a cut-off reply). */
  prefix?: string;
}

/** The exact request behind each reply, so a cut-off answer can be continued. */
const lastRequests = new Map<string, { messages: ChatMessage[]; model: string; opts: StreamOpts }>();

const CONTINUE_PROMPT = 'Continue exactly where you stopped, mid-sentence if needed. Do not repeat anything or add a preamble.';

const emptyDraft = (): Draft => ({ attachments: [], text: '', mode: 'chat' });

export const LIBRARY_KEY = 'library';

const OFFLINE = 'Your local model server isn’t reachable. Start Ollama or LM Studio, then press Detect in Settings → AI.';

export const useAssistant = create<AssistantState>()(
  persist(
    (set, get) => {
      const patchMsg = (key: string, id: string, patch: Partial<ChatMsg> | ((m: ChatMsg) => Partial<ChatMsg>)) => {
        const t = get().threads[key];
        if (!t) return;
        set({
          threads: {
            ...get().threads,
            [key]: { ...t, messages: t.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)) },
          },
        });
      };

      const push = (key: string, ...msgs: ChatMsg[]) => {
        const t = get().threads[key] ?? { key, messages: [] };
        set({ threads: { ...get().threads, [key]: { ...t, messages: [...t.messages, ...msgs] } } });
      };

      /**
       * Streams a completion into an assistant message through the engine
       * (queueing, retries, "loading model" status, metrics). Resolves with the
       * final text, or null if it failed or was stopped.
       */
      const stream = async (key: string, msgId: string, messages: ChatMessage[], model: string, opts: StreamOpts): Promise<string | null> => {
        controller?.abort();
        const ctrl = new AbortController();
        controller = ctrl;
        set({ streaming: key });
        let buf = opts.prefix ?? '';
        let think = '';
        let raf = 0;
        const flush = () => {
          raf = 0;
          patchMsg(key, msgId, { content: buf, thinking: think || undefined });
        };
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(flush);
        };
        try {
          const ai = useAI.getState();
          const res = await chatRobust({
            label: opts.label,
            model,
            messages,
            json: opts.json,
            temperature: opts.temperature ?? ai.temperature,
            priority: 'interactive',
            signal: ctrl.signal,
            onStatus: (s) => patchMsg(key, msgId, { phase: s ?? undefined }),
            onToken: (t) => {
              buf += t;
              schedule();
            },
            onThinking: (t) => {
              think += t;
              schedule();
            },
          });
          if (raf) cancelAnimationFrame(raf);
          // Some servers don't stream (or stream only thinking); fall back to the final text.
          if (buf === (opts.prefix ?? '') && res.text) buf += res.text;
          const content = buf.trim();
          lastRequests.set(msgId, { messages, model, opts: { ...opts, prefix: undefined } });
          if (lastRequests.size > 40) lastRequests.delete(lastRequests.keys().next().value!);
          patchMsg(key, msgId, {
            content,
            thinking: think || undefined,
            status: 'done',
            phase: undefined,
            model,
            metrics: res.metrics,
            truncated: res.truncated,
          });
          return content;
        } catch (e) {
          if (raf) cancelAnimationFrame(raf);
          const aborted = (e as Error).name === 'AbortError' || ctrl.signal.aborted;
          patchMsg(key, msgId, {
            content: buf,
            thinking: think || undefined,
            status: aborted ? 'stopped' : 'error',
            phase: undefined,
            error: aborted ? undefined : friendlyError(e),
          });
          return null;
        } finally {
          if (controller === ctrl) controller = null;
          if (get().streaming === key) set({ streaming: null });
        }
      };

      /** Re-asks once for valid JSON when a study tool reply can't be parsed. */
      const repairStudyJSON = async (key: string, msgId: string, tool: StudyTool, text: string, messages: ChatMessage[], model: string) => {
        if ((tool !== 'flashcards' && tool !== 'quiz') || parseStudyJSON(tool, text)) return;
        patchMsg(key, msgId, { status: 'streaming', phase: 'repairing' });
        set({ streaming: key });
        try {
          const r = await chatRobust({
            label: `${STUDY_TOOLS[tool].label} (repair)`,
            model,
            json: true,
            temperature: 0,
            messages: [
              ...messages,
              { role: 'assistant', content: text.slice(0, 6000) },
              {
                role: 'user',
                content: 'That reply was not valid JSON in the requested shape. Reply again with ONLY the JSON object — no prose, no code fences.',
              },
            ],
          });
          patchMsg(
            key,
            msgId,
            parseStudyJSON(tool, r.text) ? { content: r.text.trim(), status: 'done', phase: undefined } : { status: 'done', phase: undefined },
          );
        } catch {
          patchMsg(key, msgId, { status: 'done', phase: undefined });
        } finally {
          if (get().streaming === key) set({ streaming: null });
        }
      };

      return {
        threads: {},
        drafts: {},
        streaming: null,
        focusTick: 0,

        draft: (key) => get().drafts[key] ?? emptyDraft(),
        setDraft: (key, patch) => set({ drafts: { ...get().drafts, [key]: { ...get().draft(key), ...patch } } }),
        attach: (key, att) => {
          const d = get().draft(key);
          const list = [...d.attachments.filter((a) => !(a.kind === att.kind && a.label === att.label && a.text === att.text)), { ...att, id: uid('a') }];
          set({ drafts: { ...get().drafts, [key]: { ...d, attachments: list.slice(-4) } } });
        },
        detach: (key, id) => {
          const d = get().draft(key);
          set({ drafts: { ...get().drafts, [key]: { ...d, attachments: d.attachments.filter((a) => a.id !== id) } } });
        },

        async ask(noteId, opts) {
          const ai = useAI.getState();
          const key = noteId;
          const draft = get().draft(key);
          const attachments = opts.attachments ?? draft.attachments;
          const mode: AskMode = opts.mode ?? (draft.mode === 'tutor' ? 'tutor' : 'custom');
          const label = attachments.some((a) => /in that area/.test(a.label))
            ? 'part of the page'
            : (attachments.find((a) => a.kind === 'image')?.label ?? attachments[0]?.label ?? 'note');
          const question = (opts.prompt ?? draft.text).trim() || modeQuestion(mode, label);
          set({ drafts: { ...get().drafts, [key]: { ...draft, text: '', attachments: [] } } });

          const { notes, folderMeta } = useVault.getState();
          const note = notes[noteId];
          const homework = !!note?.meta.homework;

          // Follow-ups without new context stay anchored to the problem being discussed.
          const previousAnchor = [...(get().threads[key]?.messages ?? [])].reverse().find((m) => m.role === 'user' && m.anchor)?.anchor;
          const anchor = opts.anchor ?? (!attachments.length ? previousAnchor : undefined) ?? currentBlockId(noteId);
          const userMsg: ChatMsg = { id: uid('m'), role: 'user', content: question, attachments, mode, anchor, at: Date.now() };
          const botMsg: ChatMsg = {
            id: uid('m'),
            role: 'assistant',
            content: '',
            status: 'streaming',
            mode,
            grounding: homework ? 'homework' : undefined,
            phase: homework ? 'reading' : undefined,
            at: Date.now(),
          };
          push(key, userMsg, botMsg);

          if (ai.status !== 'online' || !ai.chatModel) {
            patchMsg(key, botMsg.id, { status: 'error', phase: undefined, error: ai.status === 'offline' ? OFFLINE : 'Choose a model in Settings → AI.' });
            return;
          }

          const ed = editors.get(noteId);
          const content = ed && !ed.isDestroyed ? ed.getJSON() : note?.content;
          const images = attachments.filter((a) => a.kind === 'image' && a.image).map((a) => a.image!);
          const vm = visionModel();
          const useImages = images.length > 0 && !!vm;
          const model = useImages ? vm! : ai.chatModel;
          const ctx = effectiveCtx(model);
          // In homework, the problem under the caret is what the student means by "this".
          const caret = homework && !attachments.length ? caretContext(noteId) : undefined;
          const focus = attachments.find((a) => a.kind === 'text')?.text ?? caret;
          const classPath = classOfNote(note, folderMeta);
          const className = classPath ? classInfo(classPath, folderMeta[classPath]).name : undefined;
          const title = note?.meta.title || 'Untitled';

          let system: string;
          let instructions = MODE_INSTRUCTIONS[mode];
          let temperature = ai.temperature;
          if (homework && note) {
            // Homework: the answer may only use the linked notes. Include every
            // linked passage when it fits, otherwise the most relevant ones.
            const linked = homeworkSources(note, notes);
            const hwText = fitToBudget(docToText(content), Math.floor(ctx * 0.18), focus);
            const hits = await homeworkExcerpts(linked, [question, focus ?? '', hwText.slice(0, 1600)].join('\n'), Math.floor(ctx * 0.42));
            patchMsg(key, botMsg.id, { sources: toSources(hits), phase: undefined });
            system = homeworkSystemPrompt(title, hwText, formatExcerpts(hits), linked.length, className);
            instructions = HOMEWORK_MODES[mode];
            temperature = Math.min(temperature, 0.15);
          } else {
            const noteText = fitToBudget(docToText(content), Math.floor(ctx * 0.55), focus);
            system = noteSystemPrompt(title, noteText, { hasImage: useImages, visionAvailable: !!vm, className });
          }

          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status !== 'error');
          const history = trimHistory(
            prior.slice(-8).map((m) => ({ role: m.role, content: m.role === 'user' ? withAttachmentText(m.content, m.attachments) : m.content })),
            Math.floor(ctx * 0.15),
          );
          let userContent = withAttachmentText(question, attachments);
          if (caret) userContent = `The student's cursor is on this part of the homework:\n"""\n${caret}\n"""\n\n${userContent}`;
          if (images.length && !useImages)
            userContent +=
              '\n\n(The student attached a picture of their handwriting, but no image-capable model is configured, so you only have the transcript above, if any.)';
          if (instructions) userContent = `${instructions}\n\n${userContent}`;
          await stream(
            key,
            botMsg.id,
            [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent, images: useImages ? images : undefined }],
            model,
            { label: homework ? `Homework · ${title}` : `Ask · ${title}`, temperature },
          );
        },

        async askLibrary({ prompt, scope, scopeLabel, tool }) {
          const ai = useAI.getState();
          const key = LIBRARY_KEY;
          const question = tool ? STUDY_TOOLS[tool].label : prompt.trim();
          const userMsg: ChatMsg = { id: uid('m'), role: 'user', content: question, tool, scope, scopeLabel, at: Date.now() };
          const botMsg: ChatMsg = {
            id: uid('m'),
            role: 'assistant',
            content: '',
            status: 'streaming',
            tool,
            phase: 'reading',
            grounding: tool ? undefined : 'library',
            scopeLabel,
            at: Date.now(),
          };
          push(key, userMsg, botMsg);
          if (ai.status !== 'online' || !ai.chatModel) {
            patchMsg(key, botMsg.id, { status: 'error', phase: undefined, error: OFFLINE });
            return;
          }
          let hits: Hit[] = [];
          try {
            // Study tools without a topic cover the whole scope; otherwise retrieve.
            hits = tool && !prompt.trim() ? sampleLibrary(scope, 12) : await searchLibrary(prompt, scope, tool ? 10 : 7);
          } catch (e) {
            console.warn('retrieval failed', e);
          }
          patchMsg(key, botMsg.id, { sources: toSources(hits), phase: undefined });
          const model = ai.chatModel;
          const ctx = effectiveCtx(model);
          const system = librarySystemPrompt(formatExcerpts(fitHits(hits, Math.floor(ctx * 0.6))), ai.strictLibrary || !!tool, scopeLabel);
          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status === 'done' && !m.tool);
          const history = trimHistory(
            prior.slice(-6).map((m) => ({ role: m.role, content: m.content })),
            Math.floor(ctx * 0.12),
          );
          const userContent = tool ? `${STUDY_TOOLS[tool].prompt}${prompt ? `\nFocus: ${prompt}` : ''}` : prompt;
          const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }];
          const json = tool === 'flashcards' || tool === 'quiz';
          const text = await stream(key, botMsg.id, messages, model, {
            label: tool ? `${STUDY_TOOLS[tool].label}${scopeLabel ? ` · ${scopeLabel}` : ''}` : `Ask your notes${scopeLabel ? ` · ${scopeLabel}` : ''}`,
            json,
            temperature: json ? 0.2 : undefined,
          });
          if (text !== null && tool) await repairStudyJSON(key, botMsg.id, tool, text, messages, model);
        },

        async continueReply(key, msgId) {
          const req = lastRequests.get(msgId);
          const msg = get().threads[key]?.messages.find((m) => m.id === msgId);
          if (!req || !msg) return;
          patchMsg(key, msgId, { status: 'streaming', truncated: false });
          await stream(key, msgId, [...req.messages, { role: 'assistant', content: msg.content }, { role: 'user', content: CONTINUE_PROMPT }], req.model, {
            ...req.opts,
            label: `${req.opts.label} (continued)`,
            prefix: msg.content + (/\s$/.test(msg.content) ? '' : ' '),
          });
          // Later continues should see the whole reply so far, from the original request.
          const cur = lastRequests.get(msgId);
          if (cur) lastRequests.set(msgId, { ...cur, messages: req.messages });
        },

        regenerate(key) {
          const t = get().threads[key];
          if (!t) return;
          const lastUser = [...t.messages].reverse().find((m) => m.role === 'user');
          if (!lastUser) return;
          const idx = t.messages.indexOf(lastUser);
          set({ threads: { ...get().threads, [key]: { ...t, messages: t.messages.slice(0, idx) } } });
          if (key === LIBRARY_KEY)
            void get().askLibrary({
              prompt: lastUser.tool ? '' : lastUser.content,
              scope: lastUser.scope ?? { kind: 'all' },
              scopeLabel: lastUser.scopeLabel,
              tool: lastUser.tool,
            });
          else void get().ask(key, { prompt: lastUser.content, mode: lastUser.mode, attachments: lastUser.attachments, anchor: lastUser.anchor });
        },

        stop() {
          controller?.abort();
        },

        clear(key) {
          if (get().streaming === key) controller?.abort();
          const threads = { ...get().threads };
          delete threads[key];
          set({ threads });
        },

        focus() {
          set({ focusTick: get().focusTick + 1 });
        },
      };
    },
    {
      name: 'nib.assistant',
      partialize: (s) => ({
        // Keep history light: no images, last 40 messages per thread.
        threads: Object.fromEntries(
          Object.entries(s.threads).map(([k, t]) => [
            k,
            {
              ...t,
              messages: t.messages.slice(-40).map((m) => ({
                ...m,
                status: m.status === 'streaming' ? 'stopped' : m.status,
                phase: undefined,
                truncated: undefined,
                attachments: m.attachments?.map((a) => ({ ...a, image: undefined })),
              })),
            },
          ]),
        ),
      }),
    },
  ),
);

function toSources(hits: Hit[]): SourceRef[] {
  return hits.map((h, i) => ({
    n: i + 1,
    noteId: h.chunk.noteId,
    title: h.chunk.title,
    section: h.chunk.section,
    folder: h.chunk.folder,
    blockId: h.chunk.blockIds[0] ?? null,
    text: h.chunk.text,
  }));
}

/** Keeps the best hits that fit in a token budget. */
function fitHits(hits: Hit[], budget: number): Hit[] {
  const out: Hit[] = [];
  let used = 0;
  for (const h of hits) {
    const t = estimateTokens(h.chunk.text) + 24;
    if (used + t > budget && out.length) break;
    out.push(h);
    used += t;
  }
  return out;
}

/**
 * Passages from the notes linked to a homework. When everything fits in the
 * budget the model sees all of it (in note order), so nothing the teacher
 * wrote is missed; otherwise the most relevant passages.
 */
export async function homeworkExcerpts(linked: { meta: { id: string } }[], query: string, budget: number): Promise<Hit[]> {
  if (!linked.length) return [];
  const notes = useVault.getState().notes;
  const all = chunkVault(linked.map((n) => notes[n.meta.id]).filter(Boolean)).filter((c) => c.text.trim());
  const total = all.reduce((s, c) => s + estimateTokens(c.text) + 24, 0);
  if (total <= budget && all.length <= 30) return all.map((chunk) => ({ chunk, score: 0, keyword: 0, semantic: null }));
  const ids = linked.map((n) => n.meta.id);
  let hits: Hit[] = [];
  try {
    hits = await searchLibrary(query, { kind: 'notes', ids }, 14);
  } catch {
    hits = [];
  }
  if (!hits.length) hits = sampleLibrary({ kind: 'notes', ids }, 10);
  return fitHits(hits, budget);
}

/** Most recent turns that fit in the budget; very long turns are shortened. */
function trimHistory(msgs: ChatMessage[], budget: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    let content = msgs[i].content;
    if (estimateTokens(content) > budget / 2) content = `${content.slice(0, Math.floor(budget * 1.6))}…`;
    const t = estimateTokens(content);
    if (used + t > budget) break;
    out.unshift({ ...msgs[i], content });
    used += t;
  }
  // A history must not start with an assistant turn.
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

/** Text of the list item (one problem) or block holding the caret. */
function caretContext(noteId: string): string | undefined {
  const ed = editors.get(noteId);
  if (!ed || ed.isDestroyed) return undefined;
  const { $from } = ed.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'listItem' || n.type.name === 'taskItem') return blockToText(n.toJSON()).trim() || undefined;
  }
  if ($from.depth < 1) return undefined;
  const top = $from.node(1);
  if (top.type.name === 'heading' || !top.textContent.trim()) return undefined;
  return blockToText(top.toJSON()).trim().slice(0, 1200) || undefined;
}

/** Id of the top-level block holding the caret in a note's editor. */
function currentBlockId(noteId: string): string | undefined {
  const ed = editors.get(noteId);
  if (!ed || ed.isDestroyed) return undefined;
  const { $to } = ed.state.selection;
  const node = $to.depth > 0 ? $to.node(1) : ed.state.doc.nodeAt($to.pos);
  return (node?.attrs.id as string | undefined) ?? undefined;
}

function withAttachmentText(question: string, attachments?: Attachment[]): string {
  const parts: string[] = [];
  for (const a of attachments ?? []) {
    if (a.text) parts.push(`${a.label}:\n"""\n${a.text.trim()}\n"""`);
  }
  return parts.length ? `${parts.join('\n\n')}\n\n${question}` : question;
}

export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/model .* not found|not found, try pulling/i.test(msg)) return `${msg}. Pull it with Ollama or pick another model in Settings → AI.`;
  if (/does not support (images|vision)|image input/i.test(msg))
    return 'This model can’t read images. Choose a vision model (e.g. qwen2.5vl, gemma3, llama3.2-vision) in Settings → AI.';
  if (/ECONNREFUSED|Failed to fetch|fetch failed|NetworkError|HTTP 0/i.test(msg))
    return 'Couldn’t reach your local model server. Is Ollama / LM Studio running?';
  if (/context|too long|num_ctx/i.test(msg)) return `${msg} — try a shorter question or raise the context size in Settings → AI.`;
  if (/HTTP 5\d\d/.test(msg)) return `The model server had a problem (${msg}). It was retried automatically; try again in a moment.`;
  return msg;
}
