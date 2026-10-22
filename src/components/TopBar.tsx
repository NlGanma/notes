import { useRef, useState } from 'react';
import { ChevronDown, FileDown, FileText, FileUp, PanelLeft, Plus, MessageCircleQuestion, ListChecks, X, Code2, FileJson, FileType2 } from 'lucide-react';
import { useUI } from '../state/ui';
import { useVault } from '../state/vault';
import { newNote, toggleAssistant } from '../lib/commands';
import { exportNote } from '../lib/export';
import { importFiles } from '../lib/import';
import { Popover } from './common/Popover';
import { PolishPanel, usePolishCount } from './PolishPanel';
import { noteMenu, noteTitle } from './FileTree';
import { openContextMenu } from './common/ContextMenu';
import { cx } from '../lib/util';
import { isMac, MOD } from '../lib/platform';

export function TopBar() {
  const { tabs, view, sidebar, assistant } = useUI();
  const notes = useVault((s) => s.notes);
  const activeId = view.kind === 'note' ? view.id : null;
  const [menu, setMenu] = useState<null | 'export' | 'polish'>(null);
  const exportBtn = useRef<HTMLButtonElement>(null);
  const polishBtn = useRef<HTMLButtonElement>(null);
  const polishCount = usePolishCount(activeId);

  return (
    <div className={cx('topbar drag', !sidebar && isMac && 'has-traffic')}>
      {!sidebar && (
        <button className="icon-btn no-drag" onClick={() => useUI.getState().toggleSidebar()} aria-label="Show sidebar" title={`Show sidebar  ${MOD}\\`}>
          <PanelLeft size={16} />
        </button>
      )}
      <div className="tabs no-drag" role="tablist">
        {tabs
          .filter((id) => notes[id] && !notes[id].meta.trashed)
          .map((id) => {
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
                <FileText size={13} className="tab-icon" style={n.meta.color ? { color: n.meta.color } : undefined} />
                <span className="tab-title">{noteTitle(n)}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    useUI.getState().closeTab(id);
                  }}
                  aria-label="Close tab"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        <button className="tab-new" onClick={() => newNote()} aria-label="New note" title={`New note  ${MOD}N`}>
          <Plus size={14} />
        </button>
      </div>
      <span className="grow" />
      <div className="topbar-actions no-drag">
        {activeId && (
          <>
            <button
              ref={polishBtn}
              className={cx('top-btn', menu === 'polish' && 'is-on')}
              onClick={() => setMenu(menu === 'polish' ? null : 'polish')}
              title="Suggestions to tidy this note"
            >
              <ListChecks size={15} />
              <span>Polish</span>
              {polishCount > 0 && <span className="badge">{polishCount}</span>}
            </button>
            <button ref={exportBtn} className={cx('top-btn', menu === 'export' && 'is-on')} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
              <FileDown size={15} />
              <span>Export</span>
              <ChevronDown size={12} />
            </button>
            {/* Like the panel itself, only with a note open. */}
            <button className={cx('top-btn is-ai', assistant && 'is-on')} onClick={() => toggleAssistant()} title={`Assistant  ${MOD}J`}>
              <MessageCircleQuestion size={15} />
              <span>Assistant</span>
            </button>
          </>
        )}
      </div>

      <Popover anchor={exportBtn.current} open={menu === 'export'} onClose={() => setMenu(null)} align="end" className="menu-pop">
        <div className="menu">
          <div className="menu-title">Export “{activeId ? noteTitle(notes[activeId]) : ''}”</div>
          {(
            [
              ['pdf', 'PDF document', <FileDown size={15} key="i" />, `${MOD}P`],
              ['md', 'Markdown', <FileType2 size={15} key="i" />, ''],
              ['html', 'Web page (HTML)', <Code2 size={15} key="i" />, ''],
              ['nib', 'Nib note (.nib)', <FileJson size={15} key="i" />, ''],
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
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setMenu(null);
              void importFiles();
            }}
          >
            <FileUp size={15} />
            <span className="menu-label">Import PDF, Markdown, images…</span>
          </button>
        </div>
      </Popover>
      {activeId && (
        <Popover anchor={polishBtn.current} open={menu === 'polish'} onClose={() => setMenu(null)} align="end" className="polish-pop">
          <PolishPanel noteId={activeId} onDone={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  );
}
