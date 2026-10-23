import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, History, RefreshCw, Square, SquarePen, Trash2, X } from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { LIBRARY_KEY, useAssistant, type ChatMsg } from '../../state/assistant';
import { useLibrary } from '../../state/library';
import { questionNumber, useReview } from '../../state/review';
import type { Scope } from '../../lib/ai/rag';
import type { StudyTool } from '../../lib/ai/prompts';
import { classForFolder, classInfo, listClasses } from '../../lib/classes';
import { cx, formatRelativeTime } from '../../lib/util';
import { citedInAnswer } from '../../lib/ai/markdown';
import { MessageView, shownMarkdown } from '../ai/Message';
import { SourcesList, useCitePreview } from '../ai/Citations';
import { ComposerStatus, useAvailability } from '../ai/ComposerStatus';
import { Popover } from '../common/Popover';
import { toast } from '../common/toast';
import { NotePicker } from '../homework/NotePicker';
import { MainbarSlot } from '../MainBar';
import { parseStudyJSON, saveFlashcards } from './StudyTools';
import { ArtifactPanel, LeftOut, ToolIcon, outputMeta, type Output } from './ArtifactPanel';
import { conversationTitle, deleteConversation, pastConversations, reopenConversation, startConversation } from './history';
import { TOOL_LOOK, notebookNotes, saveMarkdownNote, scopeFromPick, scopeName, scopeNotes, selectionFor } from './notebook';

/** The study chips under the composer, in the order a student reaches for them. */
const TOOLS: { tool: StudyTool; label: string }[] = [
  { tool: 'summary', label: 'Summarize' },
  { tool: 'guide', label: 'Study guide' },
  { tool: 'terms', label: 'Key terms' },
  { tool: 'flashcards', label: 'Flashcards' },
  { tool: 'quiz', label: 'Quiz me' },
];

/** What a study tool request says in the student's bubble. */
function toolRequest(tool: StudyTool, focus?: string): string {
  const on = focus ? ` on ${focus}` : '';
  switch (tool) {
    case 'summary':
      return focus ? `Summarize my notes on ${focus}` : 'Summarize my notes';
    case 'guide':
      return `Make a study guide${on}`;
    case 'terms':
      return focus ? `List the key terms for ${focus}` : 'List the key terms';
    case 'flashcards':
      return `Make flashcards${on}`;
    case 'quiz':
      return `Quiz me${on}`;
  }
}

const MAKING: Record<StudyTool, string> = {
  summary: 'Summarizing your notes…',
  guide: 'Writing a study guide from your notes…',
  terms: 'Collecting the key terms in your notes…',
  flashcards: 'Making flashcards from your notes…',
  quiz: 'Writing a quiz from your notes…',
};

/** A study output's name: what it covers ("Calculus I flashcards", "Flashcards: limits"). */
function outputTitle(m: ChatMsg, focus?: string): string {
  const look = TOOL_LOOK[m.tool!];
  if (focus) return `${look.name}: ${focus}`;
  return m.scopeLabel ? `${m.scopeLabel} ${look.noun}` : look.name;
}

/** Below this width the page can't share: an open study output floats over the conversation. */
const SIDE_BY_SIDE = 1100;

const citedCount = new WeakMap<ChatMsg, number>();
/** How many notes a finished prose output cites (a finished message never changes, so it's counted once). */
function notesCited(m: ChatMsg): number {
  let n = citedCount.get(m);
  if (n === undefined) {
    const used = citedInAnswer(shownMarkdown(m), m.sources?.length);
    n = new Set((m.sources ?? []).filter((s) => used.has(s.n)).map((s) => s.noteId)).size;
    citedCount.set(m, n);
  }
  return n;
}

