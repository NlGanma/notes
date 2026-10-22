import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  BookMarked,
  BookOpen,
  ChevronDown,
  Folder,
  GraduationCap,
  Hash,
  Layers,
  LibraryBig,
  ListChecks,
  MessageSquarePlus,
  ScrollText,
  ShieldCheck,
  Square,
  Library,
} from 'lucide-react';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { useAI } from '../../state/ai';
import { LIBRARY_KEY, useAssistant, type ChatMsg, type SourceRef } from '../../state/assistant';
import { useLibrary } from '../../state/library';
import { chunkVault, type Scope } from '../../lib/ai/rag';
import { STUDY_TOOLS, type StudyTool } from '../../lib/ai/prompts';
import { MessageView } from '../ai/Message';
import { Popover } from '../common/Popover';
import { Flashcards, Quiz, parseStudyJSON } from './StudyTools';
import { cx, plural } from '../../lib/util';
import { openSource, SourcesList, useCitePreview } from '../ai/Citations';
import { ClassBadge } from '../classes/ClassIcon';
import { classForFolder, classInfo, listClasses } from '../../lib/classes';
import { Toggle } from '../../editor/ui/InkToolbar';

const TOOL_ICONS: Record<StudyTool, React.ReactNode> = {
  guide: <ScrollText size={18} />,
  flashcards: <Layers size={18} />,
  quiz: <ListChecks size={18} />,
  terms: <BookMarked size={18} />,
  summary: <BookOpen size={18} />,
};

const TOOL_HINTS: Record<StudyTool, string> = {
  guide: 'Key concepts, formulas & practice questions',
  flashcards: 'Flip cards made from your notes',
  quiz: 'Multiple choice with explanations',
  terms: 'A glossary of everything defined',
  summary: 'What these notes cover, in bullets',
};

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

