import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  ArrowUp,
  BookOpenCheck,
  Compass,
  FileText,
  GraduationCap,
  Lightbulb,
  ListChecks,
  ListOrdered,
  Plus,
  Quote,
  SearchCheck,
  Square,
  SquarePen,
  Target,
  X,
} from 'lucide-react';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';
import { findBlock } from '../../editor/ink/ops';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAI } from '../../state/ai';
import { useAssistant, type ChatMsg } from '../../state/assistant';
import { MessageView, shownMarkdown } from './Message';
import { SourcesList, useCitePreview } from './Citations';
import { ComposerStatus, useAvailability } from './ComposerStatus';
import { homeworkSources } from '../../lib/homework';
import { linkNotes, reviewNote } from '../../lib/commands';
import { isReviewable } from '../../lib/review/tree';
import { editors } from '../../editor/registry';
import { markdownToEditorHTML } from '../../lib/ai/markdown';
import { NOTE_STARTERS } from '../../lib/ai/prompts';
import type { NoteDoc } from '../../lib/vault/types';
import { cx, plural } from '../../lib/util';
import { displayTitle } from '../../lib/displayTitle';
import { MOD } from '../../lib/platform';
import { toast } from '../common/toast';

type Starter = { icon: React.ReactNode; label: string; prompt?: string; mode?: 'explain' | 'tutor' | 'check' | 'solve'; review?: boolean };

const EXPLAIN: Starter = { icon: <Lightbulb size={16} />, label: 'Explain the key ideas on this page', prompt: NOTE_STARTERS.explain };
const QUIZ: Starter = { icon: <ListChecks size={16} />, label: 'Quiz me on this note', prompt: NOTE_STARTERS.quiz };
const EXAM: Starter = { icon: <BookOpenCheck size={16} />, label: 'What should I review before the exam?', prompt: NOTE_STARTERS.exam };
const BULLETS: Starter = { icon: <Quote size={16} />, label: 'Summarise in 5 bullets', prompt: NOTE_STARTERS.bullets };
const REVIEW: Starter = { icon: <Target size={16} />, label: 'Review this note', review: true };

const TUTOR_FOLLOWUPS = ['Give me another hint', 'Check my work so far', 'Show just the next step', 'Solve it fully'];

/** Homework quick actions — each one answers strictly from the linked notes. */
const HOMEWORK_STARTERS: Starter[] = [
  {
    icon: <Compass size={16} />,
    label: 'How do I approach this?',
    mode: 'explain',
    prompt: 'How should I approach this problem, using the method from my notes?',
  },
  { icon: <Lightbulb size={16} />, label: 'Give me a hint', mode: 'tutor', prompt: 'Give me a hint for the next step, based on my notes.' },
  { icon: <SearchCheck size={16} />, label: 'Check my work', mode: 'check', prompt: 'Check my work against the method in my notes.' },
  { icon: <ListOrdered size={16} />, label: 'Solve it the way my notes do', mode: 'solve', prompt: 'Solve this step by step exactly the way my notes do.' },
];

/** Nothing typed, drawn or pasted yet: there's nothing to ask about. */
function isBlank(note: NoteDoc): boolean {
  const empty = (b: JSONContent): boolean => b.type === 'paragraph' && !(b.content?.length ?? 0) && !(Array.isArray(b.attrs?.ink) && b.attrs.ink.length > 0);
  return (note.content.content ?? []).every(empty);
}

/** Inserts a reply into the note as an "assistant" callout, right after the block it was about. */
export function insertReply(noteId: string, md: string, anchor?: string, maxCite?: number) {
  const editor = editors.get(noteId);
  if (!editor) return;
  const div = document.createElement('div');
  div.innerHTML = markdownToEditorHTML(md, { stripCitations: true, maxCite });
  const frag = PMDOMParser.fromSchema(editor.schema).parse(div);
  const nodes: import('@tiptap/pm/model').Node[] = [];
  frag.forEach((n) => nodes.push(n));
  if (!nodes.length) return;
  const callout = editor.schema.nodes.callout.create({ variant: 'ai' }, nodes);
  const doc = editor.state.doc;
  let at: number | null = null;
  if (anchor) {
    const found = findBlock(doc, anchor);
    if (found) at = found.pos + found.node.nodeSize;
  }
  if (at === null) {
    const sel = editor.state.selection;
    at = sel instanceof NodeSelection ? sel.to : sel.$from.depth > 0 ? sel.$from.after(1) : doc.content.size;
  }
  const pos = Math.min(at, doc.content.size);
  // Leave an ordinary line after the answer, so the student's own writing doesn't end up inside it.
  const next = doc.resolve(pos).nodeAfter;
  const tail = next && next.type.name === 'paragraph' && next.content.size === 0 ? [] : [editor.schema.nodes.paragraph.create()];
  const tr = editor.state.tr.insert(pos, [callout, ...tail]);
  editor.view.dispatch(tr.scrollIntoView());
  toast.success('Added to your note', 'Undo with ⌘Z');
}

