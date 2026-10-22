import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  ArrowUp,
  BookOpenCheck,
  GraduationCap,
  Lightbulb,
  ListChecks,
  MessageSquarePlus,
  ScanSearch,
  Sparkles,
  Square,
  X,
  ImageIcon,
  FileText,
  Quote,
  Target,
} from 'lucide-react';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { findBlock } from '../../editor/ink/ops';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { useAI, visionModel } from '../../state/ai';
import { useAssistant, type ChatMsg } from '../../state/assistant';
import { useTools } from '../../state/tools';
import { MessageView, shownMarkdown } from './Message';
import { SourcesList, useCitePreview } from './Citations';
import { homeworkSources } from '../../lib/homework';
import { linkNotes, reviewNote } from '../../lib/commands';
import { isReviewable } from '../../lib/review/tree';
import { ClipboardList, Compass, Link2, SearchCheck, Wand2 } from 'lucide-react';
import { editors } from '../../editor/registry';
import { markdownToEditorHTML } from '../../lib/ai/markdown';
import { NOTE_STARTERS } from '../../lib/ai/prompts';
import { cx } from '../../lib/util';
import { MOD } from '../../lib/platform';
import { toast } from '../common/toast';

const STARTERS = [
  { icon: <Lightbulb size={14} />, label: 'Explain the key ideas on this page', prompt: NOTE_STARTERS.explain },
  { icon: <ListChecks size={14} />, label: 'Quiz me on this note', prompt: NOTE_STARTERS.quiz },
  { icon: <BookOpenCheck size={14} />, label: 'What should I review before the exam?', prompt: NOTE_STARTERS.exam },
  { icon: <Quote size={14} />, label: 'Summarise in 5 bullets', prompt: NOTE_STARTERS.bullets },
];

const TUTOR_FOLLOWUPS = ['Give me another hint', 'Check my work so far', 'Show just the next step', 'Solve it fully'];

/** Homework quick actions — each one answers strictly from the linked notes. */
const HOMEWORK_STARTERS: { icon: React.ReactNode; label: string; mode: 'explain' | 'tutor' | 'check' | 'solve'; prompt: string }[] = [
  {
    icon: <Compass size={14} />,
    label: 'How do I approach this?',
    mode: 'explain',
    prompt: 'How should I approach this problem, using the method from my notes?',
  },
  { icon: <Lightbulb size={14} />, label: 'Give me a hint', mode: 'tutor', prompt: 'Give me a hint for the next step, based on my notes.' },
  { icon: <SearchCheck size={14} />, label: 'Check my work', mode: 'check', prompt: 'Check my work against the method in my notes.' },
  { icon: <Wand2 size={14} />, label: 'Solve it the way my notes do', mode: 'solve', prompt: 'Solve this step by step exactly the way my notes do.' },
];

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

