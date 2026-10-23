import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage } from '../lib/ai/providers';
import { chatJSON, chatRobust, effectiveCtx, type Metrics } from '../lib/ai/engine';
import {
  HOMEWORK_MODES,
  MODE_INSTRUCTIONS,
  homeworkSystemPrompt,
  isTransformPrompt,
  librarySystemPrompt,
  modeQuestion,
  NOTE_STARTERS,
  noteSystemPrompt,
  STUDY_TOOLS,
  TEXT_ACTIONS,
  transformSystemPrompt,
  type AskMode,
  type StudyTool,
} from '../lib/ai/prompts';
import { blockToText, docToText, estimateTokens, fitToBudget, withoutAssistant } from '../lib/ai/context';
import { chunkNote, chunkVault, formatExcerpts, rankChunks, type Chunk, type Hit, type Scope } from '../lib/ai/rag';
import { parseStudyJSON, verifyStudy } from '../lib/ai/study';
import { assessCoverage, findExamples, gapFillSystem, gateQuery, RULE_REMINDER, type CoverageLevel } from '../lib/ai/policy';
import { historyForModel, settleWeak, transformCheck, VERIFY_PROMPT, type ExcerptRef, type VerifyCtx, type VerifyMode } from '../lib/ai/verify';
import { parseJSONLoose } from '../lib/ai/json';
import { finishGrounded, leaveOutOwn, shownOf, type Banner, type CheckSummary, type Finished } from '../lib/ai/answer';
import { boxBody } from '../lib/ai/markdown';
import type { NoteDoc } from '../lib/vault/types';
import { homeworkSources } from '../lib/homework';
import { classInfo, classOfNote } from '../lib/classes';
import { useAI, visionModel, type AIStatus } from './ai';
import { useVault } from './vault';
import { editors } from '../editor/registry';
import { uid } from '../lib/util';
import { sampleLibrary, searchLibrary, semanticCalib, vaultStats } from './library';

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
  /** The picture of their work the student attached (not a passage of the notes). */
  visual?: boolean;
}

export type MsgPhase = 'reading' | 'loading' | 'retrying' | 'repairing' | 'general' | 'checking';

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** What the student's bubble shows when `content` is the app's own prompt (a menu action's name). */
  label?: string;
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
  /** Homework: the problem text the question was about (kept so follow-ups and Retry stay on it). Study tools: their topic. */
  focus?: string;
  /** The reply hit the token limit; it can be continued. */
  truncated?: boolean;
  metrics?: Metrics;
  /**
   * Every answer is held to the notes: `note` (the open note), `homework`,
   * `library` (Ask your notes). `transform` rewrites or translates the
   * student's own passage and is checked for anything it adds.
   */
  grounding?: 'note' | 'homework' | 'library' | 'transform';
  /** What is shown, inserted and copied: the reply after the notes-only check (unsupported parts boxed). */
  shown?: string;
  check?: CheckSummary;
  /** What the model said the notes don't contain. */
  gaps?: string[];
  coverage?: CoverageLevel;
  banner?: Banner;
  /** Closest passages, when the notes don't cover the question. */
  nearest?: SourceRef[];
  /** The notes didn't cover the question: the whole reply is the model's own knowledge. */
  ownOnly?: boolean;
  /** Rewrites/translations: names, numbers or formulas the model added that the passage doesn't have. */
  added?: string[];
  /** Study tools: items dropped because no excerpt backed them. */
  dropped?: number;
  /** Search the notes even though the coverage check said they don't cover this. */
  forced?: boolean;
  /** The question this answers (rewrites: which action). */
  question?: string;
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
  ask(
    noteId: string,
    opts: {
      prompt?: string;
      /** Shown in the student's bubble instead of `prompt` (e.g. "Give an example"); the model still gets the prompt. */
      label?: string;
      mode?: AskMode;
      attachments?: Attachment[];
      anchor?: string;
      /** Homework problem text to use instead of the caret (Retry). */
      focus?: string;
      /** A follow-up about the same problem (e.g. "Give me another hint"), wherever the caret is now. */
      inherit?: boolean;
      /** Answer from the notes even if the coverage check says they don't cover it. */
      force?: boolean;
    },
  ): Promise<void>;
  askLibrary(opts: { prompt: string; scope: Scope; scopeLabel?: string; tool?: StudyTool; force?: boolean }): Promise<void>;
  /** "Search my notes anyway": re-asks the last question without the coverage check. */
  forceNotes(key: string): void;
  /** Picks up a reply that stopped at the token limit. */
  continueReply(key: string, msgId: string): Promise<void>;
  regenerate(key: string): void;
  stop(): void;
  clear(key: string): void;
  focus(): void;
}

let controller: AbortController | null = null;

/** How a grounded reply is checked when it's done (kept so Continue re-checks the whole reply). */
interface FinishSpec {
  excerpts: [number, ExcerptRef][];
  /** The student's own question and work: restating it needs no source. */
  context: string;
  mode: VerifyMode;
  question: string;
  className?: string;
  /** What the coverage check said before the call (a refusal after 'full' points the student at the passages). */
  gate?: CoverageLevel;
}

interface StreamOpts {
  label: string;
  temperature?: number;
  json?: boolean;
  /** Text already shown (when continuing a cut-off reply). */
  prefix?: string;
  finish?: FinishSpec;
  /** The caller marks the reply done (after checking it). */
  holdDone?: boolean;
}

