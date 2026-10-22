import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, FileText, Folder, Search, X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Tabs } from '../common/Tabs';
import { NibMark } from '../TopBar';
import { useVault } from '../../state/vault';
import { classForFolder, classInfo, inFolder } from '../../lib/classes';
import { inHomeworkFolder, suggestSources } from '../../lib/homework';
import type { NoteDoc } from '../../lib/vault/types';
import { cx, plural } from '../../lib/util';
import { editedLabel, folderName, sameSelection, summarize, type SourceSelection } from './sources';

export type PickerTab = 'suggested' | 'class' | 'all' | 'recent' | 'favorites';

type Row = { kind: 'folder'; path: string; count: number; newest: number } | { kind: 'note'; note: NoteDoc; why?: string };

const noteTitle = (n: NoteDoc) => n.meta.title || 'Untitled';
const isUnder = (path: string, f: string) => path.startsWith(f + '/');

const EMPTY: Record<PickerTab, string> = {
  suggested: 'No suggestions yet. Try This class or All notes.',
  class: 'No notes in this class yet',
  all: 'No notes yet',
  recent: 'No recent notes',
  favorites: 'No favorite notes',
};

/** Matching text in the 500 weight, as Drive's search results show it. */
function Hit({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="link-hit">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Picks the notes a homework's answers may come from, as the Google Drive
 * picker does inside Classroom: title, search and close in the header, tabs
 * for where to look, a Name / Class / Last edited list with a checkbox on
 * hover, and Insert + Cancel in the footer. A whole class or unit can be
 * linked as a folder (new notes in it count too), or opened to pick from it.
 */
export function NotePicker({
  open,
  title,
  classPath,
  excludeId,
  initial,
  query,
  initialTab,
  onInsert,
  onClose,
}: {
  open: boolean;
  title: string;
  /** The homework's class: the "This class" tab and the suggestion boost. */
  classPath: string | null;
  /** The homework itself, never offered as its own source. */
  excludeId?: string;
  initial: SourceSelection;
  /** The homework (or the draft of a new one) that suggestions are matched against. */
  query: NoteDoc | null;
  initialTab?: PickerTab;
  onInsert(sel: SourceSelection): void;
  onClose(): void;
}) {
  const notes = useVault((s) => s.notes);
  const folderMeta = useVault((s) => s.folderMeta);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<PickerTab>('suggested');
  const [path, setPath] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(
    () => Object.values(notes).filter((n) => !n.meta.trashed && !n.meta.homework && n.meta.id !== excludeId && !inHomeworkFolder(n)),
    [notes, excludeId],
  );
  const suggestions = useMemo(() => (open && query ? suggestSources(query, notes, 8, classPath) : []), [open, query, notes, classPath]);

  useEffect(() => {
    if (!open) return;
    setSources(new Set(initial.sources));
    setFolders(new Set(initial.folders));
    const t = initialTab ?? (suggestions.length ? 'suggested' : classPath ? 'class' : 'all');
    setTab(t);
    setPath(t === 'class' && classPath ? classPath : '');
    setQ('');
    setActive(0);
    // The list takes focus (not the search, which Drive leaves quiet until you type).
    requestAnimationFrame(() => listRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clsOf = (folder: string) => {
    const p = classForFolder(folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]) : null;
  };

  // The folders and notes directly inside `dir` ('' = the top level).
  const browse = (dir: string): Row[] => {
    const subs = new Map<string, { count: number; newest: number }>();
    const here: NoteDoc[] = [];
    for (const n of candidates) {
      if (dir && !inFolder(n, dir)) continue;
      if (n.meta.folder === dir) {
        here.push(n);
        continue;
      }
      const rel = dir ? n.meta.folder.slice(dir.length + 1) : n.meta.folder;
      const child = dir ? `${dir}/${rel.split('/')[0]}` : rel.split('/')[0];
      const s = subs.get(child) ?? { count: 0, newest: 0 };
      s.count++;
      s.newest = Math.max(s.newest, n.meta.updated);
      subs.set(child, s);
    }
    const isClass = (p: string) => folderMeta[p]?.kind === 'class';
    const folderRows: Row[] = [...subs.entries()]
      .sort(
        ([a], [b]) =>
          Number(isClass(b)) - Number(isClass(a)) || folderName(a, folderMeta).localeCompare(folderName(b, folderMeta), undefined, { numeric: true }),
      )
      .map(([p, s]) => ({ kind: 'folder', path: p, ...s }));
    const noteRows: Row[] = here.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), undefined, { numeric: true })).map((n) => ({ kind: 'note', note: n }));
    return [...folderRows, ...noteRows];
  };

  const root = tab === 'class' && classPath ? classPath : '';
  const ql = q.trim().toLowerCase();
  const rows: Row[] = useMemo(() => {
    if (!open) return [];
    const match = (n: NoteDoc) => !ql || noteTitle(n).toLowerCase().includes(ql);
    if (tab === 'suggested')
      return suggestions
        .filter((s) => match(s.note))
        .map((s) => ({ kind: 'note', note: s.note, why: s.terms.length ? `matches ${s.terms.join(', ')}` : undefined }));
    if (tab === 'recent')
      return candidates
        .filter(match)
        .sort((a, b) => b.meta.updated - a.meta.updated)
        .slice(0, 50)
        .map((n) => ({ kind: 'note', note: n }));
    if (tab === 'favorites')
      return candidates
        .filter((n) => n.meta.pinned && match(n))
        .sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)))
        .map((n) => ({ kind: 'note', note: n }));
    if (!ql) return browse(path);
    // Searching a folder tab looks through everything under it, folders and notes alike.
    const under = candidates.filter((n) => !root || inFolder(n, root));
    const dirs = new Map<string, { count: number; newest: number }>();
    for (const n of under) {
      const parts = n.meta.folder.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!p || p === root || (root && !isUnder(p, root))) continue;
        const s = dirs.get(p) ?? { count: 0, newest: 0 };
        s.count++;
        s.newest = Math.max(s.newest, n.meta.updated);
        dirs.set(p, s);
      }
    }
    return [
      ...[...dirs.entries()].filter(([p]) => folderName(p, folderMeta).toLowerCase().includes(ql)).map(([p, s]): Row => ({ kind: 'folder', path: p, ...s })),
      ...under.filter(match).map((n): Row => ({ kind: 'note', note: n })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, path, ql, candidates, suggestions, folderMeta, root]);

  if (!open) return null;

  const linkedFolderOf = (n: NoteDoc) => [...folders].find((f) => inFolder(n, f));
  const stateOf = (r: Row): { on: boolean; via?: string } => {
    if (r.kind === 'note') {
      const via = linkedFolderOf(r.note);
      return via ? { on: true, via } : { on: sources.has(r.note.meta.id) };
    }
    if (folders.has(r.path)) return { on: true };
    const via = [...folders].find((f) => isUnder(r.path, f));
    return via ? { on: true, via } : { on: false };
  };

  const toggle = (r: Row) => {
    const s = new Set(sources);
    const fs = new Set(folders);
    if (r.kind === 'note') {
      const via = linkedFolderOf(r.note);
      if (via) {
        // Unlinking one note from a linked folder keeps the rest of it, as single notes.
        fs.delete(via);
        for (const o of candidates) if (inFolder(o, via) && o.meta.id !== r.note.meta.id) s.add(o.meta.id);
      } else if (s.has(r.note.meta.id)) s.delete(r.note.meta.id);
      else s.add(r.note.meta.id);
    } else if (fs.has(r.path)) fs.delete(r.path);
    else {
      const via = [...fs].find((f) => isUnder(r.path, f));
      if (via) {
        fs.delete(via);
        for (const o of candidates) if (inFolder(o, via) && !inFolder(o, r.path)) s.add(o.meta.id);
      } else {
        // A whole folder replaces anything already picked inside it.
        fs.add(r.path);
        for (const f of [...fs]) if (isUnder(f, r.path)) fs.delete(f);
        for (const id of [...s]) if (notes[id] && inFolder(notes[id], r.path)) s.delete(id);
      }
    }
    setSources(s);
    setFolders(fs);
  };

  const sel: SourceSelection = { sources: [...sources], folders: [...folders] };
  const changed = !sameSelection(sel, initial);
  const insert = () => changed && onInsert(sel);
  const loose = sel.sources.filter((id) => notes[id] && !notes[id].meta.trashed && !sel.folders.some((f) => inFolder(notes[id], f)));
  const count = sel.folders.length ? summarize(sel, notes, folderMeta) : loose.length ? `${plural(loose.length, 'note')} selected` : 'No notes selected';

  const openFolder = (p: string) => {
    setPath(p);
    setQ('');
    setActive(0);
    if (tab !== 'class' && tab !== 'all') setTab('all');
  };
  const crumbs = path && path !== root ? path.slice(root ? root.length + 1 : 0).split('/') : [];

  const focusRow = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActive(n);
    (listRef.current?.querySelector(`[data-row="${n}"]`) as HTMLElement | null)?.focus();
  };

  const tabs: { id: PickerTab; label: string }[] = [
    { id: 'suggested', label: 'Suggested' },
    ...(classPath ? [{ id: 'class' as const, label: 'This class' }] : []),
    { id: 'all', label: 'All notes' },
    { id: 'recent', label: 'Recent' },
    { id: 'favorites', label: 'Favorites' },
  ];

  return (
    <Modal open onClose={onClose} width={1052} bare className="link-dialog">
      <div
        className="link-frame"
        onKeyDown={(e) => {
          // Typing anywhere starts a search, as in Drive.
          const t = e.target as HTMLElement;
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ' && t.tagName !== 'INPUT') searchRef.current?.focus();
        }}
      >
        <div className="link-head">
          <NibMark size={24} />
          <div className="link-head-title" title={title}>
            {title}
          </div>
          <label className="link-search">
            <Search size={24} />
            <input
              ref={searchRef}
              placeholder="Search notes"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  focusRow(0);
                } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) insert();
              }}
            />
            {q && (
              <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search">
                <X size={20} />
              </button>
            )}
          </label>
          <span className="grow" />
          <button className="icon-btn link-close" onClick={onClose} aria-label="Close">
            <X size={24} />
          </button>
        </div>
        <Tabs
          className="link-tabs"
          items={tabs}
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPath(t === 'class' && classPath ? classPath : '');
            setActive(0);
          }}
        />
        {crumbs.length > 0 && (
          <div className="link-crumbs">
            <button onClick={() => openFolder(root)}>{tab === 'class' && classPath ? folderName(classPath, folderMeta) : 'All notes'}</button>
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                <ChevronRight size={18} />
                <button onClick={() => openFolder([root, ...crumbs.slice(0, i + 1)].filter(Boolean).join('/'))} disabled={i === crumbs.length - 1}>
                  {i === 0 && !root ? folderName(crumbs[0], folderMeta) : c}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        <div className="link-cols" aria-hidden>
          <span className="link-lead" />
          <span className="link-name">Name</span>
          <span className="link-class">Class</span>
          <span className="link-date">Last edited</span>
          <span className="link-open" />
        </div>
        <div
          ref={listRef}
          className="link-list"
          role="listbox"
          aria-multiselectable
          aria-label="Notes"
          tabIndex={-1}
          onKeyDown={(e) => {
            const r = rows[active];
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              // From the list itself (as it opens), the first key lands on the current row.
              focusRow(e.target === e.currentTarget ? active : active + (e.key === 'ArrowDown' ? 1 : -1));
            } else if (e.key === ' ' && r) {
              e.preventDefault();
              toggle(r);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              insert();
            } else if (e.key === 'ArrowRight' && r?.kind === 'folder') openFolder(r.path);
            else if (e.key === 'ArrowLeft' && crumbs.length) openFolder(path.split('/').slice(0, -1).join('/') || root);
            else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const s = new Set(sources);
              for (const row of rows) if (row.kind === 'note' && !linkedFolderOf(row.note)) s.add(row.note.meta.id);
              setSources(s);
            }
          }}
        >
          {rows.length === 0 && <div className="link-empty">{ql ? `No notes match “${q.trim()}”` : EMPTY[tab]}</div>}
          {rows.map((r, i) => {
            const st = stateOf(r);
            const cls = clsOf(r.kind === 'note' ? r.note.meta.folder : r.path);
            const name = r.kind === 'note' ? noteTitle(r.note) : folderName(r.path, folderMeta);
            return (
              <div
                key={r.kind === 'note' ? r.note.meta.id : `f:${r.path}`}
                data-row={i}
                role="option"
                aria-selected={st.on}
                tabIndex={i === active ? 0 : -1}
                className={cx('link-row', r.kind === 'folder' && 'is-folder', st.on && 'is-on', !!st.via && 'is-included')}
                title={st.via ? `Included with ${folderName(st.via, folderMeta)}` : undefined}
                onClick={() => {
                  setActive(i);
                  toggle(r);
                }}
                onDoubleClick={() => r.kind === 'folder' && openFolder(r.path)}
              >
                <span className="link-lead">
                  <span className="link-glyph" style={r.kind === 'note' && cls ? { color: cls.theme.main } : undefined}>
                    {r.kind === 'folder' ? <Folder size={20} /> : <FileText size={20} />}
                  </span>
                  <span className="link-box">{st.on && <Check size={14} strokeWidth={3} />}</span>
                </span>
                <span className="link-name">
                  <span className="link-title">
                    <Hit text={name} q={q.trim()} />
                  </span>
                  {r.kind === 'note' && r.why && <span className="link-why">{r.why}</span>}
                  {r.kind === 'folder' && <span className="link-why">{plural(r.count, 'note')}</span>}
                </span>
                <span className="link-class">{cls?.name ?? '—'}</span>
                <span className="link-date">{editedLabel(r.kind === 'folder' ? r.newest : r.note.meta.updated)}</span>
                <span className="link-open">
                  {r.kind === 'folder' && (
                    <button
                      className="icon-btn"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFolder(r.path);
                      }}
                      aria-label={`Open ${name}`}
                      title="Open"
                    >
                      <ChevronRight size={20} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="link-foot">
          <button className="btn is-primary" onClick={insert} disabled={!changed}>
            Insert
          </button>
          <button className="btn is-ghost" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <span className="link-count">{count}</span>
        </div>
      </div>
    </Modal>
  );
}
