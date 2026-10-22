import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Library,
  LibraryBig,
  MessageSquarePlus,
  MessageSquareText,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { LIBRARY_KEY, useAssistant, type ChatMsg } from '../../state/assistant';
import { useLibrary } from '../../state/library';
import { questionNumber, useReview } from '../../state/review';
import { chunkVault, type Scope } from '../../lib/ai/rag';
import { renderMarkdown } from '../../lib/ai/markdown';
import type { StudyTool } from '../../lib/ai/prompts';
import { openReview } from '../../lib/commands';
import { classForFolder, classInfo, listClasses } from '../../lib/classes';
import { MessageView, shownMarkdown } from '../ai/Message';
import { SourcesList, useCitePreview } from '../ai/Citations';
import { Modal } from '../common/Modal';
import { Popover } from '../common/Popover';
import { ClassGlyph } from '../classes/ClassIcon';
import { cx, plural } from '../../lib/util';
import { parseStudyJSON, saveFlashcards } from './StudyTools';
import { SourcesPanel } from './SourcesPanel';
import { ArtifactView, StudioPanel, ToolIcon, toolStyle, type Output } from './StudioPanel';
import {
  TOOL_LOOK,
  checkedIn,
  notebookClass,
  notebookFor,
  notebookNotes,
  notebookTitle,
  overviewMarkdown,
  questionFor,
  saveMarkdownNote,
  scopeFor,
  topicsOf,
  type Notebook,
} from './notebook';

export function scopeLabel(s: Scope): string {
  switch (s.kind) {
    case 'all':
      return 'All notes';
    case 'folder': {
      const fm = useVault.getState().folderMeta;
      return fm[s.path]?.kind === 'class' ? classInfo(s.path, fm[s.path]).name : s.path.split('/').pop()!;
    }
    case 'tag':
      return `#${s.tag}`;
    case 'note':
      return useVault.getState().notes[s.id]?.meta.title || 'Untitled';
    case 'notes':
      return plural(s.ids.length, 'note');
  }
}