/** The exact request behind each reply, so a cut-off answer can be continued. */
const lastRequests = new Map<string, { messages: ChatMessage[]; model: string; opts: StreamOpts; raw: string }>();

/** Grounded answers run cool: the notes, not the model's imagination. */
const groundedTemp = (t: number) => Math.min(t, 0.15);

const CONTINUE_PROMPT =
  'Your reply was cut off. Continue it exactly where it stopped. Start by repeating the last five words you wrote, word for word, then carry on. No preamble, no other repetition.';

/**
 * Joins a continuation onto the text that was cut off. The model is asked to
 * repeat its last few words, so the overlap is removed — this also gets the
 * spacing right whether the cut fell between words or in the middle of one.
 */
export function joinContinuation(prefix: string, cont: string): string {
  const c = cont.replace(/^[ \t]+/, '');
  for (let k = Math.min(c.length, prefix.length, 200); k >= 8; k--) {
    if (prefix.endsWith(c.slice(0, k))) return prefix + c.slice(k);
  }
  // No overlap: the model just carried on.
  if (!c || /\s$/.test(prefix) || /^\s/.test(c) || /^[.,;:!?)\]}'’"”]/.test(c)) return prefix + c;
  return `${prefix} ${c}`;
}

const emptyDraft = (): Draft => ({ attachments: [], text: '', mode: 'chat' });

export const LIBRARY_KEY = 'library';

