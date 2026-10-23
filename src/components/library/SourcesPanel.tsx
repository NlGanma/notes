import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ClipboardList, ExternalLink, FileImage, FileText, Minus, PanelLeftClose, PanelLeftOpen, Plus, Search, X } from 'lucide-react';
import type { NoteDoc } from '../../lib/vault/types';
import { useVault } from '../../state/vault';
import { useUI } from '../../state/ui';
import { classForFolder, classInfo } from '../../lib/classes';
import { newNote } from '../../lib/commands';
import { ClassGlyph } from '../classes/ClassIcon';
import { cx } from '../../lib/util';
import { docBlocks } from '../../lib/ai/context';
import { chunkNote } from '../../lib/ai/rag';
import { renderMarkdown } from '../../lib/ai/markdown';
import { isScan, questionFor, topicsOf, type Notebook } from './notebook';

/** The app's checkbox, as in Review and Link notes, the same in every row so they form one column. */
function Tick({ state, label, onChange }: { state: 'on' | 'off' | 'some'; label: string; onChange(on: boolean): void }) {
  return (
    <button
      className={cx('src-check', `is-${state}`)}
      role="checkbox"
      aria-checked={state === 'some' ? 'mixed' : state === 'on'}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(state !== 'on');
      }}
    >
      {state === 'on' ? <Check size={14} strokeWidth={3} /> : state === 'some' ? <Minus size={14} strokeWidth={3} /> : null}
    </button>
  );
}

const tri = (n: number, of: number): 'on' | 'off' | 'some' => (n === 0 ? 'off' : n === of ? 'on' : 'some');

function TypeIcon({ note }: { note: NoteDoc }) {
  if (note.meta.homework) return <ClipboardList size={20} className="src-type is-note" />;
  if (isScan(note)) return <FileImage size={20} className="src-type is-scan" />;
  return <FileText size={20} className="src-type is-note" />;
}

