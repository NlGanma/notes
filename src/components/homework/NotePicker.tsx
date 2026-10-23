import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Folder, Search, X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { useVault } from '../../state/vault';
import { classForFolder, classInfo, inFolder } from '../../lib/classes';
import { inHomeworkFolder, suggestSources } from '../../lib/homework';
import { displayTitle } from '../../lib/displayTitle';
import { normalizePaper } from '../../lib/paper';
import type { NoteDoc } from '../../lib/vault/types';
import { cx, plural } from '../../lib/util';
import { PaperThumb } from '../PaperPicker';
import { editedLabel, folderName, summarize, type SourceSelection } from './sources';

export type PickerTab = 'suggested' | 'class' | 'all';

type Row = { kind: 'folder'; path: string; count: number; newest: number } | { kind: 'note'; note: NoteDoc; why?: string };

const isUnder = (path: string, f: string) => path.startsWith(f + '/');
const byName = (a: NoteDoc, b: NoteDoc) => displayTitle(a).localeCompare(displayTitle(b), undefined, { numeric: true });

const EMPTY: Record<PickerTab, string> = {
  suggested: 'No suggestions yet',
  class: 'No notes in this class yet',
  all: 'No notes yet',
};

/** The search words in a name, in the 500 weight. */
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
 * Choose notes: which notes a homework's answers may come from. Suggested (the notes that match the
 * homework), This class, or All, with a search. A whole class or folder can be picked as one item, and
 * then its new notes count too; it can also be opened to pick from inside it.
 */
