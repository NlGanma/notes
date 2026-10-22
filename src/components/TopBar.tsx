import { useRef, useState } from 'react';
import {
  ClipboardList,
  Code2,
  Download,
  FileDown,
  FileJson,
  FilePlus,
  FileText,
  FileType2,
  FileUp,
  FolderPlus,
  GraduationCap,
  ListChecks,
  Menu,
  MessageCircleQuestion,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useUI } from '../state/ui';
import { useVault } from '../state/vault';
import { useAI } from '../state/ai';
import { newClass, newFolder, newHomework, newNote, toggleAssistant } from '../lib/commands';
import { exportNote } from '../lib/export';
import { importFiles } from '../lib/import';
import { Popover } from './common/Popover';
import { PolishPanel, usePolishCount } from './PolishPanel';
import { noteMenu, noteTitle } from './FileTree';
import { openContextMenu } from './common/ContextMenu';
import { cx } from '../lib/util';
import { isElectron, isMac, MOD, SHIFT } from '../lib/platform';

/** The Nib mark: a nib on the app's blue, like a product logo in a Google app bar. */
export function NibMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#0b57d0" />
      <path d="M11 22.5c2.4-5.6 4.2-9.6 5.2-12.2.4-1 1.7-1 2 .1l.3 1.2c.3 1.2 1.1 2.4 2.3 3.1" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22.4" cy="9.6" r="1.9" fill="#fbbc04" />
    </svg>
  );
}

/**
 * The app bar (Google Classroom's top bar): menu button, product name, the open
 * notes as tabs, then the note's actions and the app's own on the right.
 */