export function SourcesPanel({
  notebook,
  list,
  checked,
  onCheck,
  rail,
  onToggle,
  viewing,
  onView,
  onAsk,
}: {
  notebook: Notebook;
  list: NoteDoc[];
  checked: Set<string>;
  onCheck(next: Set<string>): void;
  rail: boolean;
  onToggle(): void;
  /** The note open in the panel's reader (NotebookLM's source view), if any. */
  viewing: string | null;
  onView(id: string | null): void;
  /** A key topic was picked: ask about it in the chat. */
  onAsk(q: string): void;
}) {
  const folderMeta = useVault((s) => s.folderMeta);
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return list;
    // "#tag" finds notes with that tag; anything else matches the title.
    if (q.startsWith('#')) return list.filter((n) => n.meta.tags.some((t) => t.toLowerCase().startsWith(q.slice(1))));
    return list.filter((n) => (n.meta.title || 'Untitled').toLowerCase().includes(q));
  }, [list, q]);

  // All notes: grouped by class (notes outside any class last), as NotebookLM's source groups.
  const groups = useMemo(() => {
    if (notebook.kind !== 'all') return [{ key: '', label: '', cls: null, notes: shown }];
    const by = new Map<string, NoteDoc[]>();
    for (const n of shown) {
      const c = classForFolder(n.meta.folder, folderMeta) ?? '';
      if (!by.has(c)) by.set(c, []);
      by.get(c)!.push(n);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
      .map(([key, notes]) => ({ key, label: key ? classInfo(key, folderMeta[key]).name : 'Other notes', cls: key ? classInfo(key, folderMeta[key]) : null, notes }));
  }, [notebook.kind, shown, folderMeta]);

  const set = (ids: string[], on: boolean) => {
    const next = new Set(checked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onCheck(next);
  };
  const open = (n: NoteDoc) => onView(n.meta.id);
  const addFolder = notebook.kind === 'folder' ? notebook.path : '';
  const viewed = useVault((s) => (viewing ? s.notes[viewing] : null));
  if (viewed && !rail) return <SourceViewer note={viewed} onBack={() => onView(null)} onAsk={onAsk} />;

  if (rail) {
    return (
      <aside className="lib-panel lib-sources is-rail" aria-label="Sources">
        <div className="lib-panel-head">
          <button className="icon-btn" onClick={onToggle} title="Show sources" aria-label="Show sources">
            <PanelLeftOpen size={20} />
          </button>
        </div>
        <div className="lib-rail-list">
          <button className="icon-btn" title="Add note" aria-label="Add note" onClick={() => newNote(addFolder)}>
            <Plus size={20} />
          </button>
          {list.slice(0, 12).map((n) => (
            <button key={n.meta.id} className={cx('icon-btn', !checked.has(n.meta.id) && 'is-unticked')} title={n.meta.title || 'Untitled'} onClick={onToggle}>
              <TypeIcon note={n} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  const shownIds = shown.map((n) => n.meta.id);
  const shownOn = shownIds.filter((id) => checked.has(id)).length;

  return (
    <aside className="lib-panel lib-sources" aria-label="Sources">
      <div className="lib-panel-head">
        <span className="lib-panel-title">Sources</span>
        <button className="icon-btn" onClick={onToggle} title="Hide sources" aria-label="Hide sources">
          <PanelLeftClose size={20} />
        </button>
      </div>
      <div className="src-controls">
        <button className="src-add" onClick={() => newNote(addFolder)}>
          <Plus size={18} /> Add note
        </button>
        <label className="src-filter">
          <Search size={18} />
          <input value={filter} placeholder="Filter notes or #tag" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
          {filter && (
            <button className="src-filter-clear" onClick={() => setFilter('')} aria-label="Clear filter">
              <X size={16} />
            </button>
          )}
        </label>
        {list.length > 0 && shown.length > 0 && (
          <div className="src-row src-all">
            <span className="src-all-label">{q ? `Select all ${shown.length} shown` : 'Select all notes'}</span>
            <Tick state={tri(shownOn, shownIds.length)} label="Select all notes" onChange={(on) => set(shownIds, on)} />
          </div>
        )}
      </div>
      <div className="src-list">
        {list.length === 0 && (
          <div className="src-empty">
            <FileText size={40} strokeWidth={1.5} />
            <div className="src-empty-title">Your notes will appear here</div>
            <div className="src-empty-sub">{notebook.kind === 'folder' ? 'Write a note in this class to ask about it.' : 'Write a note to ask about it.'}</div>
          </div>
        )}
        {list.length > 0 && shown.length === 0 && <div className="src-none">No notes match “{filter.trim()}”</div>}
        {groups.map((g) => {
          const ids = g.notes.map((n) => n.meta.id);
          const on = ids.filter((id) => checked.has(id)).length;
          const isClosed = !q && closed[g.key];
          return (
            <div key={g.key} className="src-group">
              {g.label && (
                <div className="src-row src-group-head" onClick={() => setClosed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
                  <ChevronDown size={16} className={cx('src-chev', isClosed && 'is-closed')} />
                  <span className="src-group-glyph" style={g.cls ? { color: g.cls.color } : undefined}>
                    {g.cls ? <ClassGlyph icon={g.cls.icon} size={18} /> : <FileText size={18} />}
                  </span>
                  <span className="src-group-name">{g.label}</span>
                  <span className="src-group-count">
                    {on}/{ids.length}
                  </span>
                  <Tick state={tri(on, ids.length)} label={`Select all ${g.label} notes`} onChange={(v) => set(ids, v)} />
                </div>
              )}
              {!isClosed &&
                g.notes.map((n) => (
                  <div
                    key={n.meta.id}
                    className={cx('src-row src-note', g.label && 'is-grouped')}
                    tabIndex={0}
                    onClick={() => set([n.meta.id], !checked.has(n.meta.id))}
                    onKeyDown={(e) => {
                      if (e.key === ' ') {
                        e.preventDefault();
                        set([n.meta.id], !checked.has(n.meta.id));
                      } else if (e.key === 'Enter') open(n);
                    }}
                  >
                    <TypeIcon note={n} />
                    <button
                      className="src-title"
                      title={n.meta.title || 'Untitled'}
                      onClick={(e) => {
                        e.stopPropagation();
                        open(n);
                      }}
                    >
                      {n.meta.title || 'Untitled'}
                    </button>
                    <Tick state={checked.has(n.meta.id) ? 'on' : 'off'} label={n.meta.title || 'Untitled'} onChange={(v) => set([n.meta.id], v)} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * NotebookLM's source view: the note, read-only, inside the Sources panel, so it can be checked
 * beside the chat. Shows what Nib reads (the assistant's own callouts left out), with the note's
 * headings as key topics to ask about.
 */
function SourceViewer({ note, onBack, onAsk }: { note: NoteDoc; onBack(): void; onAsk(q: string): void }) {
  const blocks = useMemo(() => docBlocks(note.content, { sourcesOnly: true }), [note]);
  const topics = useMemo(() => topicsOf(chunkNote(note), { [note.meta.id]: note }).slice(0, 8), [note]);
  // The student's highlighter ("==like this==" in the text) shows as a highlight.
  const html = useMemo(() => blocks.map((b) => ({ id: b.id, html: renderMarkdown(b.text).replace(/==(?=\S)([^<\n]*?\S)==/g, '<mark>$1</mark>') })), [blocks]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, .modal-backdrop')) onBack();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onBack]);
  return (
    <aside className="lib-panel lib-sources is-viewer" aria-label={`Source: ${note.meta.title || 'Untitled'}`}>
      <div className="lib-panel-head src-view-head">
        <button className="icon-btn" onClick={onBack} title="Back to sources" aria-label="Back to sources">
          <ArrowLeft size={20} />
        </button>
        <TypeIcon note={note} />
        <span className="src-view-title">{note.meta.title || 'Untitled'}</span>
        <button className="icon-btn" onClick={() => useUI.getState().openNote(note.meta.id)} title="Open in editor" aria-label="Open in editor">
          <ExternalLink size={20} />
        </button>
      </div>
      <div className="src-view-body">
        {topics.length > 0 && (
          <div className="src-view-guide">
            <div className="src-view-guide-title">Key topics</div>
            <div className="src-view-topics">
              {topics.map((t) => (
                <button key={t.topic} className="src-view-topic" title={`Ask: ${questionFor(t.topic)}`} onClick={() => onAsk(questionFor(t.topic))}>
                  {t.topic}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="md src-view-doc">
          {html.length ? html.map((b, i) => <div key={b.id || i} data-block={b.id} dangerouslySetInnerHTML={{ __html: b.html }} />) : <p className="src-view-empty">This note is empty.</p>}
        </div>
      </div>
    </aside>
  );
}
