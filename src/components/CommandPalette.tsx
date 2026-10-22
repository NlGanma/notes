import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  CornerDownLeft,
  FilePlus,
  FileText,
  FolderPlus,
  FileUp,
  Keyboard,
  LibraryBig,
  PanelLeft,
  Search,
  Settings,
  MessageCircleQuestion,
  TextSearch,
  FileDown,
  Folder,
  Cpu,
  ClipboardList,
  GraduationCap,
  Target,
  X,
} from 'lucide-react';
import { listClasses } from '../lib/classes';
import { ClassBadge } from './classes/ClassIcon';
import { useUI } from '../state/ui';
import { useVault } from '../state/vault';
import { keywordSearch } from '../state/library';
import { newClass, newFolder, newHomework, newNote, openClass, openLibrary, openReview, reviewFolder, reviewNote, toggleAssistant, currentNoteId, openVaultFolder } from '../lib/commands';
import { isReviewable } from '../lib/review/tree';
import { dueNotes } from '../state/review';
import { importFiles } from '../lib/import';
import { exportNote } from '../lib/export';
import { snippet } from '../lib/ai/rag';
import { cx, formatRelativeTime } from '../lib/util';
import { MOD, SHIFT } from '../lib/platform';

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  hint?: string;
  run(): void;
}

function fuzzyScore(text: string, q: string): number {
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  if (!query) return 1;
  const i = t.indexOf(query);
  if (i >= 0) return 100 - i + (i === 0 ? 50 : 0);
  let ti = 0;
  let score = 0;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return score;
}