export function LibraryView() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const outsideKnowledge = useAI((s) => s.outsideKnowledge);
  const embedModel = useAI((s) => s.embedModel);
  const aiStatus = useAI((s) => s.status);
  const availability = useAvailability();
  const threads = useAssistant((s) => s.threads);
  const streaming = useAssistant((s) => s.streaming === LIBRARY_KEY);
  const scope = useUI((s) => s.libraryScope);
  const setScope = (sc: Scope) => useUI.getState().set({ libraryScope: sc });
  const thread = threads[LIBRARY_KEY];
  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  const past = useMemo(() => pastConversations(threads), [threads]);
  // A review session left for "Why?" stays one click away.
  const reviewing = useReview((s) => (s.session ? `${questionNumber(s.session, s.current)}/${s.session.opts.length}` : null));

  const inScope = useMemo(() => scopeNotes(scope, notes), [scope, notes]);
  const count = inScope.length;
  const anyNotes = useMemo(() => notebookNotes(notes, { kind: 'all' }).length > 0, [notes]);
  const name = scopeName(scope, notes, folderMeta);
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  // From the class list, so a class without a colour of its own has the one the sidebar gives it.
  const cls = scope.kind === 'folder' ? (classes.find((c) => c.path === scope.path) ?? null) : null;
  // What the model is told the notes are for ("your notes for Calculus I"): a folder, one note, or the one class a list sits in.
  const modelLabel = useMemo(() => {
    if (scope.kind === 'folder') return name;
    if (scope.kind !== 'note' && scope.kind !== 'notes') return undefined;
    if (inScope.length === 1) return inScope[0].meta.title || undefined;
    const homes = new Set(inScope.map((n) => classForFolder(n.meta.folder, folderMeta)));
    const only = homes.size === 1 ? [...homes][0] : null;
    return only ? classInfo(only, folderMeta[only]).name : undefined;
  }, [scope, name, inScope, folderMeta]);

  const [text, setText] = useState('');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [artifact, setArtifact] = useState<string | null>(null);
  const [scopeEl, setScopeEl] = useState<HTMLElement | null>(null);
  const [historyEl, setHistoryEl] = useState<HTMLElement | null>(null);
  const [convEl, setConvEl] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
  // A study tool started here (or before the page opened, e.g. from a class page) opens beside the chat when it's done.
  const [waitFor, setWaitFor] = useState<string | null>(() => {
    const last = useAssistant.getState().threads[LIBRARY_KEY]?.messages.at(-1);
    return last?.tool && last.status === 'streaming' ? last.id : null;
  });
  const cite = useCitePreview({ placement: 'right' });
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);

  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- study outputs (the conversation's tool replies)
  const outputs = useMemo(() => {
    const out = new Map<string, Output>();
    messages.forEach((m, i) => {
      if (m.role !== 'assistant' || !m.tool) return;
      const tool = m.tool;
      const json = tool === 'flashcards' || tool === 'quiz';
      const parsed = json && m.status === 'done' ? parseStudyJSON(tool, m.content) : null;
      const ask = messages[i - 1]?.role === 'user' ? messages[i - 1] : undefined;
      out.set(m.id, {
        msg: m,
        tool,
        title: outputTitle(m, ask?.focus),
        notes: !json && m.status === 'done' ? notesCited(m) : 0,
        busy: m.status === 'streaming',
        failed: m.status === 'error' || m.status === 'stopped' || !!m.insufficient || (json && m.status === 'done' && !parsed),
        parsed,
      });
    });
    return out;
  }, [messages]);
  const art = (artifact && outputs.get(artifact)) || null;

  useEffect(() => {
    if (!waitFor) return;
    const m = messages.find((x) => x.id === waitFor);
    if (!m) setWaitFor(null);
    else if (m.status !== 'streaming') {
      setWaitFor(null);
      // A reply that made nothing ("not enough in these notes", cards that didn't hold up) stays in the conversation.
      if (m.status === 'done' && !outputs.get(m.id)?.failed) setArtifact(m.id);
    }
  }, [messages, waitFor, outputs]);

  // ---------------------------------------------------------------- effects
  useEffect(() => {
    void useLibrary.getState().ensure();
  }, [embedModel, aiStatus]);

  const empty = messages.length === 0;
  // The composer moves between the middle of the page and the bottom; it keeps the keyboard either way.
  useEffect(() => {
    inputRef.current?.focus();
  }, [empty]);

  // "Ask your notes: …" from the palette (and anything else that asks on the page's behalf): a new question, a new conversation.
  useEffect(() => {
    const on = (e: Event) => {
      const q = (e as CustomEvent<string>).detail;
      if (!q) return;
      if (useAssistant.getState().threads[LIBRARY_KEY]?.messages.length) newConversation();
      void useAssistant.getState().askLibrary({ prompt: q, scope, scopeLabel: modelLabel });
    };
    window.addEventListener('nib:library-ask', on);
    return () => window.removeEventListener('nib:library-ask', on);
  }, [scope, modelLabel]);

  // Escape closes an open study output (dialogs and popovers handle their own Escape first).
  useEffect(() => {
    if (!art) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, .modal-backdrop, .popover')) setArtifact(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [art]);

  // Follows the reply as it streams, unless the student scrolled up to read; a new question always shows.
  const seen = useRef(messages.length);
  useLayoutEffect(() => {
    if (messages.length > seen.current) stick.current = true;
    seen.current = messages.length;
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, art]);
  // …and stays at the bottom while the page around it changes size (an output opening beside it).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [empty]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(empty ? 240 : 200, el.scrollHeight)}px`;
  }, [text, empty, width]);

  // ---------------------------------------------------------------- actions
  const answerable = availability !== 'offline' && availability !== 'nomodel';
  const canSend = !!text.trim() && count > 0 && answerable && !streaming;
  const ask = () => {
    if (!canSend) return;
    stick.current = true;
    const prompt = text.trim();
    setText('');
    void useAssistant.getState().askLibrary({ prompt, scope, scopeLabel: modelLabel });
  };
  /** A study chip: whatever is typed becomes what the tool focuses on, and the box clears. */
  const run = (tool: StudyTool) => {
    if (!count || streaming || !answerable) return;
    stick.current = true;
    const topic = text.trim();
    setText('');
    void useAssistant.getState().askLibrary({ prompt: topic, scope, tool, scopeLabel: modelLabel });
    setWaitFor(useAssistant.getState().threads[LIBRARY_KEY]?.messages.at(-1)?.id ?? null);
  };
  const explain = (prompt: string) => {
    if (streaming || !answerable) return;
    // Over a narrow page the output would hide the answer.
    if (width < SIDE_BY_SIDE) setArtifact(null);
    stick.current = true;
    void useAssistant.getState().askLibrary({ prompt, scope, scopeLabel: modelLabel });
  };
  const folder = scope.kind === 'folder' ? scope.path : '';
  const saveAnswer = async (m: ChatMsg) => {
    const i = messages.indexOf(m);
    const question = [...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.content ?? 'Answer';
    const id = await saveMarkdownNote(question.length > 80 ? `${question.slice(0, 79)}…` : question, shownMarkdown(m), folder);
    if (id) setSaved((s) => new Set(s).add(m.id));
  };
  const saveOutput = (o: Output) => {
    if (o.parsed?.kind === 'flashcards') return saveFlashcards(o.parsed.cards, o.title, folder);
    if (o.parsed?.kind === 'quiz') {
      const L = 'ABCDE';
      const md = o.parsed.questions
        .map(
          (q, k) =>
            `### ${k + 1}. ${q.q}\n\n${q.choices.map((c, ci) => `- ${L[ci]}. ${c}`).join('\n')}\n\n**Answer:** ${L[q.answer]}. ${q.choices[q.answer]}${q.explain ? ` — ${q.explain}` : ''}`,
        )
        .join('\n\n');
      return void saveMarkdownNote(o.title, md, folder, ['quiz']);
    }
    void saveMarkdownNote(o.title, shownMarkdown(o.msg), folder);
  };
  const newConversation = () => {
    startConversation();
    setArtifact(null);
    setWaitFor(null);
    setText('');
    inputRef.current?.focus();
  };
  const remove = (key: string) => {
    const undo = deleteConversation(key);
    if (key === LIBRARY_KEY) {
      setArtifact(null);
      setWaitFor(null);
    }
    toast.info('Conversation deleted', undefined, { label: 'Undo', run: undo }, 8000);
  };
  const reopen = (key: string) => {
    setHistoryEl(null);
    const sc = reopenConversation(key);
    if (sc && (sc.kind !== 'folder' || folders.includes(sc.path))) setScope(sc);
    setArtifact(null);
    setWaitFor(null);
    stick.current = true;
  };
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const retry = () => {
    useAssistant.getState().regenerate(LIBRARY_KEY);
    // A study output made again opens when it's done, as it did the first time.
    if (lastAssistant?.tool) setWaitFor(useAssistant.getState().threads[LIBRARY_KEY]?.messages.at(-1)?.id ?? null);
  };

  // ---------------------------------------------------------------- render
  // With no notes the greeting says so already; the (disabled) box keeps its usual words.
  const placeholder = !count
    ? 'Ask anything about your notes'
    : scope.kind === 'folder'
      ? `Ask about your ${name} notes`
      : scope.kind === 'all'
        ? 'Ask anything about your notes'
        : count === 1
          ? `Ask about ${name}`
          : 'Ask about these notes';

  const composer = (
    <div
      className={cx('library-composer', !count && 'is-off')}
      onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}
    >
      <ComposerStatus availability={availability} />
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        disabled={!count}
        aria-label="Ask about your notes"
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            ask();
          }
        }}
      />
      <div className="composer-row">
        <span className="grow" />
        <button
          className={cx('scope-chip', scopeEl && 'is-open')}
          onClick={(e) => setScopeEl(e.currentTarget)}
          aria-haspopup="menu"
          title={`Answers come from: ${name}`}
        >
          {cls && <span className="scope-dot" style={{ background: cls.color }} />}
          <span className="scope-chip-label">{name}</span>
          <ChevronDown size={14} />
        </button>
        {streaming ? (
          <button className="send-btn is-stop" onClick={() => useAssistant.getState().stop()} aria-label="Stop" title="Stop">
            <Square size={10} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" disabled={!canSend} onClick={ask} aria-label="Send" title={answerable ? 'Send' : 'Local AI isn’t running'}>
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );

  const chips = (
    <div className="study-tools" role="group" aria-label="Study tools">
      {TOOLS.map(({ tool, label }) => (
        <button
          key={tool}
          className="study-tool"
          disabled={!count || streaming || !answerable}
          title={text.trim() ? `${label} on “${text.trim()}”` : undefined}
          onClick={() => run(tool)}
        >
          <ToolIcon tool={tool} size={16} />
          {label}
        </button>
      ))}
    </div>
  );

  const overlay = width < SIDE_BY_SIDE;
  const openId = art?.msg.id ?? null;
  // Over a narrow page the conversation is covered: Tab and typing can't reach it.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (openId && overlay) main.setAttribute('inert', '');
    else main.removeAttribute('inert');
  }, [openId, overlay]);
  // …and a click on the part of it left showing closes the output (inert, it lets the click through to the page).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !openId || !overlay) return;
    const close = (e: PointerEvent) => e.target === root && setArtifact(null);
    root.addEventListener('pointerdown', close);
    return () => root.removeEventListener('pointerdown', close);
  }, [openId, overlay]);
  // An output that opens takes the keyboard, so Space flips its first card; closing it gives the keyboard back to the composer.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    const was = shownId.current;
    shownId.current = openId;
    const panel = rootRef.current?.querySelector<HTMLElement>('.lib-artifact');
    const active = document.activeElement;
    if (openId && panel) {
      if (panel.contains(active)) return;
      // Side by side, a question being typed keeps the keyboard.
      const typing = active === inputRef.current && !!inputRef.current?.value.trim();
      if (overlay || (openId !== was && !typing)) panel.focus({ preventScroll: true });
    } else if (was && (!active || active === document.body)) inputRef.current?.focus();
  }, [openId, overlay]);
  // The header names what's being asked (a class, some notes) and the conversation; "All notes" goes without saying.
  const scoped = scope.kind !== 'all' && scope.kind !== 'tag';
  const convTitle = empty ? '' : conversationTitle(messages);
  return (
    <div className={cx('library', art && 'has-artifact')} ref={rootRef}>
      <div className="lib-main" ref={mainRef}>
        <MainbarSlot>
          <div className="lib-bar no-drag">
            <div className="library-title">
              {scoped && (
                <>
                  {cls && <span className="scope-dot" style={{ background: cls.color }} />}
                  <h1 title={name}>{name}</h1>
                </>
              )}
              {scoped && convTitle && <ChevronRight size={14} className="lib-head-sep" aria-hidden />}
              {convTitle && (
                <button
                  className={cx('lib-head-conv', !scoped && 'is-only', convEl && 'is-open')}
                  onClick={(e) => setConvEl(e.currentTarget)}
                  aria-haspopup="menu"
                  title={convTitle}
                >
                  <span className="lib-head-conv-text">{convTitle}</span>
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
            {reviewing && (
              <button className="btn is-ghost is-small" onClick={() => useUI.getState().setView({ kind: 'review' })} title="Back to your review session">
                <ArrowLeft size={16} /> Back to review · {reviewing}
              </button>
            )}
            {past.length > 0 && (
              <button
                className={cx('icon-btn is-tiny', historyEl && 'is-on')}
                onClick={(e) => setHistoryEl(e.currentTarget)}
                title="History"
                aria-label="History"
                aria-haspopup="menu"
              >
                <History size={16} />
              </button>
            )}
            {!empty && (
              <button className="icon-btn is-tiny" onClick={newConversation} title="New conversation" aria-label="New conversation">
                <SquarePen size={16} />
              </button>
            )}
          </div>
        </MainbarSlot>

        <section className="lib-chat" aria-label="Conversation">
          {empty ? (
            <div className="lib-empty">
              <div className="lib-hello">
                <h2 className="lib-greeting">{count ? 'What do you want to know?' : 'Write a note first, then ask about it.'}</h2>
                {count > 0 ? (
                  <p className="lib-promise">
                    {outsideKnowledge === 'never' ? 'Answers come only from your notes.' : 'Answers come from your notes. Anything else is marked.'}
                  </p>
                ) : (
                  anyNotes && (
                    <p className="lib-promise">
                      {cls ? 'This class has no notes yet.' : scope.kind === 'folder' ? 'This folder has no notes yet.' : 'The notes picked here are gone.'}
                    </p>
                  )
                )}
              </div>
              {composer}
              {chips}
            </div>
          ) : (
            <>
              <div
                className="lib-scroll"
                ref={listRef}
                onScroll={(e) => {
                  // Only scrolling up lets go of the newest reply: a scroll event can land after more of it arrived.
                  const el = e.currentTarget;
                  if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stick.current = true;
                  else if (el.scrollTop < lastTop.current - 2) stick.current = false;
                  lastTop.current = el.scrollTop;
                }}
              >
                <div className="lib-column">
                  {messages.map((m) => {
                    if (m.role === 'user')
                      return (
                        <div key={m.id} className="msg is-user">
                          <div className="msg-bubble">{m.tool ? toolRequest(m.tool, m.focus) : (m.label ?? m.content)}</div>
                        </div>
                      );
                    const o = outputs.get(m.id);
                    if (o)
                      return (
                        <ToolTurn
                          key={m.id}
                          output={o}
                          open={art?.msg.id === m.id}
                          onOpen={() => setArtifact(m.id)}
                          onRetry={m === lastAssistant ? retry : undefined}
                        />
                      );
                    return (
                      <div key={m.id} className="lib-turn" {...cite.hover(m.sources)}>
                        <MessageView
                          msg={m}
                          citations
                          onCite={(n, el) => cite.show(n, el, m.sources)}
                          onRegenerate={m === lastAssistant ? retry : undefined}
                          onContinue={() => useAssistant.getState().continueReply(LIBRARY_KEY, m.id)}
                          onForce={() => useAssistant.getState().forceNotes(LIBRARY_KEY)}
                          onSave={() => void saveAnswer(m)}
                          saved={saved.has(m.id)}
                          iconActions
                        >
                          {m.status !== 'streaming' && !m.ownOnly && m.sources && m.sources.length > 0 && (
                            <SourcesList content={shownMarkdown(m)} sources={m.sources} label="From your notes" />
                          )}
                        </MessageView>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="lib-dock">
                <div className="lib-column">
                  {composer}
                  {chips}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {art && (
        <ArtifactPanel
          output={art}
          overlay={overlay}
          onClose={() => setArtifact(null)}
          onCite={cite.show}
          citeHover={cite.hover}
          onExplain={explain}
          onSave={saveOutput}
        />
      )}

      <Popover anchor={scopeEl} open={!!scopeEl} onClose={() => setScopeEl(null)} align="end" className="menu-pop">
        <div className="menu scope-menu" role="menu">
          <ScopeItem label="All notes" on={scope.kind === 'all' || scope.kind === 'tag'} onPick={() => (setScopeEl(null), setScope({ kind: 'all' }))} />
          {classes.length > 0 && <div className="menu-sep" />}
          {classes.map((c) => (
            <ScopeItem
              key={c.path}
              label={c.name}
              color={c.color}
              on={scope.kind === 'folder' && scope.path === c.path}
              onPick={() => (setScopeEl(null), setScope({ kind: 'folder', path: c.path }))}
            />
          ))}
          <div className="menu-sep" />
          <ScopeItem
            label="Choose notes…"
            on={scope.kind === 'note' || scope.kind === 'notes' || (scope.kind === 'folder' && !cls)}
            onPick={() => {
              setScopeEl(null);
              setPicking(true);
            }}
          />
        </div>
      </Popover>

      <Popover anchor={historyEl} open={!!historyEl} onClose={() => setHistoryEl(null)} align="end" className="menu-pop">
        <div className="menu history-menu" role="menu">
          <div className="menu-caption">Earlier conversations</div>
          {past.map((p) => (
            <div key={p.key} className="history-row">
              <button className="menu-item" role="menuitem" onClick={() => reopen(p.key)} title={p.title}>
                <span className="menu-label">{p.title}</span>
                <span className="menu-hint">{formatRelativeTime(p.at)}</span>
              </button>
              <button
                className="history-delete"
                onClick={() => {
                  if (past.length === 1) setHistoryEl(null);
                  remove(p.key);
                }}
                title="Delete"
                aria-label={`Delete “${p.title}”`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </Popover>

      <Popover anchor={convEl} open={!!convEl} onClose={() => setConvEl(null)} align="start" className="menu-pop">
        <div className="menu" role="menu">
          <button
            className="menu-item is-danger"
            role="menuitem"
            onClick={() => {
              setConvEl(null);
              remove(LIBRARY_KEY);
            }}
          >
            <Trash2 size={16} />
            <span className="menu-label">Delete conversation</span>
          </button>
        </div>
      </Popover>

      <NotePicker
        open={picking}
        title="Choose notes"
        classPath={cls?.path ?? null}
        initial={selectionFor(scope)}
        query={null}
        onInsert={(sel) => {
          setPicking(false);
          setScope(scopeFromPick(sel, notes));
        }}
        onClose={() => setPicking(false)}
      />
      {cite.popover}
    </div>
  );
}

function ScopeItem({ label, color, on, onPick }: { label: string; color?: string; on: boolean; onPick(): void }) {
  return (
    <button className="menu-item" role="menuitemradio" aria-checked={on} onClick={onPick} title={label}>
      {color && <span className="menu-dot" style={{ background: color }} />}
      <span className="menu-label">{label}</span>
      {on && <Check size={16} className="menu-check" />}
    </button>
  );
}

/** A study output in the conversation: a card that opens it beside the chat (Claude's artifact card). */
function ToolTurn({ output, open, onOpen, onRetry }: { output: Output; open: boolean; onOpen(): void; onRetry?(): void }) {
  const { msg, tool } = output;
  if (msg.status === 'streaming')
    return (
      <div className="msg is-bot lib-tool-turn">
        <div className="msg-making">
          <span className="making-dot" aria-hidden /> {MAKING[tool]}
        </div>
      </div>
    );
  const json = tool === 'flashcards' || tool === 'quiz';
  // Half-written cards or questions are JSON: a stopped or failed one shows just why.
  if (msg.status === 'error' || msg.status === 'stopped') return <MessageView msg={json ? { ...msg, content: '' } : msg} onRegenerate={onRetry} iconActions />;
  if (output.failed && msg.dropped)
    return (
      <div className="msg is-bot lib-tool-turn">
        <div className="msg-added">
          None of what the AI wrote could be matched to your notes, so nothing is shown. Try again, or pick a larger model in Settings → Local AI.
        </div>
        {onRetry && <RetryRow onRetry={onRetry} />}
      </div>
    );
  // "There isn't enough in these notes to make this yet" is a plain reply, not an output.
  if (output.failed) return <MessageView msg={msg} onRegenerate={onRetry} iconActions />;
  return (
    <div className="msg is-bot lib-tool-turn">
      <button className={cx('art-card', open && 'is-open')} onClick={onOpen} aria-pressed={open}>
        <span className="art-card-icon">
          <ToolIcon tool={tool} size={18} />
        </span>
        <span className="art-card-text">
          <span className="art-card-title">{output.title}</span>
          {outputMeta(output) && (
            <span className="art-card-meta">
              {outputMeta(output)}
              <LeftOut output={output} />
            </span>
          )}
        </span>
      </button>
      {onRetry && <RetryRow onRetry={onRetry} />}
    </div>
  );
}

function RetryRow({ onRetry }: { onRetry(): void }) {
  return (
    <div className="msg-actions">
      <button className="msg-act is-icon" onClick={onRetry} title="Retry" aria-label="Retry">
        <RefreshCw size={16} />
      </button>
    </div>
  );
}