function anchorFor(messages: ChatMsg[], bot: ChatMsg): string | undefined {
  const i = messages.indexOf(bot);
  for (let j = i - 1; j >= 0; j--) if (messages[j].role === 'user') return messages[j].anchor;
  return undefined;
}

/** A picked or pasted picture, as the PNG the vision model gets (long side at most 1600px). */
async function imageAttachment(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The Assistant, Claude's side panel beside the note: a header with New conversation and Close, a
 * short greeting with starters, the conversation, and a composer with attachments, Tutor and Send.
 * A Select box released on the page while it's open arrives as an attached picture (see the editor).
 */
export function AssistantPanel() {
  const view = useUI((s) => s.view);
  const noteId = view.kind === 'note' ? view.id : null;
  const note = useVault((s) => (noteId ? s.notes[noteId] : null));
  const outsideKnowledge = useAI((s) => s.outsideKnowledge);
  const availability = useAvailability();
  const key = noteId ?? '__none__';
  const thread = useAssistant((s) => s.threads[key]);
  const draft = useAssistant((s) => s.drafts[key]) ?? { attachments: [], text: '', mode: 'chat' as const };
  const streaming = useAssistant((s) => s.streaming === key);
  const focusTick = useAssistant((s) => s.focusTick);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const allNotes = useVault((s) => s.notes);
  const isHomework = !!note?.meta.homework;
  const linked = note && isHomework ? homeworkSources(note, allNotes) : [];
  // The panel is at the window's right edge: the passage opens to the left, over the note.
  const cite = useCitePreview({ placement: 'left' });

  const messages: ChatMsg[] = thread?.messages ?? [];

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick, noteId]);

  // Follows the reply as it streams unless the student scrolled up; a new question (from here or the page) always shows,
  // and the list stays at the bottom while the composer grows under it.
  const seen = useRef(messages.length);
  useLayoutEffect(() => {
    if (messages.length > seen.current) stick.current = true;
    seen.current = messages.length;
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [draft.text]);

  // Starter prompts from elsewhere (slash menu "Summarize note", etc.).
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      useUI.getState().setAssistant(true);
      if (!noteId) return;
      if (d.prompt && d.send) void useAssistant.getState().ask(noteId, { prompt: d.prompt });
      else if (d.prompt) useAssistant.getState().setDraft(noteId, { text: d.prompt });
      inputRef.current?.focus();
    };
    window.addEventListener('nib:assistant', on);
    return () => window.removeEventListener('nib:assistant', on);
  }, [noteId]);

  const answerable = availability !== 'offline' && availability !== 'nomodel';
  const hasInput = !!draft.text.trim() || draft.attachments.length > 0;
  const send = (prompt?: string) => {
    if (!noteId || !answerable) return;
    const text = (prompt ?? draft.text).trim();
    if (!text && !draft.attachments.length) return;
    stick.current = true;
    void useAssistant.getState().ask(noteId, { prompt: text || undefined, mode: draft.mode === 'tutor' ? 'tutor' : undefined });
  };
  const start = (s: Starter) => {
    if (!note) return;
    if (s.review) return reviewNote(note.meta.id);
    if (!answerable) return;
    stick.current = true;
    if (s.mode) void useAssistant.getState().ask(note.meta.id, { prompt: s.prompt, mode: s.mode });
    else send(s.prompt);
  };
  const addImages = async (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const image = await imageAttachment(f);
      if (image) useAssistant.getState().attach(key, { kind: 'image', label: f.name && f.name !== 'image.png' ? f.name : 'Pasted image', image });
    }
    inputRef.current?.focus();
  };

  const lastBot = [...messages].reverse().find((m) => m.role === 'assistant');
  const tutorOn = draft.mode === 'tutor';
  // Follow-ups answer a hint or a check, not the Tutor chip being switched on.
  const tutorActive = lastBot?.mode === 'tutor' || lastBot?.mode === 'check';
  const blank = !!note && !isHomework && isBlank(note);
  const starters = isHomework ? HOMEWORK_STARTERS : note && isReviewable(note) ? [EXPLAIN, EXAM, REVIEW] : [EXPLAIN, QUIZ, BULLETS];

  return (
    <aside className="assistant" aria-label={isHomework ? 'Homework helper' : 'Assistant'}>
      <div className="assistant-head drag">
        <div className="assistant-title no-drag">
          <div className="assistant-name">{isHomework ? 'Homework helper' : 'Assistant'}</div>
          <div className="assistant-sub">
            {!note ? (
              'Open a note to ask about it'
            ) : isHomework ? (
              linked.length ? (
                <>
                  Answers only from <b>{plural(linked.length, 'linked note')}</b>
                </>
              ) : (
                'No notes linked yet'
              )
            ) : (
              <>
                Reading <b>{displayTitle(note)}</b>
              </>
            )}
          </div>
        </div>
        <div className="no-drag assistant-head-actions">
          {messages.length > 0 && (
            <button
              className="icon-btn is-tiny"
              onClick={() => noteId && useAssistant.getState().clear(noteId)}
              title="New conversation"
              aria-label="New conversation"
            >
              <SquarePen size={16} />
            </button>
          )}
          <button className="icon-btn is-tiny" onClick={() => useUI.getState().setAssistant(false)} title={`Close  ${MOD}J`} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      <div
        className={cx('assistant-list', !messages.length && 'is-empty')}
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        // An attached picture that finishes loading makes the list taller after it was scrolled.
        onLoadCapture={(e) => stick.current && (e.currentTarget.scrollTop = e.currentTarget.scrollHeight)}
      >
        {!messages.length && note && (
          <div className={cx('assistant-empty', isHomework && 'is-homework')}>
            <div className="assistant-empty-title">{isHomework ? 'Get help with this homework' : 'Ask about this note'}</div>
            <div className="assistant-empty-sub">
              {blank
                ? 'Write or draw something, then ask about it.'
                : isHomework
                  ? 'Click into a problem or select it on the page, then pick one.'
                  : outsideKnowledge === 'never'
                    ? 'Answers come only from your notes.'
                    : 'Answers come from your notes. Anything else is marked.'}
            </div>
            {!blank && (
              <div className="starters">
                {starters.map((s) => (
                  <button
                    key={s.label}
                    className="starter"
                    onClick={() => start(s)}
                    disabled={!s.review && !answerable}
                    title={s.review ? 'Practise this note with questions from it' : undefined}
                  >
                    {s.icon}
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="assistant-turn" {...cite.hover(m.sources)}>
            <MessageView
              msg={m}
              iconActions
              citations={!!m.grounding && m.grounding !== 'transform'}
              onCite={(n, el) => cite.show(n, el, m.sources)}
              onInsert={m.role === 'assistant' && noteId ? () => insertReply(noteId, shownMarkdown(m), anchorFor(messages, m), m.sources?.length) : undefined}
              onRegenerate={m.role === 'assistant' && m === lastBot && noteId ? () => useAssistant.getState().regenerate(noteId) : undefined}
              onContinue={noteId ? () => useAssistant.getState().continueReply(noteId, m.id) : undefined}
              onForce={m === lastBot && noteId ? () => useAssistant.getState().forceNotes(noteId) : undefined}
              onLink={m === lastBot && isHomework && noteId ? () => linkNotes(noteId) : undefined}
            >
              {(m.grounding === 'homework' || m.grounding === 'note') && m.status !== 'streaming' && !m.ownOnly && m.sources && m.sources.length > 0 && (
                <SourcesList content={shownMarkdown(m)} sources={m.sources.filter((x) => !x.visual)} label="From your notes" />
              )}
            </MessageView>
          </div>
        ))}
        {tutorActive && !streaming && lastBot && lastBot.status === 'done' && (
          <div className="followups">
            {TUTOR_FOLLOWUPS.map((f) => (
              <button
                key={f}
                className="followup"
                disabled={!answerable}
                onClick={() =>
                  noteId &&
                  void useAssistant.getState().ask(noteId, {
                    prompt: f,
                    mode: f.startsWith('Check') ? 'check' : f.startsWith('Solve') ? 'solve' : 'tutor',
                    attachments: [],
                    inherit: true,
                  })
                }
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="composer" onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}>
        <ComposerStatus availability={availability} />
        {draft.attachments.length > 0 && (
          <div className="composer-atts">
            {draft.attachments.map((a) => (
              <span key={a.id} className={cx('att', a.image ? 'is-image' : 'is-text')} title={a.text ? `${a.label}: ${a.text.slice(0, 200)}` : a.label}>
                <span className="att-thumb">{a.image ? <img src={`data:image/png;base64,${a.image}`} alt="" /> : <FileText size={16} />}</span>
                <span className="att-label">{a.label}</span>
                <button className="att-x" onClick={() => useAssistant.getState().detach(key, a.id)} aria-label={`Remove ${a.label}`} title="Remove">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={draft.text}
          disabled={!noteId}
          placeholder={!noteId ? 'Open a note to start' : tutorOn ? 'Tell me where you’re stuck' : isHomework ? 'Ask about a problem' : 'Ask about this note'}
          onChange={(e) => useAssistant.getState().setDraft(key, { text: e.target.value })}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return;
            e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!streaming) send();
            }
          }}
        />
        <div className="composer-row">
          <button className="icon-btn is-tiny" onClick={() => fileRef.current?.click()} disabled={!noteId} title="Add a picture" aria-label="Add a picture">
            <Plus size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void addImages(files);
            }}
          />
          <button
            className={cx('tutor-chip', tutorOn && 'is-on')}
            aria-pressed={tutorOn}
            disabled={!noteId}
            onClick={() => useAssistant.getState().setDraft(key, { mode: tutorOn ? 'chat' : 'tutor' })}
            title="Guides you step by step instead of giving the answer"
          >
            <GraduationCap size={14} /> Tutor
          </button>
          <span className="grow" />
          {streaming ? (
            <button className="send-btn is-stop" onClick={() => useAssistant.getState().stop()} aria-label="Stop" title="Stop">
              <Square size={10} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => send()}
              disabled={!noteId || !hasInput || !answerable}
              aria-label="Send"
              title={answerable ? 'Send' : 'Local AI isn’t running'}
            >
              <ArrowUp size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      {cite.popover}
    </aside>
  );
}
