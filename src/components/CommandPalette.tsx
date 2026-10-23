import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  FileDown,
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  GraduationCap,
  Keyboard,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  PanelLeft,
  PanelRight,
  Repeat,
  Search,
  Settings,
  TextSearch,
  Trash2,
} from 'lucide-react';
import { listClasses } from '../lib/classes';
import { useUI, goBack, goForward, type View } from '../state/ui';
import { useVault } from '../state/vault';
import { keywordSearch } from '../state/library';
import { newClass, newHomework, newNote, openClass, openLibrary, openReview, reviewNote, toggleAssistant, currentNoteId, openVaultFolder } from '../lib/commands';
import { isReviewable } from '../lib/review/tree';
import { dueNotes } from '../state/review';
import { importFiles } from '../lib/import';
import { exportNote } from '../lib/export';
import { snippet } from '../lib/ai/rag';
import { displayTitle } from '../lib/displayTitle';
import { cx, formatRelativeTime } from '../lib/util';
import { bridge, MOD, SHIFT } from '../lib/platform';

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  hint?: string;
  /** Shown before anything is typed. */
  always?: boolean;
  hit?: boolean;
  run(newTab: boolean): void;
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

const ICON = { size: 16, strokeWidth: 1.5 };

export function CommandPalette() {
  const open = useUI((s) => s.palette);
  if (!open) return null;
  return createPortal(<Palette />, document.body);
}