export function AssistantPanel() {
  const view = useUI((s) => s.view);
  const noteId = view.kind === 'note' ? view.id : null;
  const note = useVault((s) => (noteId ? s.notes[noteId] : null));
  const ai = useAI();
  const vision = visionModel(ai);
  const key = noteId ?? '__none__';
  const thread = useAssistant((s) => s.threads[key]);
  const draft = useAssistant((s) => s.drafts[key]) ?? { attachments: [], text: '', mode: 'chat' as const };
  const streaming = useAssistant((s) => s.streaming === key);
  const focusTick = useAssistant((s) => s.focusTick);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const allNotes = useVault((s) => s.notes);
  const isHomework = !!note?.meta.homework;
  const linked = note && isHomework ? homeworkSources(note, allNotes) : [];
  const cite = useCitePreview();

  const messages: ChatMsg[] = thread?.messages ?? [];

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick, noteId]);

  // Auto-scroll while streaming unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  const send = (prompt?: string) => {
    if (!noteId) return;
    const text = (prompt ?? draft.text).trim();
    if (!text && !draft.attachments.length) return;
    stick.current = true;
    void useAssistant.getState().ask(noteId, { prompt: text || undefined, mode: draft.mode === 'tutor' ? 'tutor' : undefined });
  };

  const lastBot = [...messages].reverse().find((m) => m.role === 'assistant');
  const tutorActive = draft.mode === 'tutor' || lastBot?.mode === 'tutor' || lastBot?.mode === 'check';

  return (
    <aside className="assistant">
      <div className="assistant-head drag">
        <div className="assistant-title no-drag">
          <span className="assistant-spark">
            <Sparkles size={15} />
          </span>
          <div>
            <div className="assistant-name">{isHomework ? 'Homework helper' : 'Assistant'}</div>
            <div className="assistant-sub">
              {note ? (
                isHomework ? (
                  <>
                    Answers only from <b>{linked.length === 1 ? '1 linked note' : `${linked.length} linked notes`}</b>
                  </>
                ) : (
                  <>
                    Reading <b>{note.meta.title || 'Untitled'}</b>
                  </>
                )
              ) : (
                'Open a note to ask about it'
              )}
            </div>
          </div>
        </div>
        <div className="no-drag assistant-head-actions">
          {messages.length > 0 && (
            <button className="icon-btn" onClick={() => noteId && useAssistant.getState().clear(noteId)} title="New conversation">
              <MessageSquarePlus size={16} />
            </button>
          )}
          <button className="icon-btn" onClick={() => useUI.getState().setAssistant(false)} title={`Close  ${MOD}J`}>
            <X size={16} />
          </button>
        </div>
      </div>

      <button className={cx('model-chip', `is-${ai.status}`)} onClick={() => useUI.getState().openSettings('ai')}>
        <span className="ai-dot" />
        {ai.status === 'online' ? (
          <>
            <span className="model-name">{ai.chatModel}</span>
            {vision && <span className="model-tag">sees images</span>}
            <span className="model-local">on-device</span>
          </>
        ) : ai.status === 'checking' ? (
          'Connecting to your local model…'
        ) : (
          'No local model connected — set up'
        )}
      </button>

      <div
        className="assistant-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!messages.length && isHomework && note && (
          <div className="assistant-empty is-homework">
            <div className="hw-helper-card">
              <div className="hw-helper-head">
                <ClipboardList size={15} /> Strictly from your notes
              </div>
              <div className="hw-helper-text">
                Answers follow your linked notes exactly — same method, same steps, every claim cited. If your notes don’t cover something, it’s put in a box
                marked <b>Not from your notes</b>.
              </div>
              <div className="hw-helper-sources">
                {linked.slice(0, 4).map((n) => (
                  <button key={n.meta.id} className="hw-helper-source" onClick={() => useUI.getState().openNote(n.meta.id, { newTab: true })}>
                    <FileText size={12} /> {n.meta.title || 'Untitled'}
                  </button>
                ))}
                {linked.length > 4 && <span className="hw-helper-more">+{linked.length - 4} more</span>}
                <button className="hw-helper-link" onClick={() => linkNotes(note.meta.id)}>
                  <Link2 size={12} /> {linked.length ? 'Change' : 'Link notes'}
                </button>
              </div>
            </div>
            <div className="assistant-empty-sub">Select a problem (or lasso your handwriting) first to point at it, then pick:</div>
            <div className="starters">
              {HOMEWORK_STARTERS.map((s) => (
                <button
                  key={s.label}
                  className="starter"
                  onClick={() => {
                    stick.current = true;
                    void useAssistant.getState().ask(note.meta.id, { prompt: s.prompt, mode: s.mode });
                  }}
                >
                  {s.icon}
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {!messages.length && !isHomework && (
          <div className="assistant-empty">
            <div className="assistant-empty-title">Ask anything about this page</div>
            <div className="assistant-empty-sub">
              Your model sees the whole note — typed text, math, and handwriting. Select text, lasso ink, or use <b>✦ Ask</b> in the toolbar to point at
              something specific.
            </div>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="starter" onClick={() => send(s.prompt)} disabled={!noteId}>
                  {s.icon}
                  {s.label}
                </button>
              ))}
              {note && isReviewable(note) && (
                <button className="starter" onClick={() => reviewNote(note.meta.id)} title="Practise this note until you know it — questions and answers come only from it">
                  <Target size={14} />
                  Review this note
                </button>
              )}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            msg={m}
            citations={!!m.grounding && m.grounding !== 'transform'}
            onCite={(n, el) => cite.show(n, el, m.sources)}
            onInsert={m.role === 'assistant' && noteId ? () => insertReply(noteId, shownMarkdown(m), anchorFor(messages, m), m.sources?.length) : undefined}
            onRegenerate={m.role === 'assistant' && m === lastBot && noteId ? () => useAssistant.getState().regenerate(noteId) : undefined}
            onContinue={noteId ? () => useAssistant.getState().continueReply(noteId, m.id) : undefined}
            onForce={m === lastBot && noteId ? () => useAssistant.getState().forceNotes(noteId) : undefined}
          >
            {(m.grounding === 'homework' || m.grounding === 'note') && m.status !== 'streaming' && !m.ownOnly && m.sources && m.sources.length > 0 && (
              <SourcesList content={shownMarkdown(m)} sources={m.sources.filter((x) => !x.visual)} label="From your notes" />
            )}
          </MessageView>
        ))}
        {tutorActive && !streaming && lastBot && lastBot.status === 'done' && (
          <div className="followups">
            {TUTOR_FOLLOWUPS.map((f) => (
              <button
                key={f}
                className="followup"
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

      <div className="composer">
        {draft.attachments.length > 0 && (
          <div className="composer-atts">
            {draft.attachments.map((a) => (
              <span key={a.id} className="att">
                {a.kind === 'image' && a.image ? (
                  <img src={`data:image/png;base64,${a.image}`} alt="" />
                ) : a.kind === 'image' ? (
                  <ImageIcon size={13} />
                ) : (
                  <FileText size={13} />
                )}
                <span className="att-label">{a.label}</span>
                <button onClick={() => useAssistant.getState().detach(key, a.id)} aria-label="Remove">
                  <X size={11} />
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
          placeholder={
            !noteId
              ? 'Open a note to start'
              : draft.mode === 'tutor'
                ? 'Describe where you’re stuck…'
                : isHomework
                  ? 'Ask about a problem…'
                  : 'Ask about this note…'
          }
          onChange={(e) => useAssistant.getState().setDraft(key, { text: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!streaming) send();
            }
          }}
        />
        <div className="composer-row">
          <div className="mode-toggle" role="radiogroup" aria-label="Mode">
            <button className={cx(draft.mode === 'chat' && 'is-active')} onClick={() => useAssistant.getState().setDraft(key, { mode: 'chat' })}>
              <Sparkles size={13} /> Ask
            </button>
            <button
              className={cx(draft.mode === 'tutor' && 'is-active')}
              onClick={() => useAssistant.getState().setDraft(key, { mode: 'tutor' })}
              title="Guides you step by step instead of giving the answer"
            >
              <GraduationCap size={13} /> Tutor
            </button>
          </div>
          <button className="icon-btn" title="Point at part of the page (✦ Ask tool)" onClick={() => useTools.getState().setTool('ask')} disabled={!noteId}>
            <ScanSearch size={16} />
          </button>
          <span className="grow" />
          {streaming ? (
            <button className="send-btn is-stop" onClick={() => useAssistant.getState().stop()} aria-label="Stop">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" onClick={() => send()} disabled={!noteId || (!draft.text.trim() && !draft.attachments.length)} aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {cite.popover}
    </aside>
  );
}