const OFFLINE = 'Your local model server isn’t reachable. Start Ollama or LM Studio, then press Detect in Settings → Local AI.';
const NO_MODEL = 'Choose a model in Settings → Local AI.';
const STILL_STARTING = 'The local model is taking a long time to start. Try again in a moment, or check Settings → Local AI.';
/** How long a question asked while the model server is still being found waits for it. */
const MODEL_WAIT_MS = 20000;
const starting = (status: AIStatus) => status === 'unknown' || status === 'checking';

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
       * Whether the local model can answer the question just pushed. While the server is still being
       * found, the question waits for it (the reply shows its typing dots, and Stop works) rather than
       * failing at once. When it can't be answered, the reply already says why.
       */
      const modelReady = async (key: string, msgId: string): Promise<boolean> => {
        if (starting(useAI.getState().status)) {
          controller?.abort();
          const ctrl = new AbortController();
          controller = ctrl;
          set({ streaming: key });
          patchMsg(key, msgId, { phase: undefined });
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let unsub = () => {};
            const done = () => {
              clearTimeout(timer);
              unsub();
              ctrl.signal.removeEventListener('abort', done);
              resolve();
            };
            timer = setTimeout(done, MODEL_WAIT_MS);
            unsub = useAI.subscribe((s) => void (starting(s.status) || done()));
            ctrl.signal.addEventListener('abort', done);
          });
          if (controller === ctrl) controller = null;
          if (get().streaming === key) set({ streaming: null });
          // Stopped, or the conversation moved on (New conversation, Retry) while it waited.
          const m = get().threads[key]?.messages.find((x) => x.id === msgId);
          if (m?.status !== 'streaming') return false;
          if (ctrl.signal.aborted) {
            patchMsg(key, msgId, { status: 'stopped' });
            return false;
          }
          patchMsg(key, msgId, { phase: 'reading' });
        }
        const ai = useAI.getState();
        if (ai.status === 'online' && ai.chatModel) return true;
        patchMsg(key, msgId, {
          status: 'error',
          phase: undefined,
          error: ai.status === 'online' ? NO_MODEL : starting(ai.status) ? STILL_STARTING : OFFLINE,
        });
        return false;
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
        // Continuing: hold the first characters until the overlap with the cut-off text can be removed.
        let cont = '';
        let joined = opts.prefix === undefined;
        const settle = (final: boolean) => {
          if (joined || (!final && cont.length < 60)) return;
          buf = joinContinuation(opts.prefix!, cont);
          joined = true;
        };
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
              if (!joined) {
                cont += t;
                settle(false);
              } else buf += t;
              schedule();
            },
            onThinking: (t) => {
              think += t;
              schedule();
            },
          });
          if (raf) cancelAnimationFrame(raf);
          // Superseded by a newer request that aborted us after the server had already finished.
          if (ctrl.signal.aborted) {
            patchMsg(key, msgId, { content: buf.trim(), status: 'stopped', phase: undefined });
            if (opts.finish) checkPartial(key, msgId, buf.trim(), opts.finish);
            return null;
          }
          // Some servers don't stream (or stream only thinking); fall back to the final text.
          if (!joined && !cont && res.text) cont = res.text;
          settle(true);
          if (buf === (opts.prefix ?? '') && res.text && opts.prefix === undefined) buf += res.text;
          const content = buf.trim();
          // The untrimmed text is kept so Continue joins exactly where the model stopped.
          lastRequests.set(msgId, { messages, model, opts: { ...opts, prefix: undefined }, raw: buf });
          if (lastRequests.size > 40) lastRequests.delete(lastRequests.keys().next().value!);
          patchMsg(key, msgId, {
            content,
            thinking: think || undefined,
            status: opts.finish || opts.holdDone ? 'streaming' : 'done',
            phase: undefined,
            model,
            metrics: res.metrics,
            truncated: res.truncated,
          });
          if (opts.finish) {
            await finalize(key, msgId, content, opts.finish, model);
            const m = get().threads[key]?.messages.find((x) => x.id === msgId);
            if (m?.status === 'streaming') patchMsg(key, msgId, { status: 'done' });
          }
          return content;
        } catch (e) {
          if (raf) cancelAnimationFrame(raf);
          if (!joined && cont) buf = joinContinuation(opts.prefix!, cont);
          const aborted = (e as Error).name === 'AbortError' || ctrl.signal.aborted;
          patchMsg(key, msgId, {
            content: buf,
            thinking: think || undefined,
            status: aborted ? 'stopped' : 'error',
            phase: undefined,
            error: aborted ? undefined : friendlyError(e),
          });
          // What arrived before it stopped is checked like a finished answer (never shown raw).
          if (opts.finish) checkPartial(key, msgId, buf.trim(), opts.finish);
          return null;
        } finally {
          // Only the current stream owns the flags: an older, aborted one must not clear a newer one's.
          if (controller === ctrl) {
            controller = null;
            if (get().streaming === key) set({ streaming: null });
          }
        }
      };

      /** Cards or a quiz the model's reply couldn't be read as: an error, never its raw text. */
      const unreadable = (tool: StudyTool): Partial<ChatMsg> => ({
        content: '',
        status: 'error',
        phase: undefined,
        error: `The model’s reply couldn’t be read as ${tool === 'quiz' ? 'a quiz' : 'flashcards'}. Try again, or pick a larger model in Settings → Local AI.`,
      });

      /** Re-asks once for valid JSON when a study tool reply can't be parsed. */
      const repairStudyJSON = async (key: string, msgId: string, tool: StudyTool, text: string, messages: ChatMessage[], model: string) => {
        if ((tool !== 'flashcards' && tool !== 'quiz') || parseStudyJSON(tool, text)) return;
        patchMsg(key, msgId, { status: 'streaming', phase: 'repairing' });
        controller?.abort();
        const ctrl = new AbortController();
        controller = ctrl;
        set({ streaming: key });
        try {
          const r = await chatRobust({
            label: `${STUDY_TOOLS[tool].label} (repair)`,
            model,
            json: true,
            temperature: 0,
            signal: ctrl.signal,
            messages: [
              ...messages,
              { role: 'assistant', content: text.slice(0, 6000) },
              {
                role: 'user',
                content: 'That reply was not valid JSON in the requested shape. Reply again with ONLY the JSON object — no prose, no code fences.',
              },
            ],
          });
          patchMsg(key, msgId, parseStudyJSON(tool, r.text) ? { content: r.text.trim(), status: 'done', phase: undefined } : unreadable(tool));
        } catch {
          // Stopped: say so; failed: say that too — the model's unchecked text is never shown instead.
          patchMsg(key, msgId, ctrl.signal.aborted ? { status: 'stopped', phase: undefined } : unreadable(tool));
        } finally {
          if (controller === ctrl) {
            controller = null;
            if (get().streaming === key) set({ streaming: null });
          }
        }
      };

      /** The check alone, for a reply that stopped early (no double-check, no general-knowledge call). */
      const checkPartial = (key: string, msgId: string, raw: string, spec: FinishSpec) => {
        if (!raw) return;
        const { idf, inVault } = vaultStats();
        const f = finishGrounded(raw, { excerpts: new Map(spec.excerpts), context: spec.context, mode: spec.mode, idf, inVault }, { question: spec.question });
        patchMsg(key, msgId, { ...visible(f), check: f.check, gaps: f.gaps, coverage: f.coverage });
      };

      /** Set to answer only from the notes: what isn't from them is left out rather than boxed. */
      const visible = (f: Finished): { shown: string; banner?: Banner } =>
        useAI.getState().outsideKnowledge === 'never'
          ? { shown: leaveOutOwn(f.shown), banner: f.banner === 'collapsed' ? 'noneOff' : f.banner }
          : { shown: f.shown, banner: f.banner };

      /**
       * The notes-only check on a finished reply: unsupported statements are
       * boxed as the model's own knowledge, citations repaired, and whatever
       * the notes don't contain is answered separately and labelled.
       */
      const finalize = async (key: string, msgId: string, raw: string, spec: FinishSpec, model: string) => {
        const { idf, inVault } = vaultStats();
        const vctx = { excerpts: new Map(spec.excerpts), context: spec.context, mode: spec.mode, idf, inVault };
        let f = finishGrounded(raw, vctx, { question: spec.question });
        const show = () => {
          // The model refused although the check found the notes on topic: point at the passages themselves.
          const mayCover = f.coverage === 'none' && spec.gate === 'full';
          const sources = get().threads[key]?.messages.find((m) => m.id === msgId)?.sources ?? [];
          const v = visible(f);
          patchMsg(key, msgId, {
            shown: v.shown,
            check: f.check,
            gaps: f.gaps,
            coverage: f.coverage,
            banner: mayCover ? 'mayCover' : v.banner,
            nearest: mayCover ? sources.filter((x) => !x.visual).slice(0, 2) : undefined,
          });
        };
        show();
        if (f.weak.length && useAI.getState().doubleCheck) {
          const overrides = await doubleCheck(key, msgId, raw, f.weak.slice(0, 6), vctx, model);
          // Stopped: the reply stays as checked so far, with nothing more asked of the model.
          if (overrides === 'stopped') {
            patchMsg(key, msgId, { status: 'stopped' });
            return;
          }
          if (overrides) {
            f = finishGrounded(raw, { ...vctx, overrides }, { question: spec.question });
            show();
          }
        }
        if (f.gaps.length && !f.check.outside && useAI.getState().outsideKnowledge === 'auto')
          await generalAnswer(key, msgId, { question: spec.question, gaps: f.gaps, className: spec.className, base: f.shown, model });
      };

      /**
       * Loosely matched sentences: the model quotes the passage that says each
       * one (as a follow-up turn, so the server reuses its cache); code checks
       * the quote. Promoted only when the quote is really there; else boxed.
       */
      const doubleCheck = async (key: string, msgId: string, raw: string, weak: string[], vctx: VerifyCtx, model: string) => {
        const req = lastRequests.get(msgId);
        if (!req) return null;
        controller?.abort();
        const ctrl = new AbortController();
        controller = ctrl;
        set({ streaming: key });
        patchMsg(key, msgId, { status: 'streaming', phase: 'checking' });
        try {
          const { value } = await chatJSON(
            {
              label: 'Double-check',
              model,
              temperature: 0,
              maxTokens: 250,
              priority: 'interactive',
              signal: ctrl.signal,
              messages: [...req.messages, { role: 'assistant', content: raw }, { role: 'user', content: VERIFY_PROMPT(weak) }],
            },
            (v) => {
              const checks = (v as { checks?: unknown })?.checks;
              return Array.isArray(checks)
                ? checks.map((c: Record<string, unknown>) => ({ n: Number(c.n), excerpt: Number(c.excerpt), quote: String(c.quote ?? '') }))
                : null;
            },
            parseJSONLoose,
          );
          return settleWeak(weak, value, vctx.excerpts, vctx.idf, vctx.inVault);
        } catch {
          // Stopped or unreachable: the sentences stay marked as loosely matched, never promoted.
          return ctrl.signal.aborted ? ('stopped' as const) : null;
        } finally {
          patchMsg(key, msgId, { phase: undefined });
          if (controller === ctrl) {
            controller = null;
            if (get().streaming === key) set({ streaming: null });
          }
        }
      };

      /**
       * The only call allowed to use the model's own knowledge. Its whole reply
       * is put in a box labelled "Not from your notes — proceed with caution" by
       * the app, never by the model.
       */
      const generalAnswer = async (
        key: string,
        msgId: string,
        o: { question: string; gaps: string[]; className?: string; base?: string; model: string },
      ) => {
        controller?.abort();
        const ctrl = new AbortController();
        controller = ctrl;
        set({ streaming: key });
        const box = (t: string) => `${o.base ? `${o.base}\n\n` : ''}:::outside\n${boxBody(t)}\n:::`;
        patchMsg(key, msgId, { status: 'streaming', phase: 'general' });
        let buf = '';
        let raf = 0;
        try {
          const res = await chatRobust({
            label: o.base ? 'Ask · what your notes don’t cover' : 'Ask · general knowledge',
            model: o.model,
            temperature: Math.min(useAI.getState().temperature, 0.3),
            maxTokens: 400,
            priority: 'interactive',
            signal: ctrl.signal,
            messages: [
              { role: 'system', content: gapFillSystem(o.gaps, o.className) },
              { role: 'user', content: o.base ? `Question: ${o.question}\nMissing from the notes: ${o.gaps.join('; ')}` : o.question },
            ],
            onStatus: (st) => patchMsg(key, msgId, { phase: st ?? 'general' }),
            onToken: (t) => {
              buf += t;
              if (!raf)
                raf = requestAnimationFrame(() => {
                  raf = 0;
                  patchMsg(key, msgId, { shown: box(buf), phase: undefined });
                });
            },
          });
          if (raf) cancelAnimationFrame(raf);
          if (ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
          const text = (buf || res.text).replace(/\s*\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\](?!\()/g, '');
          // Never offered "continue": that picks up a notes answer (see lastRequests); this reply is short anyway, and Retry asks again.
          patchMsg(key, msgId, { shown: box(text), status: 'done', phase: undefined, truncated: undefined });
        } catch (e) {
          if (raf) cancelAnimationFrame(raf);
          const aborted = (e as Error).name === 'AbortError' || ctrl.signal.aborted;
          // The notes part (if any) stays; the general-knowledge part is simply missing.
          patchMsg(key, msgId, {
            shown: buf ? box(buf) : o.base,
            status: o.base ? 'done' : aborted ? 'stopped' : 'error',
            phase: undefined,
            error: o.base || aborted ? undefined : friendlyError(e),
          });
        } finally {
          if (controller === ctrl) {
            controller = null;
            if (get().streaming === key) set({ streaming: null });
          }
        }
      };

      /**
       * The notes don't cover the question (decided in code, before any notes
       * prompt is sent): say so, then — unless the student turned it off — answer
       * from general knowledge, clearly marked.
       */
      const notCovered = async (key: string, msgId: string, o: { question: string; className?: string; banner: Banner; nearest: SourceRef[]; model: string }) => {
        if (useAI.getState().outsideKnowledge === 'never') {
          patchMsg(key, msgId, { status: 'done', phase: undefined, ownOnly: true, coverage: 'none', banner: 'noneOff', nearest: o.nearest, content: '' });
          return;
        }
        patchMsg(key, msgId, { ownOnly: true, coverage: 'none', banner: o.banner, nearest: o.nearest, phase: undefined });
        await generalAnswer(key, msgId, { question: o.question, gaps: [o.question], className: o.className, model: o.model });
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

          // Follow-ups without new context stay on the problem being discussed. In homework, a typed
          // question after the caret moved to another problem is about that problem instead.
          const prevUser = [...(get().threads[key]?.messages ?? [])].reverse().find((m) => m.role === 'user' && m.anchor);
          const liveCaret = homework && !attachments.length && opts.focus === undefined ? caretContext(noteId) : undefined;
          const moved = !!liveCaret && !!prevUser?.focus && liveCaret !== prevUser.focus;
          const inherit = !attachments.length && !opts.anchor && !!prevUser && (opts.inherit || !moved);
          const anchor = opts.anchor ?? (inherit ? prevUser!.anchor : undefined) ?? currentBlockId(noteId);
          // In homework, the problem under the caret is what the student means by "this".
          // A follow-up keeps the earlier turn's problem: its saved focus, or the text the student pointed at
          // (e.g. a selection). Handwriting-only turns have no text, so nothing is guessed from the caret.
          const inheritedFocus = inherit ? (prevUser!.focus ?? prevUser!.attachments?.find((a) => a.kind === 'text')?.text) : undefined;
          const caret = homework && !attachments.length ? (opts.focus ?? (inherit ? inheritedFocus : liveCaret)) : undefined;
          // What the question was about, so follow-ups and Retry stay on it (a selection counts too).
          const turnFocus = caret || attachments.find((a) => a.kind === 'text')?.text;
          // `forced` is kept on the question too, so Retry searches the notes again rather than going back to the gate.
          const userMsg: ChatMsg = {
            id: uid('m'),
            role: 'user',
            content: question,
            label: opts.label,
            attachments,
            mode,
            anchor,
            focus: turnFocus,
            forced: opts.force,
            at: Date.now(),
          };
          const botMsg: ChatMsg = {
            id: uid('m'),
            role: 'assistant',
            content: '',
            status: 'streaming',
            mode,
            grounding: homework ? 'homework' : 'note',
            phase: 'reading',
            forced: opts.force,
            at: Date.now(),
          };
          push(key, userMsg, botMsg);
          if (!(await modelReady(key, botMsg.id))) return;
          const ai = useAI.getState();

          const ed = editors.get(noteId);
          const content = ed && !ed.isDestroyed ? ed.getJSON() : note?.content;
          const images = attachments.filter((a) => a.kind === 'image' && a.image).map((a) => a.image!);
          const vm = visionModel();
          const useImages = images.length > 0 && !!vm;
          const model = useImages ? vm! : ai.chatModel;
          const ctx = effectiveCtx(model);
          const focus = attachments.find((a) => a.kind === 'text')?.text ?? caret;
          const classPath = classOfNote(note, folderMeta);
          const className = classPath ? classInfo(classPath, folderMeta[classPath]).name : undefined;
          const title = note?.meta.title || 'Untitled';
          const transform = !homework && isTransformPrompt(question);
          // What the student wrote or pointed at: restating it needs no source, and its numbers may appear in answers.
          const studentText = [question, ...attachments.map((a) => a.text ?? ''), caret ?? ''].filter(Boolean).join('\n');

          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status !== 'error');
          const history = trimHistory(
            prior.slice(-8).map((m) => ({ role: m.role, content: m.role === 'user' ? withAttachmentText(m.content, m.attachments) : modelHistory(m) })),
            Math.floor(ctx * 0.15),
          );
          let userContent = withAttachmentText(question, attachments);
          if (caret) userContent = `The student is asking about this part of the homework:\n"""\n${caret}\n"""\n\n${userContent}`;
          if (images.length && !useImages)
            userContent +=
              '\n\n(The student attached a picture of their handwriting, but no image-capable model is configured, so you only have the transcript above, if any.)';
          const msgs = (system: string, user: string): ChatMessage[] => [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: user, images: useImages ? images : undefined },
          ];

          // Rewrite / translate: reword the student's own passage, then check what it added.
          if (transform) {
            patchMsg(key, botMsg.id, { grounding: 'transform', phase: undefined, question });
            const text = await stream(key, botMsg.id, msgs(transformSystemPrompt(), userContent), model, {
              label: `Rewrite · ${title}`,
              temperature: Math.min(ai.temperature, 0.2),
            });
            const passage = attachments.map((a) => a.text ?? '').join('\n');
            if (text !== null) patchMsg(key, botMsg.id, { added: transformCheck(passage, text) });
            return;
          }

          const stats = vaultStats().stats;
          let hits: Hit[];
          let system: string;
          let instructions: string;
          let gateHits: Hit[];
          let noLinked = false;
          let moreExcerpts = '';
          if (homework && note) {
            // Homework: the answer may only use the linked notes. Include every
            // linked passage when it fits, otherwise the most relevant ones.
            const linked = homeworkSources(note, notes);
            noLinked = !linked.length;
            // Answers pasted in earlier are not part of the assignment (and must not be graded as the student's work).
            const ownContent = withoutAssistant({ ...content, content: content?.content ?? [] });
            const hwText = fitToBudget(docToText(ownContent), Math.floor(ctx * 0.18), focus);
            hits = await homeworkExcerpts(linked, [question, focus ?? '', hwText.slice(0, 1600)].join('\n'), Math.floor(ctx * 0.42));
            system = homeworkSystemPrompt(title, hwText, formatExcerpts(hits), className);
            instructions = HOMEWORK_MODES[mode];
            gateHits = hits.length ? rankChunks(hits.map((h) => h.chunk), [question, focus ?? ''].join(' '), { k: 5 }) : [];
          } else {
            const ex = await noteExcerpts(note, content, [question, focus ?? ''].join(' '), anchor, classPath, ctx);
            hits = ex.hits;
            const picture = useImages ? hits.length + 1 : undefined;
            const pictureText = attachments
              .filter((a) => a.kind === 'text')
              .map((a) => a.text)
              .join('\n');
            if (picture) hits = [...hits, { chunk: pictureChunk(pictureText), score: 0, keyword: 0, semantic: null }];
            system = noteSystemPrompt(title, formatExcerpts(hits.slice(0, ex.own)), { own: ex.own, hasImage: useImages, visionAvailable: !!vm, className });
            // Everything that changes per question goes in the student's message, after the note.
            if (hits.length > ex.own)
              moreExcerpts = `MORE EXCERPTS (${className ? `other ${className} notes` : 'other notes'}${picture ? ', and the picture you attached' : ''}):\n${formatExcerpts(hits.slice(ex.own), ex.own + 1)}\n\nEND OF EXCERPTS`;
            instructions = MODE_INSTRUCTIONS[mode];
            gateHits = ex.gate;
          }
          const sources = toSources(hits, useImages);
          patchMsg(key, botMsg.id, { sources, phase: undefined, grounding: homework ? 'homework' : 'note' });

          // Coverage, decided in code before anything is generated. Questions about something the
          // student pointed at (a selection, handwriting, a math block, a mode like Check, the whole open note) are on-topic by definition.
          const pointed =
            attachments.length > 0 || mode !== 'custom' || Object.values(TEXT_ACTIONS).includes(question) || Object.values(NOTE_STARTERS).includes(question);
          const prevQuestion = prevUser?.content ?? [...prior].reverse().find((m) => m.role === 'user')?.content;
          const gate = opts.force || pointed ? null : assessCoverage(gateQuery([question, caret ?? ''].join(' '), prevQuestion), gateHits, stats, semanticCalib());
          // "Give an example": if the notes have none, no notes prompt is sent at all.
          const selection = attachments.map((a) => a.text ?? '').join('\n');
          if (!opts.force && question === TEXT_ACTIONS.example && !findExamples(selection, hits).length) {
            patchMsg(key, botMsg.id, { banner: 'noExample', coverage: 'none', ownOnly: true, phase: undefined });
            if (ai.outsideKnowledge === 'never') {
              patchMsg(key, botMsg.id, { status: 'done' });
              return;
            }
            const topic = selection.split(/\s+/).slice(0, 10).join(' ');
            await generalAnswer(key, botMsg.id, { question: `Give one short example of: ${topic}`, gaps: [`an example of: ${topic}`], className, model: ai.chatModel });
            return;
          }
          const none = noLinked || (gate?.level === 'none' && (!homework || gate.termCov < 0.1));
          if (none) {
            await notCovered(key, botMsg.id, {
              question,
              className,
              banner: noLinked ? 'noLinked' : 'none',
              nearest: noLinked ? [] : toSources(gate?.nearest ?? []),
              model: ai.chatModel,
            });
            return;
          }
          if (moreExcerpts) userContent = `${moreExcerpts}\n\n${userContent}`;
          if (instructions) userContent = `${instructions}\n\n${userContent}`;
          const missing = gate?.level === 'partial' && gate.missing.length ? `\n\nThese words from the question don't appear in the notes: ${gate.missing.join(', ')}.` : '';
          const hwContext = homework ? docToText(withoutAssistant({ ...content, content: content?.content ?? [] })) : '';
          await stream(key, botMsg.id, msgs(system, `${userContent}${missing}\n\n${RULE_REMINDER}`), model, {
            label: homework ? `Homework · ${title}` : `Ask · ${title}`,
            temperature: groundedTemp(ai.temperature),
            finish: {
              excerpts: hits.map((h, i) => [i + 1, { n: i + 1, text: h.chunk.text, title: h.chunk.title, section: h.chunk.section, visual: h.chunk.id === PICTURE_ID }]),
              context: [studentText, hwContext.slice(0, 4000)].filter(Boolean).join('\n'),
              mode: homework || mode === 'tutor' || mode === 'check' || mode === 'solve' ? 'compute' : 'explain',
              question,
              className,
              gate: gate?.level,
            },
          });
        },

        async askLibrary({ prompt, scope, scopeLabel, tool, force }) {
          const key = LIBRARY_KEY;
          const question = tool ? STUDY_TOOLS[tool].label : prompt.trim();
          // A study tool's topic (what was typed when its chip was picked) stays with the request, for its name and Retry.
          const focus = tool && prompt.trim() ? prompt.trim() : undefined;
          const userMsg: ChatMsg = { id: uid('m'), role: 'user', content: question, tool, focus, scope, scopeLabel, forced: force, at: Date.now() };
          const botMsg: ChatMsg = {
            id: uid('m'),
            role: 'assistant',
            content: '',
            status: 'streaming',
            tool,
            phase: 'reading',
            grounding: 'library',
            scopeLabel,
            forced: force,
            at: Date.now(),
          };
          push(key, userMsg, botMsg);
          if (!(await modelReady(key, botMsg.id))) return;
          const ai = useAI.getState();
          let hits: Hit[] = [];
          try {
            // Study tools without a topic cover the whole scope; otherwise retrieve.
            hits = tool && !prompt.trim() ? sampleLibrary(scope, 12) : await searchLibrary(prompt, scope, tool ? 10 : 7);
          } catch (e) {
            console.warn('retrieval failed', e);
          }
          const model = ai.chatModel;
          const ctx = effectiveCtx(model);
          hits = fitHits(hits, Math.floor(ctx * 0.6));
          patchMsg(key, botMsg.id, { sources: toSources(hits), phase: undefined });

          // Does anything in the notes answer this? Decided before the model is asked.
          let gateLevel: CoverageLevel | undefined;
          if (!tool && !force) {
            const prevQ = [...(get().threads[key]?.messages ?? [])].reverse().find((m) => m.role === 'user' && m.id !== userMsg.id && !m.tool)?.content;
            const gate = assessCoverage(gateQuery(prompt, prevQ), hits, vaultStats().stats, semanticCalib());
            gateLevel = gate.level;
            if (gate.level === 'none' || !hits.length) {
              await notCovered(key, botMsg.id, { question: prompt, banner: 'none', nearest: toSources(gate.nearest), model });
              return;
            }
          }
          if (tool && !hits.some((h) => h.chunk.text.length > 60)) {
            patchMsg(key, botMsg.id, {
              status: 'done',
              content: 'There isn’t enough in these notes to make this yet — write a little more, then try again.',
            });
            return;
          }

          const system = librarySystemPrompt(formatExcerpts(hits), scopeLabel);
          const prior = (get().threads[key]?.messages ?? []).filter((m) => m.id !== userMsg.id && m.id !== botMsg.id && m.status === 'done' && !m.tool);
          const history = trimHistory(
            prior.slice(-6).map((m) => ({ role: m.role, content: m.role === 'user' ? m.content : modelHistory(m) })),
            Math.floor(ctx * 0.12),
          );
          const userContent = tool ? `${STUDY_TOOLS[tool].prompt}${prompt ? `\nFocus: ${prompt}` : ''}` : `${prompt}\n\n${RULE_REMINDER}`;
          const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }];
          const json = tool === 'flashcards' || tool === 'quiz';
          const excerpts: [number, ExcerptRef][] = hits.map((h, i) => [i + 1, { n: i + 1, text: h.chunk.text, title: h.chunk.title, section: h.chunk.section }]);
          const text = await stream(key, botMsg.id, messages, model, {
            label: tool ? `${STUDY_TOOLS[tool].label}${scopeLabel ? ` · ${scopeLabel}` : ''}` : `Ask your notes${scopeLabel ? ` · ${scopeLabel}` : ''}`,
            json,
            temperature: json ? 0.2 : groundedTemp(ai.temperature),
            // Prose study tools are checked like answers; cards and quizzes item by item below.
            finish: json ? undefined : { excerpts, context: prompt, mode: 'explain', question: prompt || question, gate: gateLevel },
            // Cards and questions are shown only once each has been checked against the notes.
            holdDone: json,
          });
          if (text !== null && tool && json) {
            await repairStudyJSON(key, botMsg.id, tool, text, messages, model);
            const m = get().threads[key]?.messages.find((x) => x.id === botMsg.id);
            const parsed = m && parseStudyJSON(tool, m.content);
            if (parsed) {
              const { idf, inVault } = vaultStats();
              const v = verifyStudy(parsed, { excerpts: new Map(excerpts), context: '', mode: 'explain', idf, inVault });
              patchMsg(key, botMsg.id, { content: v.json, dropped: v.dropped || undefined });
            }
            const now = get().threads[key]?.messages.find((x) => x.id === botMsg.id);
            if (now?.status === 'streaming') patchMsg(key, botMsg.id, { status: 'done', phase: undefined });
          }
        },

        forceNotes(key) {
          const t = get().threads[key];
          const lastUser = t && [...t.messages].reverse().find((m) => m.role === 'user');
          if (!t || !lastUser) return;
          set({ threads: { ...get().threads, [key]: { ...t, messages: t.messages.slice(0, t.messages.indexOf(lastUser)) } } });
          if (key === LIBRARY_KEY)
            void get().askLibrary({ prompt: lastUser.content, scope: lastUser.scope ?? { kind: 'all' }, scopeLabel: lastUser.scopeLabel, force: true });
          else
            void get().ask(key, {
              prompt: lastUser.content,
              label: lastUser.label,
              mode: lastUser.mode,
              attachments: lastUser.attachments,
              anchor: lastUser.anchor,
              focus: lastUser.focus ?? '',
              inherit: true,
              force: true,
            });
        },

        async continueReply(key, msgId) {
          const req = lastRequests.get(msgId);
          const msg = get().threads[key]?.messages.find((m) => m.id === msgId);
          if (!req || !msg) return;
          patchMsg(key, msgId, { status: 'streaming', truncated: false });
          // Join on the exact text the model produced (untrimmed), so a cut mid-word or after a newline
          // continues seamlessly; the model sees the same text as its own previous turn.
          const base = req.raw || msg.content;
          // The check runs again on the whole joined reply (the general-knowledge part is re-asked if still needed).
          patchMsg(key, msgId, { shown: undefined, check: undefined, gaps: undefined });
          await stream(key, msgId, [...req.messages, { role: 'assistant', content: base }, { role: 'user', content: CONTINUE_PROMPT }], req.model, {
            ...req.opts,
            label: `${req.opts.label} (continued)`,
            prefix: base,
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
              prompt: lastUser.tool ? (lastUser.focus ?? '') : lastUser.content,
              scope: lastUser.scope ?? { kind: 'all' },
              scopeLabel: lastUser.scopeLabel,
              tool: lastUser.tool,
              force: lastUser.forced,
            });
          else
            void get().ask(key, {
              prompt: lastUser.content,
              label: lastUser.label,
              mode: lastUser.mode,
              attachments: lastUser.attachments,
              anchor: lastUser.anchor,
              // '' (not undefined) when the turn had no focus: Retry must not pick up wherever the caret is now.
              focus: lastUser.focus ?? '',
              inherit: true,
              force: lastUser.forced,
            });
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

function toSources(hits: Hit[], _withPicture = false): SourceRef[] {
  return hits.map((h, i) => ({
    n: i + 1,
    noteId: h.chunk.noteId,
    title: h.chunk.title,
    section: h.chunk.section,
    folder: h.chunk.folder,
    blockId: h.chunk.blockIds[0] ?? null,
    text: h.chunk.text,
    ...(h.chunk.id === PICTURE_ID ? { visual: true } : {}),
  }));
}

/** What the model sees of its earlier replies: checked text only, no boxes, no old [n]. */
function modelHistory(m: ChatMsg): string {
  if (m.role !== 'assistant') return m.content;
  if (m.ownOnly) return '(That answer was general knowledge, not from the notes.)';
  return historyForModel(shownOf(m)) || '(no answer)';
}

const PICTURE_ID = '__picture';

/** The attached picture of the student's work, as an excerpt (what Nib read of it, if anything). */
function pictureChunk(transcript: string): Chunk {
  return {
    id: PICTURE_ID,
    noteId: '',
    title: 'The picture of your work you attached',
    folder: '',
    section: '',
    text: transcript.trim() || '(see the attached picture)',
    blockIds: [],
    hash: PICTURE_ID,
  };
}

/**
 * Excerpts for a question about the open note: the whole note in order when
 * it fits, otherwise the passage being asked about plus the best matches;
 * then up to three related passages from the same class. Also returns the
 * passages ranked for the coverage check.
 */
async function noteExcerpts(
  note: NoteDoc | undefined,
  content: NoteDoc['content'] | undefined,
  query: string,
  anchor: string | undefined,
  classPath: string | null,
  ctx: number,
): Promise<{ hits: Hit[]; own: number; gate: Hit[] }> {
  if (!note) return { hits: [], own: 0, gate: [] };
  // A note the AI wrote (saved flashcards) is not the student's notes: it is never evidence.
  const chunks = note.meta.generated ? [] : chunkNote({ ...note, content: content ?? note.content }).filter((c) => c.text.trim() && !/^\[[^\]]*\]$/.test(c.text.trim()));
  const budget = Math.floor(ctx * 0.45);
  const cost = (c: Chunk) => estimateTokens(c.text) + 24;
  let own = chunks;
  if (chunks.reduce((a, c) => a + cost(c), 0) > budget || chunks.length > 30) {
    const pick = new Set<Chunk>();
    let used = 0;
    const at = anchor ? chunks.find((c) => c.blockIds.includes(anchor)) : undefined;
    if (at) {
      pick.add(at);
      used += cost(at);
    }
    for (const h of rankChunks(chunks, query, { k: chunks.length })) {
      if (pick.has(h.chunk) || used + cost(h.chunk) > budget) continue;
      pick.add(h.chunk);
      used += cost(h.chunk);
    }
    own = chunks.filter((c) => pick.has(c));
  }
  let related: Chunk[] = [];
  if (classPath) {
    try {
      const found = await searchLibrary(query, { kind: 'folder', path: classPath }, 6);
      let used = 0;
      for (const h of found) {
        if (h.chunk.noteId === note.meta.id || h.keyword <= 0 || related.length >= 3) continue;
        if (used + cost(h.chunk) > ctx * 0.15) break;
        related.push(h.chunk);
        used += cost(h.chunk);
      }
    } catch {
      related = [];
    }
  }
  const all = [...own, ...related];
  const toHit = (chunk: Chunk): Hit => ({ chunk, score: 0, keyword: 0, semantic: null });
  return { hits: all.map(toHit), own: own.length, gate: all.length ? rankChunks(all, query, { k: 5 }) : [] };
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
  // Inside an answer pasted from the assistant: that's not the homework, so there is no problem to point at.
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'callout' && (n.attrs.variant === 'ai' || n.attrs.variant === 'outside')) return undefined;
  }
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
  return parts.length ? `THE STUDENT'S WORK (you may refer to it; it is not a source of facts):\n${parts.join('\n\n')}\n\n${question}` : question;
}

export function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/model .* not found|not found, try pulling/i.test(msg)) return `${msg}. Pull it with Ollama or pick another model in Settings → Local AI.`;
  if (/does not support (images|vision)|image input/i.test(msg))
    return 'This model can’t read images. Choose a vision model (e.g. qwen2.5vl, gemma3, llama3.2-vision) in Settings → Local AI.';
  if (/ECONNREFUSED|Failed to fetch|fetch failed|NetworkError|HTTP 0/i.test(msg))
    return 'Couldn’t reach your local model server. Is Ollama / LM Studio running?';
  if (/context|too long|num_ctx/i.test(msg)) return `${msg} — try a shorter question or raise the context size in Settings → Local AI.`;
  // The status and the server's own words, never its raw reply ('{"error":…}').
  const code = (e as { status?: number })?.status ?? 0;
  const status = /HTTP (5\d\d)/.exec(msg)?.[1] ?? (code >= 500 && code < 600 ? String(code) : undefined);
  if (status) {
    const why = serverReason(msg);
    return `The model server had a problem (HTTP ${status}${why ? `: ${why}` : ''}). It was retried automatically; try again in a moment.`;
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