/** ⌘K: find a note, a class or a folder by name, search inside notes, or run one of a few commands. */
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
    const term = q.trim();
    const goNote = (id: string, blockId?: string) => (newTab: boolean) => useUI.getState().openNote(id, { newTab, blockId });
    const where = (folder: string) => folder.split('/').join(' › ');

    const titled = live
      .map((n) => ({ n, s: fuzzyScore(`${displayTitle(n)} ${n.meta.folder}`, term) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.n.meta.updated - a.n.meta.updated)
      .slice(0, 6);
    for (const { n } of titled) {
      out.push({
        id: `note:${n.meta.id}`,
        group: term ? 'Notes' : 'Recent notes',
        label: displayTitle(n),
        sub: [where(n.meta.folder), formatRelativeTime(n.meta.updated)].filter(Boolean).join(' · '),
        icon: n.meta.homework ? <ClipboardList {...ICON} /> : <FileText {...ICON} />,
        run: goNote(n.meta.id),
      });
    }

    if (term.length > 2) {
      const seen = new Set(titled.map((x) => x.n.meta.id));
      for (const h of keywordSearch(term, 8)) {
        const key = `${h.chunk.noteId}:${h.chunk.section}`;
        if (seen.has(key) || !notes[h.chunk.noteId]) continue;
        seen.add(key);
        out.push({
          id: `hit:${h.chunk.id}`,
          group: 'In your notes',
          label: snippet(h.chunk.text, term, 110),
          sub: [displayTitle(notes[h.chunk.noteId]), h.chunk.section].filter(Boolean).join(' › '),
          icon: <TextSearch {...ICON} />,
          hit: true,
          run: goNote(h.chunk.noteId, h.chunk.blockIds[0]),
        });
      }
    }

    if (term) {
      // A class or a folder by its name: typing "bio" finds Biology itself.
      for (const c of listClasses(folders, folderMeta)
        .filter((c) => fuzzyScore(c.name, term) > 20)
        .slice(0, 3)) {
        out.push({
          id: `class:${c.path}`,
          group: 'Classes',
          label: c.name,
          icon: <span className="class-square is-palette" style={{ background: c.color }} />,
          run: () => openClass(c.path),
        });
      }
      for (const f of folders.filter((f) => folderMeta[f]?.kind !== 'class' && fuzzyScore(f.split('/').pop()!, term) > 20).slice(0, 3)) {
        out.push({
          id: `folder:${f}`,
          group: 'Folders',
          label: f.split('/').pop()!,
          sub: f.includes('/') ? where(f) : undefined,
          icon: <Folder {...ICON} />,
          run: () => useUI.getState().setView({ kind: 'folder', path: f }),
        });
      }
    }

    const noteId = currentNoteId();
    const go = (label: string, icon: React.ReactNode, view: View): Item => ({
      id: `go:${label}`,
      group: 'Go to',
      label,
      icon,
      always: true,
      run: () => useUI.getState().setView(view),
    });
    const commands: Item[] = [
      { id: 'c:new', group: 'Commands', label: 'New note', icon: <FilePlus {...ICON} />, hint: `${MOD}N`, always: true, run: () => newNote() },
      { id: 'c:hw', group: 'Commands', label: 'New homework', icon: <ClipboardList {...ICON} />, hint: `${SHIFT}${MOD}Y`, always: true, run: () => newHomework() },
      { id: 'c:class', group: 'Commands', label: 'New class', icon: <GraduationCap {...ICON} />, always: true, run: () => newClass() },
      { id: 'c:lib', group: 'Commands', label: 'Ask your notes', icon: <MessagesSquare {...ICON} />, hint: `${SHIFT}${MOD}L`, always: true, run: () => openLibrary({ kind: 'all' }) },
      { id: 'c:review-due', group: 'Commands', label: 'Review what’s due', icon: <Repeat {...ICON} />, hint: `${SHIFT}${MOD}E`, always: true, run: () => openReview(dueNotes().ids) },
      { id: 'c:import', group: 'Commands', label: 'Import…', sub: 'PDF, Markdown or images', icon: <FileUp {...ICON} />, always: true, run: () => void importFiles() },
      { id: 'c:settings', group: 'Commands', label: 'Settings', icon: <Settings {...ICON} />, hint: `${MOD},`, always: true, run: () => useUI.getState().openSettings() },
      { id: 'c:sidebar', group: 'Commands', label: 'Toggle sidebar', icon: <PanelLeft {...ICON} />, hint: `${MOD}\\`, always: true, run: () => useUI.getState().toggleSidebar() },
      // Found by typing only, so the list stays short.
      ...(noteId && notes[noteId] && isReviewable(notes[noteId]) ? [{ id: 'c:review-note', group: 'Commands', label: 'Review this note', icon: <Repeat {...ICON} />, run: () => reviewNote(noteId) }] : []),
      ...(noteId
        ? [
            { id: 'c:assistant', group: 'Commands', label: 'Toggle assistant', icon: <PanelRight {...ICON} />, hint: `${MOD}J`, run: () => toggleAssistant() },
            { id: 'c:pdf', group: 'Commands', label: 'Export note as PDF', icon: <FileDown {...ICON} />, hint: `${MOD}P`, run: () => void exportNote(noteId, 'pdf') },
          ]
        : []),
      { id: 'c:back', group: 'Commands', label: 'Go back', icon: <ArrowLeft {...ICON} />, hint: `${MOD}[`, run: () => goBack() },
      { id: 'c:forward', group: 'Commands', label: 'Go forward', icon: <ArrowRight {...ICON} />, hint: `${MOD}]`, run: () => goForward() },
      { id: 'c:keys', group: 'Commands', label: 'Keyboard shortcuts', icon: <Keyboard {...ICON} />, hint: `${MOD}/`, run: () => useUI.getState().openSettings('shortcuts') },
      ...(bridge ? [{ id: 'c:vault', group: 'Commands', label: 'Open another vault folder…', icon: <FolderOpen {...ICON} />, run: () => void openVaultFolder() }] : []),
      go('Classes', <LayoutGrid {...ICON} />, { kind: 'classes' }),
      go('Homework', <ListChecks {...ICON} />, { kind: 'homework' }),
      go('All notes', <FileText {...ICON} />, { kind: 'home' }),
      go('Trash', <Trash2 {...ICON} />, { kind: 'trash' }),
    ];
    const matches = term ? commands.filter((c) => fuzzyScore(`${c.group === 'Go to' ? 'go to ' : ''}${c.label}`, term) > 30).slice(0, 5) : commands.filter((c) => c.always);
    out.push(...matches);

    if (term.length > 2 && live.length) {
      out.push({
        id: 'ask-library',
        group: 'Ask',
        label: `Ask your notes: “${term}”`,
        icon: <MessagesSquare {...ICON} />,
        run: () => {
          openLibrary({ kind: 'all' });
          setTimeout(() => window.dispatchEvent(new CustomEvent('nib:library-ask', { detail: term })), 50);
        },
      });
    }
    return out;
  }, [q, notes, folders, folderMeta]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (it: Item | undefined, newTab = false) => {
    if (!it) return;
    close();
    it.run(newTab);
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-input">
          <Search size={18} strokeWidth={1.5} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search notes and commands"
            aria-label="Search notes and commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[index], e.metaKey || e.ctrlKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No matches</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={cx('palette-item', i === index && 'is-active', it.hit && 'is-hit')}
                  onMouseMove={() => setIndex(i)}
                  onClick={(e) => run(it, e.metaKey || e.ctrlKey)}
                  title={it.label}
                >
                  <span className="palette-icon">{it.icon}</span>
                  <span className="palette-text">
                    <span className="palette-label">{it.hit ? highlight(it.label, q) : it.label}</span>
                    {it.sub && <span className="palette-sub">{it.sub}</span>}
                  </span>
                  {it.hint && <kbd>{it.hint}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