export function TopBar() {
  const { tabs, view, assistant } = useUI();
  const rail = useUI((s) => !s.sidebar);
  const notes = useVault((s) => s.notes);
  const ai = useAI();
  const activeId = view.kind === 'note' ? view.id : null;
  const [menu, setMenu] = useState<null | 'export' | 'polish' | 'create'>(null);
  const exportBtn = useRef<HTMLButtonElement>(null);
  const polishBtn = useRef<HTMLButtonElement>(null);
  const createBtn = useRef<HTMLButtonElement>(null);
  const polishCount = usePolishCount(activeId);
  const openTabs = tabs.filter((id) => notes[id] && !notes[id].meta.trashed);
  const statusLabel =
    ai.status === 'online' ? ai.chatModel || 'Choose a model' : ai.status === 'checking' ? 'Connecting…' : ai.status === 'offline' ? 'Local AI offline' : 'Set up local AI';

  return (
    <header className={cx('topbar appbar drag', isElectron && isMac && 'has-traffic', rail && 'is-rail')}>
      <div className="appbar-start">
        <button className="icon-btn no-drag appbar-menu" onClick={() => useUI.getState().toggleSidebar()} aria-label="Main menu" title={`Main menu  ${MOD}\\`}>
          <Menu size={22} />
        </button>
        <button className="appbar-brand no-drag" onClick={() => useUI.getState().setView({ kind: 'classes' })} title="Home">
          <NibMark />
          <span className="appbar-name">Nib</span>
        </button>
      </div>

      <div className="tabs no-drag" role="tablist" aria-label="Open notes">
        {openTabs.map((id) => {
          const n = notes[id];
          return (
            <div
              key={id}
              role="tab"
              aria-selected={id === activeId}
              className={cx('tab', id === activeId && 'is-active')}
              onClick={() => useUI.getState().openNote(id)}
              onAuxClick={(e) => e.button === 1 && useUI.getState().closeTab(id)}
              onContextMenu={(e) => openContextMenu(e, noteMenu(n))}
              title={noteTitle(n)}
            >
              <FileText size={16} className="tab-icon" />
              <span className="tab-title">{noteTitle(n)}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  useUI.getState().closeTab(id);
                }}
                aria-label="Close tab"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <span className="grow" />

      <div className="topbar-actions no-drag">
        {activeId && (
          <>
            <button
              ref={polishBtn}
              className={cx('icon-btn top-btn', menu === 'polish' && 'is-on')}
              onClick={() => setMenu(menu === 'polish' ? null : 'polish')}
              aria-label="Polish"
              title="Polish — suggestions to tidy this note"
            >
              <ListChecks size={20} />
              {polishCount > 0 && <span className="badge">{polishCount}</span>}
            </button>
            <button
              ref={exportBtn}
              className={cx('icon-btn top-btn', menu === 'export' && 'is-on')}
              onClick={() => setMenu(menu === 'export' ? null : 'export')}
              aria-label="Export"
              title="Export or print"
            >
              <Download size={20} />
            </button>
            {/* Like the panel itself, only with a note open. */}
            <button className={cx('btn top-btn is-assistant', assistant ? 'is-tonal' : 'is-secondary')} onClick={() => toggleAssistant()} title={`Assistant  ${MOD}J`}>
              <MessageCircleQuestion size={18} />
              <span>Assistant</span>
            </button>
            <span className="appbar-sep" />
          </>
        )}
        <button className="icon-btn" onClick={() => useUI.getState().setPalette(true)} aria-label="Search" title={`Search notes and commands  ${MOD}K`}>
          <Search size={20} />
        </button>
        <button ref={createBtn} className={cx('icon-btn', menu === 'create' && 'is-on')} onClick={() => setMenu(menu === 'create' ? null : 'create')} aria-label="Create" title="Create">
          <Plus size={22} />
        </button>
        <button className={cx('ai-status', `is-${ai.status}`)} onClick={() => useUI.getState().openSettings('ai')} title={ai.lastError ?? `Local AI · ${statusLabel}`}>
          <span className="ai-dot" />
          <span className="ai-status-text">{statusLabel}</span>
        </button>
      </div>

      <Popover anchor={createBtn.current} open={menu === 'create'} onClose={() => setMenu(null)} align="end" className="menu-pop">
        <div className="menu">
          {(
            [
              ['Note', <FilePlus size={20} key="i" />, `${MOD}N`, () => newNote()],
              ['Homework', <ClipboardList size={20} key="i" />, `${SHIFT}${MOD}Y`, () => newHomework()],
              ['Class', <GraduationCap size={20} key="i" />, '', () => newClass()],
              ['Folder', <FolderPlus size={20} key="i" />, '', () => void newFolder('')],
            ] as const
          ).map(([label, icon, hint, run]) => (
            <button
              key={label}
              className="menu-item"
              onClick={() => {
                setMenu(null);
                run();
              }}
            >
              {icon}
              <span className="menu-label">{label}</span>
              {hint && <span className="menu-hint">{hint}</span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setMenu(null);
              void importFiles();
            }}
          >
            <FileUp size={20} />
            <span className="menu-label">Import PDF, Markdown or images…</span>
          </button>
        </div>
      </Popover>

      <Popover anchor={exportBtn.current} open={menu === 'export'} onClose={() => setMenu(null)} align="end" className="menu-pop">
        <div className="menu">
          <div className="menu-title">Export “{activeId ? noteTitle(notes[activeId]) : ''}”</div>
          {(
            [
              ['pdf', 'PDF document', <FileDown size={20} key="i" />, `${MOD}P`],
              ['md', 'Markdown', <FileType2 size={20} key="i" />, ''],
              ['html', 'Web page (HTML)', <Code2 size={20} key="i" />, ''],
              ['nib', 'Nib note (.nib)', <FileJson size={20} key="i" />, ''],
            ] as const
          ).map(([kind, label, icon, hint]) => (
            <button
              key={kind}
              className="menu-item"
              onClick={() => {
                setMenu(null);
                if (activeId) void exportNote(activeId, kind);
              }}
            >
              {icon}
              <span className="menu-label">{label}</span>
              {hint && <span className="menu-hint">{hint}</span>}
            </button>
          ))}
        </div>
      </Popover>
      {activeId && (
        <Popover anchor={polishBtn.current} open={menu === 'polish'} onClose={() => setMenu(null)} align="end" className="polish-pop">
          <PolishPanel noteId={activeId} onDone={() => setMenu(null)} />
        </Popover>
      )}
    </header>
  );
}