const MAKING: Record<StudyTool, string> = {
  guide: 'Writing a study guide from your notes…',
  summary: 'Summarising your notes…',
  terms: 'Collecting the key terms in your notes…',
  flashcards: 'Making flashcards from your notes…',
  quiz: 'Writing your quiz from your notes…',
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Today • 10:21 AM", NotebookLM's separator above a conversation. */
function dayStamp(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${today ? 'Today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} • ${time}`;
}

/** Below these widths of the page the side panels fold to rails (the app may be 1024px wide with the drawer open). */
const SOURCES_MIN = 900;
const STUDIO_MIN = 1120;

export function LibraryView() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const ai = useAI();
  const lib = useLibrary();
  const thread = useAssistant((s) => s.threads[LIBRARY_KEY]);
  const streaming = useAssistant((s) => s.streaming === LIBRARY_KEY);
  const scope = useUI((s) => s.libraryScope);
  const setScope = (sc: Scope) => useUI.getState().set({ libraryScope: sc });
  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  // A review session left for "Why?" stays one click away.
  const reviewing = useReview((s) => (s.session ? `${questionNumber(s.session, s.current)}/${s.session.opts.length}` : null));

  const notebook = useMemo(() => notebookFor(scope, notes, folderMeta), [scope, notes, folderMeta]);
  const list = useMemo(() => notebookNotes(notes, notebook), [notes, notebook]);
  const checked = useMemo(() => checkedIn(scope, list), [scope, list]);
  const cls = notebookClass(notebook, folderMeta);
  const title = notebookTitle(notebook, folderMeta);
  const count = checked.size;
  // In the Sources panel's order, so the overview and suggestions don't reshuffle when a note is saved.
  const chunks = useMemo(() => {
    const order = new Map(list.map((n, i) => [n.meta.id, i]));
    const sorted = Object.values(notes).sort((a, b) => (order.get(a.meta.id) ?? 1e9) - (order.get(b.meta.id) ?? 1e9));
    return chunkVault(sorted, scope);
  }, [notes, scope, list]);
  // What the model is told the notes are for ("your notes for Calculus I").
  const label = count === 1 && scope.kind !== 'folder' ? notes[[...checked][0]]?.meta.title : notebook.kind === 'folder' ? title : undefined;

  const [text, setText] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [artifact, setArtifact] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // A study tool started here (or from a class's Study tab) opens in Studio when it's done.
  const [waitFor, setWaitFor] = useState<string | null>(() => {
    const last = useAssistant.getState().threads[LIBRARY_KEY]?.messages.at(-1);
    return last?.tool && last.status === 'streaming' ? last.id : null;
  });
  const cite = useCitePreview({ placement: 'right' });
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ---------------------------------------------------------------- layout
  const [width, setWidth] = useState(1200);
  const [pref, setPref] = useState<{ sources?: boolean; studio?: boolean; last?: 'sources' | 'studio' }>({});
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- Studio outputs (the thread's study-tool replies)
  const outputs = useMemo<Output[]>(
    () =>
      messages
        .filter((m) => m.role === 'assistant' && m.tool)
        .map((m) => {
          const tool = m.tool!;
          const json = tool === 'flashcards' || tool === 'quiz';
          const parsed = json && m.status === 'done' ? parseStudyJSON(tool, m.content) : null;
          const noun = TOOL_LOOK[tool].noun;
          return {
            msg: m,
            tool,
            title: m.scopeLabel ? `${m.scopeLabel} ${noun}` : capital(noun),
            notes: new Set((m.sources ?? []).map((s) => s.noteId)).size,
            busy: m.status === 'streaming',
            failed: m.status === 'error' || m.status === 'stopped' || (json && m.status === 'done' && !parsed),
            parsed,
          };
        })
        .reverse(),
    [messages],
  );
  const art = outputs.find((o) => o.msg.id === artifact) ?? null;
  const openArtifact = (id: string) => {
    setArtifact(id);
    setOpened((s) => new Set(s).add(id));
  };

  useEffect(() => {
    if (!waitFor) return;
    const m = messages.find((x) => x.id === waitFor);
    if (!m) setWaitFor(null);
    else if (m.status !== 'streaming') {
      setWaitFor(null);
      if (m.status === 'done') openArtifact(m.id);
    }
  }, [messages, waitFor]);

  let srcOpen = pref.sources ?? width >= SOURCES_MIN;
  let studioOpen = pref.studio ?? width >= STUDIO_MIN;
  // Narrow: one side panel at a time (the one opened last), so the chat keeps its room.
  if (width < STUDIO_MIN && srcOpen && studioOpen) {
    if (pref.last === 'studio') srcOpen = false;
    else studioOpen = false;
  }
  if (art && width < STUDIO_MIN && pref.last !== 'sources') srcOpen = false;
  // A note open in Sources widens that panel; Studio folds to its rail if the chat would get too narrow.
  const viewer = !!viewing && !art && !!notes[viewing];
  if (viewer) {
    srcOpen = true;
    if (width - 64 - Math.min(520, width * 0.44) - (studioOpen ? 300 : 56) < 420) studioOpen = false;
  }
  const toggleSources = () => setPref((p) => ({ ...p, sources: !srcOpen, last: !srcOpen ? 'sources' : p.last }));
  const toggleStudio = () => {
    if (art) return setArtifact(null);
    setPref((p) => ({ ...p, studio: !studioOpen, last: !studioOpen ? 'studio' : p.last }));
  };

  // ---------------------------------------------------------------- effects
  useEffect(() => {
    void lib.ensure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.embedModel, ai.status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // "Ask your notes: …" from Quick Open.
  useEffect(() => {
    const on = (e: Event) => {
      const q = (e as CustomEvent<string>).detail;
      if (q) void useAssistant.getState().askLibrary({ prompt: q, scope, scopeLabel: label });
    };
    window.addEventListener('nib:library-ask', on);
    return () => window.removeEventListener('nib:library-ask', on);
  }, [scope, label]);

  // Escape closes an open study tool (dialogs and popovers handle their own Escape first).
  useEffect(() => {
    if (!art) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, .modal-backdrop')) setArtifact(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [art]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, art]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
    // Re-measured when the panels fold or unfold (the box's width changes).
  }, [text, art, width]);

  // Suggested questions from the section headings of the ticked notes (ones already asked drop out).
  const suggestions = useMemo(() => {
    const asked = new Set(messages.filter((m) => m.role === 'user').map((m) => m.content.toLowerCase()));
    return topicsOf(chunks, notes)
      .map((t) => questionFor(t.topic))
      .filter((q) => !asked.has(q.toLowerCase()))
      .slice(0, 6);
  }, [chunks, notes, messages]);
  const overview = useMemo(() => overviewMarkdown(chunks, notes, folderMeta, notebook), [chunks, notes, folderMeta, notebook]);

  // ---------------------------------------------------------------- actions
  const ask = (q?: string, tool?: StudyTool) => {
    const prompt = (q ?? text).trim();
    if ((!prompt && !tool) || streaming || !count) return;
    if (q === undefined || tool) setText('');
    void useAssistant.getState().askLibrary({ prompt, scope, tool, scopeLabel: label });
    if (tool) setWaitFor(useAssistant.getState().threads[LIBRARY_KEY]?.messages.at(-1)?.id ?? null);
  };
  const explain = (prompt: string) => {
    if (streaming) return;
    setArtifact(null);
    ask(prompt);
  };
  const folder = notebook.kind === 'folder' ? notebook.path : '';
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
        .map((q, k) => `### ${k + 1}. ${q.q}\n\n${q.choices.map((c, ci) => `- ${L[ci]}. ${c}`).join('\n')}\n\n**Answer:** ${L[q.answer]}. ${q.choices[q.answer]}${q.explain ? ` — ${q.explain}` : ''}`)
        .join('\n\n');
      return void saveMarkdownNote(o.title, md, folder, ['quiz']);
    }
    void saveMarkdownNote(o.title, shownMarkdown(o.msg), folder);
  };
  const deleteOutput = (id: string) => {
    const t = useAssistant.getState().threads[LIBRARY_KEY];
    if (!t) return;
    const i = t.messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (t.messages[i].status === 'streaming') useAssistant.getState().stop();
    // The tool's request goes with it (it's not a question anyone typed).
    const drop = new Set([id, ...(t.messages[i - 1]?.role === 'user' && t.messages[i - 1].tool ? [t.messages[i - 1].id] : [])]);
    useAssistant.setState((s) => ({ threads: { ...s.threads, [LIBRARY_KEY]: { ...t, messages: t.messages.filter((m) => !drop.has(m.id)) } } }));
    if (artifact === id) setArtifact(null);
  };
  const newConversation = () => {
    useAssistant.getState().clear(LIBRARY_KEY);
    setArtifact(null);
    setWaitFor(null);
  };
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const offline = ai.status === 'offline';
  const visible = messages.filter((m) => !(m.role === 'user' && m.tool));

  // ---------------------------------------------------------------- render
  const chatHeadButtons = (
    <>
      {messages.length > 0 && (
        <button className="icon-btn" onClick={newConversation} title="New conversation" aria-label="New conversation">
          <MessageSquarePlus size={20} />
        </button>
      )}
      <button className="icon-btn" onClick={() => setConfigOpen(true)} title="Configure chat" aria-label="Configure chat">
        <SlidersHorizontal size={20} />
      </button>
    </>
  );

  return (
    <div className="library" ref={rootRef} style={cls ? ({ ['--class-glyph' as string]: cls.color } as React.CSSProperties) : undefined}>
      <header className="lib-top">
        <button className="library-title" onClick={(e) => setMenuEl(e.currentTarget)} aria-haspopup="menu" title="Change notebook">
          <span className="lib-top-glyph">{cls ? <ClassGlyph icon={cls.icon} size={24} /> : notebook.kind === 'folder' ? <Folder size={24} /> : <LibraryBig size={24} />}</span>
          <h1>{title}</h1>
          <ChevronDown size={20} className="lib-top-chev" />
        </button>
        <span className="grow" />
        {reviewing && (
          <button className="btn is-tonal" onClick={() => useUI.getState().setView({ kind: 'review' })} title="Back to your review session">
            <ArrowLeft size={18} /> Back to review · {reviewing}
          </button>
        )}
      </header>

      <div className="lib-panels">
        <SourcesPanel
          notebook={notebook}
          list={list}
          checked={checked}
          onCheck={(next) => setScope(scopeFor(notebook, next, list))}
          rail={!srcOpen}
          onToggle={() => (viewer ? setViewing(null) : toggleSources())}
          viewing={viewer ? viewing : null}
          onView={setViewing}
          onAsk={(q) => ask(q)}
        />

        {art ? (
          <aside className="lib-panel lib-chat is-rail" aria-label="Chat">
            <div className="lib-panel-head">
              <button className="icon-btn" onClick={() => setArtifact(null)} title="Back to chat" aria-label="Back to chat">
                <MessageSquareText size={20} />
              </button>
            </div>
            <div className="lib-rail-list">{chatHeadButtons}</div>
          </aside>
        ) : (
          <section className="lib-panel lib-chat" aria-label="Chat">
            <div className="lib-panel-head">
              <span className="lib-panel-title">Chat</span>
              <span className="grow" />
              {chatHeadButtons}
            </div>
            <div className="lib-chat-body" ref={listRef}>
              <div className="lib-column">
                {!visible.length && (
                  <div className="lib-overview">
                    <span className="lib-ov-glyph">{cls ? <ClassGlyph icon={cls.icon} size={40} /> : <LibraryBig size={40} />}</span>
                    <h2 className="lib-ov-title">{title}</h2>
                    <div className="lib-ov-count">{plural(count, 'note')}</div>
                    {overview && <div className="md lib-ov-summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(overview) }} />}
                    <div className="lib-ov-actions">
                      {(['guide', 'flashcards', 'quiz'] as StudyTool[]).map((t) => (
                        <button key={t} className="overview-btn" style={toolStyle(t)} disabled={!count || streaming} onClick={() => ask('', t)}>
                          <ToolIcon tool={t} size={20} />
                          {TOOL_LOOK[t].name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {visible.length > 0 && <div className="lib-day">{dayStamp(visible[0].at)}</div>}
                {visible.map((m) =>
                  m.role === 'assistant' && m.tool ? (
                    <ToolTurn key={m.id} msg={m} onOpen={() => openArtifact(m.id)} onRetry={m === lastAssistant ? () => useAssistant.getState().regenerate(LIBRARY_KEY) : undefined} />
                  ) : (
                    <div key={m.id} className="lib-turn" {...cite.hover(m.sources)}>
                      <LibraryMessage
                        msg={m}
                        onCite={(n, el) => cite.show(n, el, m.sources)}
                        onRetry={m === lastAssistant ? () => useAssistant.getState().regenerate(LIBRARY_KEY) : undefined}
                        onSave={() => void saveAnswer(m)}
                        saved={saved.has(m.id)}
                      />
                    </div>
                  ),
                )}
              </div>
            </div>

            <div className="lib-input-wrap">
              <div className={cx('library-composer', !count && 'is-off')}>
                <div className="lib-input-row">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={text}
                    disabled={!count}
                    aria-label="Ask about your notes"
                    placeholder={count ? 'Start typing…' : 'Select at least one note to start'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (!streaming) ask();
                      }
                    }}
                  />
                  {ai.outsideKnowledge === 'never' && (
                    <button className="lib-strict" onClick={() => setConfigOpen(true)} title="Never uses the AI’s own knowledge. Change in Configure chat.">
                      Only my notes
                    </button>
                  )}
                  <span className={cx('lib-count', !count && 'is-zero')}>{plural(count, 'note')}</span>
                  {streaming ? (
                    <button className="lib-send is-stop" onClick={() => useAssistant.getState().stop()} aria-label="Stop" title="Stop">
                      <Square size={12} fill="currentColor" />
                    </button>
                  ) : (
                    <button className={cx('lib-send', !!text.trim() && count > 0 && 'is-ready')} disabled={!text.trim() || !count} onClick={() => ask()} aria-label="Ask" title="Ask">
                      <ArrowRight size={20} />
                    </button>
                  )}
                </div>
                {offline ? (
                  <div className="lib-offline">
                    The local model isn’t running, so questions can’t be answered yet.
                    <button className="btn is-ghost is-small" onClick={() => useUI.getState().openSettings('ai')}>
                      Open settings
                    </button>
                  </div>
                ) : (
                  !streaming && count > 0 && suggestions.length > 0 && <Chips items={suggestions} onPick={(q) => ask(q)} />
                )}
              </div>
            </div>
          </section>
        )}

        {art ? (
          <ArtifactView
            output={art}
            isLast={art.msg === lastAssistant}
            onClose={() => setArtifact(null)}
            onCite={cite.show}
            citeHover={cite.hover}
            onExplain={explain}
            onSave={saveOutput}
            onRetry={() => useAssistant.getState().regenerate(LIBRARY_KEY)}
          />
        ) : (
          <StudioPanel
            outputs={outputs}
            busy={streaming}
            canRun={count > 0}
            rail={!studioOpen}
            onToggle={toggleStudio}
            onRun={(t, topic) => ask(topic ?? '', t)}
            onReview={() => openReview([...checked])}
            opened={opened}
            onOpen={openArtifact}
            onDelete={deleteOutput}
            onSave={saveOutput}
          />
        )}
      </div>

      <div className="lib-foot">
        {ai.outsideKnowledge === 'never'
          ? 'Nib only answers from your notes. Check the cited passage before you rely on it.'
          : 'Nib answers from your notes and marks anything else as the AI’s own knowledge. Check the cited passage before you rely on it.'}
      </div>

      <NotebookMenu anchor={menuEl} onClose={() => setMenuEl(null)} current={notebook} folders={folders} onPick={(sc) => (setMenuEl(null), setScope(sc))} />
      <ConfigureChat open={configOpen} onClose={() => setConfigOpen(false)} />
      {cite.popover}
    </div>
  );
}

/** Switch notebook: everything, or one class (or folder). */
function NotebookMenu({ anchor, onClose, current, folders, onPick }: { anchor: HTMLElement | null; onClose(): void; current: Notebook; folders: string[]; onPick(s: Scope): void }) {
  const folderMeta = useVault((s) => s.folderMeta);
  const classes = listClasses(folders, folderMeta);
  const plain = folders.filter((f) => !f.includes('/') && !classForFolder(f, folderMeta));
  const is = (path?: string) => (path ? current.kind === 'folder' && current.path === path : current.kind === 'all');
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose} align="start" className="menu-pop">
      <div className="menu lib-nb-menu" role="menu">
        <button className={cx('menu-item', is() && 'is-checked')} onClick={() => onPick({ kind: 'all' })}>
          <Library size={20} />
          <span className="menu-label">All notes</span>
        </button>
        {classes.length > 0 && <div className="menu-title">Classes</div>}
        {classes.map((c) => (
          <button key={c.path} className={cx('menu-item', is(c.path) && 'is-checked')} onClick={() => onPick({ kind: 'folder', path: c.path })}>
            <span style={{ color: c.color, display: 'inline-flex' }}>
              <ClassGlyph icon={c.icon} size={20} />
            </span>
            <span className="menu-label">{c.name}</span>
          </button>
        ))}
        {plain.length > 0 && <div className="menu-title">Folders</div>}
        {plain.map((f) => (
          <button key={f} className={cx('menu-item', is(f) && 'is-checked')} onClick={() => onPick({ kind: 'folder', path: f })}>
            <Folder size={20} />
            <span className="menu-label">{f}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** Suggested questions inside the input box, scrolling sideways with NotebookLM's › button. */
function Chips({ items, onPick }: { items: string[]; onPick(q: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener('scroll', check);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, [items]);
  return (
    <div className="lib-chips-wrap">
      <div className="lib-chips" ref={ref}>
        {items.map((q) => (
          <button key={q} className="lib-chip" onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
      {more && (
        <button className="lib-chips-more" aria-label="More suggestions" onClick={() => ref.current?.scrollBy({ left: 240, behavior: 'smooth' })}>
          <ChevronRight size={20} />
        </button>
      )}
    </div>
  );
}

/** NotebookLM's "Configure chat": where answers may come from. */
function ConfigureChat({ open, onClose }: { open: boolean; onClose(): void }) {
  const current = useAI((s) => s.outsideKnowledge);
  const [pick, setPick] = useState(current);
  const [was, setWas] = useState(open);
  if (open !== was) {
    setWas(open);
    if (open) setPick(current);
  }
  if (!open) return null;
  const options = [
    {
      value: 'auto' as const,
      title: 'My notes first',
      body: 'Answers come from your notes, with citations. When your notes don’t cover something, Nib says so and adds the AI’s own knowledge, marked “proceed with caution”.',
    },
    {
      value: 'never' as const,
      title: 'Only my notes',
      body: 'Never use the AI’s own knowledge. When your notes don’t cover something, Nib just says so.',
    },
  ];
  return (
    <Modal open onClose={onClose} width={560} bare className="lib-dialog chat-config">
      <div className="lib-dialog-head">
        <span className="lib-dialog-icon is-plain">
          <SlidersHorizontal size={20} />
        </span>
        <span className="lib-dialog-title">Configure chat</span>
        <button className="lib-dialog-close" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      <div className="lib-dialog-body">
        <div className="lib-dialog-label">Answer from</div>
        <div className="config-options" role="radiogroup" aria-label="Answer from">
          {options.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={pick === o.value}
              className={cx('config-option', pick === o.value && 'is-on', o.value === 'never' && 'strict-toggle')}
              onClick={() => setPick(o.value)}
            >
              <span className="config-option-title">
                {o.title}
                {pick === o.value && <Check size={18} />}
              </span>
              <span className="config-option-body">{o.body}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="lib-dialog-foot">
        <button
          className="btn is-primary"
          onClick={() => {
            useAI.getState().set({ outsideKnowledge: pick });
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/** A study tool's reply in the chat: one compact row; the result itself opens in Studio. */
function ToolTurn({ msg, onOpen, onRetry }: { msg: ChatMsg; onOpen(): void; onRetry?(): void }) {
  const tool = msg.tool!;
  if (msg.status === 'streaming')
    return (
      <div className="msg is-bot lib-tool-turn">
        <div className="msg-making">
          <span className="spinner" /> {MAKING[tool]}
        </div>
      </div>
    );
  if (msg.status === 'error' || msg.status === 'stopped')
    return <MessageView msg={tool === 'flashcards' || tool === 'quiz' ? { ...msg, content: '' } : msg} onRegenerate={onRetry} iconActions />;
  const parsed = tool === 'flashcards' || tool === 'quiz' ? parseStudyJSON(tool, msg.content) : null;
  const what = parsed?.kind === 'flashcards' ? plural(parsed.cards.length, 'card') : parsed?.kind === 'quiz' ? plural(parsed.questions.length, 'question') : 'Ready';
  return (
    <div className="msg is-bot lib-tool-turn">
      <button className="lib-tool-row" style={toolStyle(tool)} onClick={onOpen}>
        <span className="lib-tool-icon">
          <ToolIcon tool={tool} size={20} />
        </span>
        <span className="lib-tool-text">
          <span className="lib-tool-title">
            {TOOL_LOOK[tool].name}
            {msg.scopeLabel ? ` · ${msg.scopeLabel}` : ''}
          </span>
          <span className="lib-tool-meta">{what} · open in Studio</span>
        </span>
        <ChevronRight size={20} className="lib-tool-chev" />
      </button>
    </div>
  );
}

function LibraryMessage({
  msg,
  onCite,
  onRetry,
  onSave,
  saved,
}: {
  msg: ChatMsg;
  onCite(n: number, el: HTMLElement): void;
  onRetry?(): void;
  onSave(): void;
  saved: boolean;
}) {
  if (msg.role === 'user') {
    return (
      <div className="msg is-user">
        <div className="msg-bubble">{msg.label ?? msg.content}</div>
      </div>
    );
  }
  return (
    <MessageView
      msg={msg}
      citations
      onCite={onCite}
      onRegenerate={onRetry}
      onContinue={() => useAssistant.getState().continueReply(LIBRARY_KEY, msg.id)}
      onForce={() => useAssistant.getState().forceNotes(LIBRARY_KEY)}
      onSave={onSave}
      saved={saved}
      iconActions
    >
      {msg.status !== 'streaming' && !msg.ownOnly && msg.sources && msg.sources.length > 0 && <SourcesList content={shownMarkdown(msg)} sources={msg.sources} label="From your notes" />}
    </MessageView>
  );
}
