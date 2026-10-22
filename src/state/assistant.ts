import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { chat, type ChatMessage } from '../lib/ai/providers';
import { MODE_INSTRUCTIONS, librarySystemPrompt, modeQuestion, noteSystemPrompt, STUDY_TOOLS, type AskMode, type StudyTool } from '../lib/ai/prompts';
import { docToText, fitToBudget } from '../lib/ai/context';
import { formatExcerpts, type Hit, type Scope } from '../lib/ai/rag';
import { providerConfig, useAI, visionModel } from './ai';
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

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  attachments?: Attachment[];
  mode?: AskMode;
  tool?: StudyTool;
  status?: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  model?: string;
  sources?: SourceRef[];
  /** Block the question was about — replies are inserted right after it. */
  anchor?: string;
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
  askLibrary(opts: { prompt: string; scope: Scope; tool?: StudyTool }): Promise<void>;
  regenerate(key: string): void;
  stop(): void;
  clear(key: string): void;
  focus(): void;
}

let controller: AbortController | null = null;

const emptyDraft = (): Draft => ({ attachments: [], text: '', mode: 'chat' });

export const LIBRARY_KEY = 'library';

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

      /** Streams a completion into an assistant message. */
      const stream = async (key: string, msgId: string, messages: ChatMessage[], model: string) => {
        controller?.abort();
        const ctrl = new AbortController();
        controller = ctrl;
        set({ streaming: key });
        let buf = '';
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
          await chat(providerConfig(), {
            model,
            messages,
            temperature: ai.temperature,
            numCtx: ai.numCtx,
            signal: ctrl.signal,
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
          patchMsg(key, msgId, { content: buf.trim(), thinking: think || undefined, status: 'done' });
        } catch (e) {
          if (raf) cancelAnimationFrame(raf);
          const aborted = (e as Error).name === 'AbortError' || ctrl.signal.aborted;
          patchMsg(key, msgId, {
            content: buf,
            thinking: think || undefined,
            status: aborted ? 'stopped' : 'error',
            error: aborted ? undefined : friendlyError(e),
          });
        } finally {
          if (controller === ctrl) controller = null;
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

          // Follow-ups without new context stay anchored to the problem being discussed.
          const previousAnchor = [...(get().threads[key]?.messages ?? [])].reverse().find((m) => m.role === 'user' && m.anchor)?.anchor;
          const anchor = opts.anchor ?? (!attachments.length ? previousAnchor : undefined) ?? currentBlockId(noteId);
          const userMsg: ChatMsg = { id: uid('m'), role: 'user', content: question, attachments, mode, anchor, at: Date.now() };
          const botMsg: ChatMsg = { id: uid('m'), role: 'assistant', content: '', status: 'streaming', mode, at: Date.now() };
          push(key, userMsg, botMsg);

          if (ai.status !== 'online' || !ai.chatModel) {
            patchMsg(key, botMsg.id, {
              status: 'error',
              error:
                ai.status === 'offline'
                  ? 'Your local model server isn’t reachable. Start Ollama or LM Studio, then press Detect in Settings → AI.'
                  : 'Choose a model in Settings → AI.',
            });
            return;
          }

          const note = useVault.getState().notes[noteId];
          const ed = editors.get(noteId);
          const content = ed && !ed.isDestroyed ? ed.getJSON() : note?.content;
          const images = attachments.filter((a) => a.kind === 'image' && a.image).map((a) => a.image!);
          const vm = visionModel();
          const useImages = images.length > 0 && !!vm;
          const model = useImages ? vm! : ai.chatModel;
          const budget = Math.max(1500, Math.floor(ai.numCtx * 0.55));
          const focus = attachments.find((a) => a.kind === 'text')?.text;
          const noteText = fitToBudget(docToText(content), budget, focus);
          const system = noteSystemPrompt(note?.meta.title || 'Untitled', noteText, { hasImage: useImages, visionAvailable: !!vm });

          const history: ChatMessage[] = [];
          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status !== 'error');
          for (const m of prior.slice(-8)) {
            history.push({ role: m.role, content: m.role === 'user' ? withAttachmentText(m.content, m.attachments) : m.content });
          }
          const instructions = MODE_INSTRUCTIONS[mode];
          let userContent = withAttachmentText(question, attachments);
          if (images.length && !useImages)
            userContent +=
              '\n\n(The student attached a picture of their handwriting, but no image-capable model is configured, so you only have the transcript above, if any.)';
          if (instructions) userContent = `${instructions}\n\n${userContent}`;
          await stream(
            key,
            botMsg.id,
            [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent, images: useImages ? images : undefined }],
            model,
          );
          patchMsg(key, botMsg.id, { model });
        },

        async askLibrary({ prompt, scope, tool }) {
          const ai = useAI.getState();
          const key = LIBRARY_KEY;
          const question = tool ? STUDY_TOOLS[tool].label : prompt.trim();
          const userMsg: ChatMsg = { id: uid('m'), role: 'user', content: question, tool, at: Date.now() };
          const botMsg: ChatMsg = { id: uid('m'), role: 'assistant', content: '', status: 'streaming', tool, at: Date.now() };
          push(key, userMsg, botMsg);
          if (ai.status !== 'online' || !ai.chatModel) {
            patchMsg(key, botMsg.id, {
              status: 'error',
              error: 'Your local model server isn’t reachable. Start Ollama or LM Studio, then press Detect in Settings → AI.',
            });
            return;
          }
          let hits: Hit[] = [];
          try {
            // Study tools without a topic cover the whole scope; otherwise retrieve.
            hits = tool && !prompt.trim() ? sampleLibrary(scope, 12) : await searchLibrary(prompt, scope, tool ? 10 : 7);
          } catch (e) {
            console.warn('retrieval failed', e);
          }
          const sources: SourceRef[] = hits.map((h, i) => ({
            n: i + 1,
            noteId: h.chunk.noteId,
            title: h.chunk.title,
            section: h.chunk.section,
            folder: h.chunk.folder,
            blockId: h.chunk.blockIds[0] ?? null,
            text: h.chunk.text,
          }));
          patchMsg(key, botMsg.id, { sources });
          const system = librarySystemPrompt(formatExcerpts(hits), ai.strictLibrary || !!tool);
          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status === 'done' && !m.tool);
          const history: ChatMessage[] = prior.slice(-6).map((m) => ({ role: m.role, content: m.content }));
          const userContent = tool ? `${STUDY_TOOLS[tool].prompt}${prompt ? `\nFocus: ${prompt}` : ''}` : prompt;
          await stream(key, botMsg.id, [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }], ai.chatModel);
          patchMsg(key, botMsg.id, { model: ai.chatModel });
        },

        regenerate(key) {
          const t = get().threads[key];
          if (!t) return;
          const lastUser = [...t.messages].reverse().find((m) => m.role === 'user');
          if (!lastUser) return;
          const idx = t.messages.indexOf(lastUser);
          set({ threads: { ...get().threads, [key]: { ...t, messages: t.messages.slice(0, idx) } } });
          if (key === LIBRARY_KEY) void get().askLibrary({ prompt: lastUser.content, scope: { kind: 'all' }, tool: lastUser.tool });
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
                attachments: m.attachments?.map((a) => ({ ...a, image: undefined })),
              })),
            },
          ]),
        ),
      }),
    },
  ),
);

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
  return msg;
}