export function LibraryView() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const ai = useAI();
  const lib = useLibrary();
  const thread = useAssistant((s) => s.threads[LIBRARY_KEY]);
  const streaming = useAssistant((s) => s.streaming === LIBRARY_KEY);
  const folderMeta = useVault((s) => s.folderMeta);
  const scope = useUI((s) => s.libraryScope);
  const setScope = (sc: Scope) => useUI.getState().set({ libraryScope: sc });
  const classes = useMemo(() => listClasses(folders, folderMeta), [folders, folderMeta]);
  const scopeClass = scope.kind === 'folder' && folderMeta[scope.path]?.kind === 'class' ? classInfo(scope.path, folderMeta[scope.path]) : null;
  const plainFolders = folders.filter((f) => !classForFolder(f, folderMeta));
  const [text, setText] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const cite = useCitePreview();
  const scopeBtn = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages = thread?.messages ?? [];

  const chunks = useMemo(() => chunkVault(Object.values(notes), scope), [notes, scope]);
  const noteCount = useMemo(() => new Set(chunks.map((c) => c.noteId)).size, [chunks]);
  const tags = useMemo(() => [...new Set(Object.values(notes).flatMap((n) => (n.meta.trashed ? [] : n.meta.tags)))].sort(), [notes]);

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
      if (q) void useAssistant.getState().askLibrary({ prompt: q, scope, scopeLabel: scope.kind === 'all' ? undefined : scopeLabel(scope) });
    };
    window.addEventListener('nib:library-ask', on);
    return () => window.removeEventListener('nib:library-ask', on);
  }, [scope]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  // Suggested questions from the section headings of course notes in scope.
  const suggestions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const isGuide = (id: string) => notes[id]?.meta.tags.includes('guide');
    for (const c of chunks) {
      if (isGuide(c.noteId)) continue;
      const sec = c.section
        .split(' › ')
        .pop()
        ?.replace(/\(.*?\)/g, '')
        .trim();
      if (!sec || seen.has(sec.toLowerCase()) || sec.length > 40 || /^(notes?|summary|overview|sources|causes|key events)\b/i.test(sec)) continue;
      seen.add(sec.toLowerCase());
      out.push(questionFor(sec));
      if (out.length >= 4) break;
    }
    return out;
  }, [chunks, notes]);

  const ask = (q?: string, tool?: StudyTool) => {
    const prompt = (q ?? text).trim();
    if (!prompt && !tool) return;
    setText('');
    void useAssistant.getState().askLibrary({ prompt, scope, tool, scopeLabel: scope.kind === 'all' ? undefined : scopeLabel(scope) });
  };

  const indexLabel =
    lib.status === 'indexing'
      ? `Indexing ${lib.done}/${lib.total}…`
      : ai.embedModel && ai.status === 'online'
        ? `Semantic + keyword search · ${ai.embedModel}`
        : 'Keyword search · add an embedding model for smarter matching';

  return (
    <div className="library">
      <div className="library-head">
        <div className="library-title">
          <span className="library-icon">
            <LibraryBig size={20} />
          </span>
          <div>
            <h1>{scopeClass ? `Ask ${scopeClass.name}` : 'Ask your notes'}</h1>
            <div className="library-sub">
              {scopeClass
                ? `Answers come only from your ${scopeClass.name} notes — with sources, so you know it’s what was taught in class.`
                : 'Answers come from your own notes — with sources, so you know it’s what was taught in class.'}
            </div>
          </div>
        </div>
        <div className="library-controls">
          <button ref={scopeBtn} className="btn is-ghost" onClick={() => setScopeOpen((v) => !v)}>
            {scopeClass ? (
              <ClassBadge cls={scopeClass} size={18} />
            ) : scope.kind === 'folder' ? (
              <Folder size={14} />
            ) : scope.kind === 'tag' ? (
              <Hash size={14} />
            ) : (
              <Library size={14} />
            )}
            {scopeLabel(scope)}
            <span className="muted">· {plural(noteCount, 'note')}</span>
            <ChevronDown size={13} />
          </button>
          {messages.length > 0 && (
            <button className="icon-btn" onClick={() => useAssistant.getState().clear(LIBRARY_KEY)} title="New conversation">
              <MessageSquarePlus size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="library-body" ref={listRef}>
        <div className="library-column">
          {!messages.length && (
            <div className="library-empty">
              <div className="library-hero">
                <div className="library-hero-title">What do you want to know?</div>
                <div className="library-hero-sub">
                  {plural(chunks.length, 'passage')} from {plural(noteCount, 'note')} · {indexLabel}
                </div>
              </div>
              {suggestions.length > 0 && (
                <div className="suggest-qs">
                  {suggestions.map((s) => (
                    <button key={s} className="suggest-q" onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="study-tools">
                {(Object.keys(STUDY_TOOLS) as StudyTool[]).map((t) => (
                  <button key={t} className="study-tool" onClick={() => ask('', t)}>
                    <span className="study-tool-icon">{TOOL_ICONS[t]}</span>
                    <span className="study-tool-name">{STUDY_TOOLS[t].label}</span>
                    <span className="study-tool-hint">{TOOL_HINTS[t]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <LibraryMessage
              key={m.id}
              msg={m}
              onCite={(n, el) => cite.show(n, el, m.sources)}
              onOpen={openSource}
              onRetry={m.role === 'assistant' && m === messages[messages.length - 1] ? () => useAssistant.getState().regenerate(LIBRARY_KEY) : undefined}
            />
          ))}
        </div>
      </div>

      <div className="library-composer">
        <div className="library-composer-inner">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={`Ask a question about ${scope.kind === 'all' ? 'all your notes' : scopeLabel(scope)}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!streaming) ask();
              }
            }}
          />
          <div className="library-composer-row">
            <label
              className={cx('strict-toggle', ai.strictLibrary && 'is-on')}
              title="When on, answers use only your notes — nothing from the model’s general knowledge"
            >
              <ShieldCheck size={14} />
              Only from my notes
              <input type="checkbox" checked={ai.strictLibrary} onChange={(e) => useAI.getState().set({ strictLibrary: e.target.checked })} />
            </label>
            <span className="grow" />
            {streaming ? (
              <button className="send-btn is-stop" onClick={() => useAssistant.getState().stop()} aria-label="Stop">
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button className="send-btn" disabled={!text.trim()} onClick={() => ask()} aria-label="Ask">
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <Popover anchor={scopeBtn.current} open={scopeOpen} onClose={() => setScopeOpen(false)} align="end" className="menu-pop">
        <div className="menu scope-menu">
          <button className={cx('menu-item', scope.kind === 'all' && 'is-checked')} onClick={() => (setScope({ kind: 'all' }), setScopeOpen(false))}>
            <Library size={15} />
            <span className="menu-label">All notes</span>
          </button>
          {classes.length > 0 && <div className="menu-title">Classes</div>}
          {classes.map((c) => (
            <button
              key={c.path}
              className={cx('menu-item', scope.kind === 'folder' && scope.path === c.path && 'is-checked')}
              onClick={() => (setScope({ kind: 'folder', path: c.path }), setScopeOpen(false))}
            >
              <ClassBadge cls={c} size={18} />
              <span className="menu-label">{c.name}</span>
              {c.code && <span className="menu-hint">{c.code}</span>}
            </button>
          ))}
          {plainFolders.length > 0 && <div className="menu-title">Folders</div>}
          {plainFolders.map((f) => (
            <button
              key={f}
              className={cx('menu-item', scope.kind === 'folder' && scope.path === f && 'is-checked')}
              style={{ paddingLeft: 10 + (f.split('/').length - 1) * 14 }}
              onClick={() => (setScope({ kind: 'folder', path: f }), setScopeOpen(false))}
            >
              <Folder size={15} />
              <span className="menu-label">{f.split('/').pop()}</span>
            </button>
          ))}
          {tags.length > 0 && <div className="menu-title">Tags</div>}
          {tags.map((t) => (
            <button
              key={t}
              className={cx('menu-item', scope.kind === 'tag' && scope.tag === t && 'is-checked')}
              onClick={() => (setScope({ kind: 'tag', tag: t }), setScopeOpen(false))}
            >
              <Hash size={15} />
              <span className="menu-label">{t}</span>
            </button>
          ))}
        </div>
      </Popover>

      {cite.popover}
    </div>
  );
}

/** Turns a section heading into a natural question ("Limit laws" → "What are the limit laws?"). */
function questionFor(heading: string): string {
  const h = heading.charAt(0).toLowerCase() + heading.slice(1);
  if (/^(definition|meaning) of /i.test(heading)) return `What's the ${h}?`;
  if (/theorem|principle|rule$|law$/i.test(heading)) return `What does the ${h} say?`;
  if (/(laws|rules|equations|formulas)$/i.test(heading)) return `What are the ${h}?`;
  if (/^(worked example|example)/i.test(heading)) return 'Walk me through the worked example';
  if (/ vs\.? /i.test(heading)) return `What's the difference: ${h}?`;
  return `Explain ${h}`;
}

function LibraryMessage({
  msg,
  onCite,
  onOpen,
  onRetry,
}: {
  msg: ChatMsg;
  onCite(n: number, el: HTMLElement): void;
  onOpen(s: SourceRef): void;
  onRetry?(): void;
}) {
  const isTool = msg.tool === 'flashcards' || msg.tool === 'quiz';
  const parsed = useMemo(() => (isTool && msg.status === 'done' ? parseStudyJSON(msg.tool!, msg.content) : null), [isTool, msg.status, msg.content, msg.tool]);

  if (msg.role === 'user') {
    return (
      <div className="msg is-user">
        <div className={cx('msg-bubble', msg.tool && 'is-tool')}>
          {msg.tool && (
            <span className="msg-tool-icon">
              <GraduationCap size={13} />
            </span>
          )}
          {msg.content}
        </div>
      </div>
    );
  }

  if (isTool && msg.status !== 'error') {
    return (
      <div className="msg is-bot">
        {msg.status === 'streaming' && (
          <div className="msg-making">
            <span className="spinner" /> {msg.tool === 'quiz' ? 'Writing your quiz from your notes…' : 'Making flashcards from your notes…'}
          </div>
        )}
        {msg.status === 'done' && parsed?.kind === 'flashcards' && <Flashcards cards={parsed.cards} sources={msg.sources ?? []} onOpen={onOpen} />}
        {msg.status === 'done' && parsed?.kind === 'quiz' && <Quiz questions={parsed.questions} sources={msg.sources ?? []} onOpen={onOpen} />}
        {msg.status === 'done' && !parsed && <MessageView msg={msg} citations onCite={onCite} onRegenerate={onRetry} />}
      </div>
    );
  }

  return (
    <MessageView msg={msg} citations onCite={onCite} onRegenerate={onRetry} onContinue={() => useAssistant.getState().continueReply(LIBRARY_KEY, msg.id)}>
      {msg.status !== 'streaming' && msg.sources && msg.sources.length > 0 && <SourcesList content={msg.content} sources={msg.sources} />}
    </MessageView>
  );
}

export { Toggle };