function highlight(text: string, q: string) {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export function CommandPalette() {
  const open = useUI((s) => s.palette);
  if (!open) return null;
  return createPortal(<Palette />, document.body);
}

function Palette() {
  const notes = useVault((s) => s.notes);
  const folders = useVault((s) => s.folders);
  const folderMeta = useVault((s) => s.folderMeta);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useUI.getState().setPalette(false);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const live = Object.values(notes).filter((n) => !n.meta.trashed);
    const query = q.trim();
    const isCmd = query.startsWith('>');
    const term = isCmd ? query.slice(1).trim() : query;

    if (!isCmd) {
      const titled = live
        .map((n) => ({ n, s: fuzzyScore(`${n.meta.title || 'Untitled'} ${n.meta.folder}`, term) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.n.meta.updated - a.n.meta.updated)
        .slice(0, term ? 6 : 8);
      for (const { n } of titled) {
        out.push({
          id: `note:${n.meta.id}`,
          group: term ? 'Notes' : 'Recent notes',
          label: n.meta.title || 'Untitled',
          sub: [n.meta.folder.split('/').join(' › '), formatRelativeTime(n.meta.updated)].filter(Boolean).join(' · '),
          // The same Docs-blue type glyph as every other note list.
          icon: n.meta.homework ? <ClipboardList size={20} className="note-card-type" /> : <FileText size={20} className="note-card-type" />,
          run: () => useUI.getState().openNote(n.meta.id, { newTab: true }),
        });
      }
      if (term.length > 2) {
        const seen = new Set(titled.map((x) => x.n.meta.id));
        for (const h of keywordSearch(term, 8)) {
          if (seen.has(`${h.chunk.noteId}:${h.chunk.section}`)) continue;
          seen.add(`${h.chunk.noteId}:${h.chunk.section}`);
          out.push({
            id: `hit:${h.chunk.id}`,
            group: 'In your notes',
            label: snippet(h.chunk.text, term, 110),
            sub: [h.chunk.title, h.chunk.section].filter(Boolean).join(' › '),
            icon: <TextSearch size={20} />,
            run: () => useUI.getState().openNote(h.chunk.noteId, { newTab: true, blockId: h.chunk.blockIds[0] }),
          });
        }
        for (const c of listClasses(folders, folderMeta)
          .filter((c) => fuzzyScore(`${c.name} ${c.code ?? ''}`, term) > 20)
          .slice(0, 3)) {
          out.push({
            id: `class:${c.path}`,
            group: 'Classes',
            label: c.name,
            sub: [c.code, c.instructor].filter(Boolean).join(' · '),
            icon: <ClassBadge cls={c} size={24} />,
            run: () => openClass(c.path),
          });
        }
        for (const f of folders.filter((f) => folderMeta[f]?.kind !== 'class' && fuzzyScore(f, term) > 20).slice(0, 3)) {
          out.push({
            id: `folder:${f}`,
            group: 'Folders',
            label: f.split('/').pop()!,
            sub: f,
            icon: <Folder size={20} />,
            run: () => useUI.getState().setView({ kind: 'folder', path: f }),
          });
        }
        out.push({
          id: 'ask-library',
          group: 'Ask',
          label: `Ask your notes: “${term}”`,
          icon: <MessageCircleQuestion size={20} />,
          run: () => {
            openLibrary();
            setTimeout(() => window.dispatchEvent(new CustomEvent('nib:library-ask', { detail: term })), 50);
          },
        });
      }
    }

    const noteId = currentNoteId();
    const classes = listClasses(folders, folderMeta);
    const commands: Item[] = [
      { id: 'c:new', group: 'Commands', label: 'New note', icon: <FilePlus size={20} />, hint: `${MOD}N`, run: () => newNote() },
      { id: 'c:hw', group: 'Commands', label: 'New homework', icon: <ClipboardList size={20} />, run: () => newHomework() },
      { id: 'c:class', group: 'Commands', label: 'New class', icon: <GraduationCap size={20} />, run: () => newClass() },
      {
        id: 'c:hwlist',
        group: 'Commands',
        label: 'Go to Homework',
        icon: <ClipboardList size={20} />,
        run: () => useUI.getState().setView({ kind: 'homework' }),
      },
      // Before the per-class commands: searching "review" keeps only the first few matches.
      { id: 'c:review', group: 'Commands', label: 'Review…', sub: 'Pick any notes, mix classes', icon: <Target size={20} />, hint: `${SHIFT}${MOD}E`, run: () => openReview() },
      {
        id: 'c:review-due',
        group: 'Commands',
        label: 'Review what’s due',
        icon: <Target size={20} />,
        run: () => openReview(dueNotes().ids),
      },
      ...(noteId && notes[noteId] && isReviewable(notes[noteId])
        ? [{ id: 'c:review-note', group: 'Commands', label: 'Review this note', icon: <Target size={20} />, run: () => reviewNote(noteId) }]
        : []),
      ...classes.flatMap((c) => [
        {
          id: `c:note:${c.path}`,
          group: 'Commands',
          label: `New ${c.name} note`,
          icon: <ClassBadge cls={c} size={24} />,
          run: () => newNote(c.path),
        },
        {
          id: `c:hw:${c.path}`,
          group: 'Commands',
          label: `New ${c.name} homework`,
          icon: <ClassBadge cls={c} size={24} />,
          run: () => newHomework(c.path),
        },
        {
          id: `c:ask:${c.path}`,
          group: 'Commands',
          label: `Ask ${c.name}`,
          sub: 'Answers only from this class’s notes',
          icon: <ClassBadge cls={c} size={24} />,
          run: () => openLibrary({ kind: 'folder', path: c.path }),
        },
        {
          id: `c:review:${c.path}`,
          group: 'Commands',
          label: `Review ${c.name}`,
          sub: 'Practise until you know it — from this class’s notes',
          icon: <ClassBadge cls={c} size={24} />,
          run: () => reviewFolder(c.path),
        },
      ]),
      { id: 'c:folder', group: 'Commands', label: 'New folder', icon: <FolderPlus size={20} />, run: () => void newFolder() },
      { id: 'c:lib', group: 'Commands', label: 'Ask your notes', icon: <LibraryBig size={20} />, hint: `${SHIFT}${MOD}L`, run: () => openLibrary() },
      { id: 'c:assistant', group: 'Commands', label: 'Toggle assistant', icon: <MessageCircleQuestion size={20} />, hint: `${MOD}J`, run: () => toggleAssistant() },
      { id: 'c:import', group: 'Commands', label: 'Import PDF, Markdown or images…', icon: <FileUp size={20} />, run: () => void importFiles() },
      ...(noteId
        ? [
            {
              id: 'c:pdf',
              group: 'Commands',
              label: 'Export note as PDF',
              icon: <FileDown size={20} />,
              hint: `${MOD}P`,
              run: () => void exportNote(noteId, 'pdf'),
            },
          ]
        : []),
      {
        id: 'c:sidebar',
        group: 'Commands',
        label: 'Toggle sidebar',
        icon: <PanelLeft size={20} />,
        hint: `${MOD}\\`,
        run: () => useUI.getState().toggleSidebar(),
      },
      { id: 'c:ai', group: 'Commands', label: 'AI settings — connect a local model', icon: <Cpu size={20} />, run: () => useUI.getState().openSettings('ai') },
      {
        id: 'c:settings',
        group: 'Commands',
        label: 'Settings',
        icon: <Settings size={20} />,
        hint: `${MOD},`,
        run: () => useUI.getState().openSettings('writing'),
      },
      {
        id: 'c:keys',
        group: 'Commands',
        label: 'Keyboard shortcuts',
        icon: <Keyboard size={20} />,
        hint: `${MOD}/`,
        run: () => useUI.getState().openSettings('shortcuts'),
      },
      { id: 'c:vault', group: 'Commands', label: 'Open another vault folder…', icon: <Folder size={20} />, run: () => void openVaultFolder() },
    ];
    // Per-class commands only show up when searched for, so the default list stays short.
    const cmdMatches = commands.filter((c) => (term ? fuzzyScore(c.label, term) > (isCmd ? 0 : 30) : !c.id.split(':')[2]));
    out.push(...(isCmd || !term ? cmdMatches : cmdMatches.slice(0, 4)));
    return out;
  }, [q, notes, folders, folderMeta]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Quick open">
        <div className="palette-input">
          <Search size={24} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search notes, or type > for commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          <button className="icon-btn" onClick={close} aria-label="Close search">
            <X size={24} />
          </button>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No matches. Press ↵ to create “{q}”.</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="palette-group">{header}</div>}
                <button className={cx('palette-item', i === index && 'is-active')} onMouseMove={() => setIndex(i)} onClick={() => run(it)}>
                  <span className="palette-icon">{it.icon}</span>
                  <span className="palette-text">
                    <span className="palette-label">{it.group === 'In your notes' ? highlight(it.label, q) : it.label}</span>
                    {it.sub && <span className="palette-sub">{it.sub}</span>}
                  </span>
                  {it.hint ? (
                    <kbd>{it.hint}</kbd>
                  ) : i === index ? (
                    <CornerDownLeft size={18} className="palette-enter" />
                  ) : (
                    <ArrowRight size={18} className="palette-arrow" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