export function NotePicker({
  open,
  title = 'Choose notes',
  classPath,
  excludeId,
  initial,
  query,
  initialTab,
  onInsert,
  onClose,
}: {
  open: boolean;
  title?: string;
  /** The homework's class: the "This class" tab and the suggestions' boost. */
  classPath: string | null;
  /** The homework itself, never offered as its own source. */
  excludeId?: string;
  initial: SourceSelection;
  /** The homework (or the draft of a new one) that suggestions are matched against. */
  query: NoteDoc | null;
  /** Where to start; by default Suggested when there are suggestions, else This class, else All. */
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
    const t: PickerTab = initialTab ?? (suggestions.length ? 'suggested' : classPath ? 'class' : 'all');
    setTab(t);
    setPath(t === 'class' && classPath ? classPath : '');
    setQ('');
    setActive(0);
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clsOf = (folder: string) => {
    const p = classForFolder(folder, folderMeta);
    return p ? classInfo(p, folderMeta[p]) : null;
  };

  // The folders and notes directly inside `dir` ('' = the top level): classes first, then folders, then notes.
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
      .sort(([a], [b]) => Number(isClass(b)) - Number(isClass(a)) || folderName(a, folderMeta).localeCompare(folderName(b, folderMeta), undefined, { numeric: true }))
      .map(([p, s]) => ({ kind: 'folder', path: p, ...s }));
    return [...folderRows, ...here.sort(byName).map((n): Row => ({ kind: 'note', note: n }))];
  };

  const root = tab === 'class' && classPath ? classPath : '';
  const ql = q.trim().toLowerCase();
  const rows: Row[] = useMemo(() => {
    if (!open) return [];
    const match = (n: NoteDoc) => !ql || displayTitle(n).toLowerCase().includes(ql);
    if (tab === 'suggested')
      return suggestions.filter((s) => match(s.note)).map((s) => ({ kind: 'note', note: s.note, why: s.terms.length ? `Matches ${s.terms.join(', ')}` : undefined }));
    if (!ql) {
      const list = browse(path);
      // At the top of This class, the class itself: picking it means all its notes, new ones too.
      if (tab === 'class' && classPath && path === classPath) {
        const own = candidates.filter((n) => inFolder(n, classPath));
        list.unshift({ kind: 'folder', path: classPath, count: own.length, newest: Math.max(0, ...own.map((n) => n.meta.updated)) });
      }
      return list;
    }
    // A search looks through everything under the tab, folders and notes alike.
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
        // Leaving one note out of a picked folder keeps the rest of it, as single notes.
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
  const done = () => onInsert(sel);
  const loose = sel.sources.filter((id) => notes[id] && !notes[id].meta.trashed && !sel.folders.some((f) => inFolder(notes[id], f)));
  const count = sel.folders.length ? summarize(sel, notes, folderMeta) : loose.length ? `${plural(loose.length, 'note')} chosen` : 'No notes chosen';

  const openFolder = (p: string) => {
    setPath(p);
    setQ('');
    setActive(0);
    if (tab === 'suggested') setTab('all');
  };
  // Inside a folder: a link back up to its parent (never above the tab's own top).
  const canGoUp = !!path && path !== root;
  const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const upTo = root && !parent.startsWith(root) ? root : parent;

  const focusRow = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActive(n);
    (listRef.current?.querySelector(`[data-row="${n}"]`) as HTMLElement | null)?.focus();
  };

  const tabs: { id: PickerTab; label: string }[] = [
    ...(suggestions.length ? [{ id: 'suggested' as const, label: 'Suggested' }] : []),
    ...(classPath ? [{ id: 'class' as const, label: 'This class' }] : []),
    { id: 'all', label: 'All' },
  ];

  return (
    <Modal open onClose={onClose} width={560} bare className="link-dialog">
      <div className="link-frame">
        <div className="link-head">
          <h2 className="dialog-title" title={title}>
            {title}
          </h2>
          <label className="link-search">
            <Search size={16} strokeWidth={1.5} />
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
                } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) done();
                else if (e.key === 'Escape') onClose();
              }}
            />
            {q && (
              <button className="icon-btn is-tiny" onClick={() => setQ('')} aria-label="Clear search">
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
          </label>
          {tabs.length > 1 && (
            <div className="seg link-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={cx(tab === t.id && 'is-active')}
                  onClick={() => {
                    setTab(t.id);
                    setPath(t.id === 'class' && classPath ? classPath : '');
                    setActive(0);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {canGoUp && !ql && (
          <button className="list-back link-up" onClick={() => openFolder(upTo)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            {upTo ? folderName(upTo, folderMeta) : 'All'}
            <span className="link-up-here">› {folderName(path, folderMeta)}</span>
          </button>
        )}
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
              focusRow(e.target === e.currentTarget ? active : active + (e.key === 'ArrowDown' ? 1 : -1));
            } else if (e.key === ' ' && r) {
              e.preventDefault();
              toggle(r);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              done();
            } else if (e.key === 'ArrowRight' && r?.kind === 'folder' && r.path !== path) openFolder(r.path);
            else if (e.key === 'ArrowLeft' && canGoUp) openFolder(upTo);
          }}
        >
          {rows.length === 0 && <div className="link-empty">{ql ? `No notes match “${q.trim()}”` : EMPTY[tab]}</div>}
          {rows.map((r, i) => {
            const st = stateOf(r);
            const cls = clsOf(r.kind === 'note' ? r.note.meta.folder : r.path);
            const name = r.kind === 'note' ? displayTitle(r.note) : folderMeta[r.path]?.kind === 'class' ? `All ${folderName(r.path, folderMeta)} notes` : folderName(r.path, folderMeta);
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
                onDoubleClick={() => r.kind === 'folder' && r.path !== path && openFolder(r.path)}
              >
                <span className="link-box" aria-hidden>
                  {st.on && <Check size={12} strokeWidth={3} />}
                </span>
                {r.kind === 'folder' ? (
                  <Folder size={18} strokeWidth={1.5} className="link-folder" style={cls ? { color: cls.color } : undefined} />
                ) : (
                  <PaperThumb paper={normalizePaper(r.note.meta.paper)} className="note-row-paper link-paper" />
                )}
                <span className="link-text">
                  <span className="link-title">
                    <Hit text={name} q={q.trim()} />
                  </span>
                  <span className="link-sub">
                    {r.kind === 'note' ? (
                      <>
                        {cls && (
                          <span className="link-class" title={cls.name}>
                            <span className="class-square" style={{ background: cls.color }} />
                            <span className="link-class-name">{cls.name}</span>
                          </span>
                        )}
                        <span>{editedLabel(r.note.meta.updated)}</span>
                        {r.why && <span className="link-why">{r.why}</span>}
                      </>
                    ) : (
                      <span>{plural(r.count, 'note')}, and new ones</span>
                    )}
                  </span>
                </span>
                {r.kind === 'folder' && r.path !== path && (
                  <button
                    className="icon-btn is-tiny link-open"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      openFolder(r.path);
                    }}
                    aria-label={`Open ${name}`}
                    title="Open"
                  >
                    <ChevronRight size={16} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          <span className="link-count">{count}</span>
          <span className="grow" />
          <button className="btn is-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn is-primary" onClick={done}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
