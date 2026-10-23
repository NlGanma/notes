import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronsRight, PanelLeft, PanelRight, X } from 'lucide-react';
import { useUI } from '../state/ui';
import { useVault } from '../state/vault';
import { toggleAssistant } from '../lib/commands';
import { displayTitle } from '../lib/displayTitle';
import { Popover } from './common/Popover';
import { noteMenu } from './FileTree';
import { openContextMenu } from './common/ContextMenu';
import { cx } from '../lib/util';
import { MOD } from '../lib/platform';

const TAB_MIN = 96;
const TAB_GAP = 2;
const MORE_W = 32;

/**
 * The bar above the page: the open notes as quiet tabs and, with a note open, the Assistant toggle.
 * Everything else a note can do lives in its own ⋯ menu. The empty part of the bar drags the window.
 */
export function MainBar({ scrolled }: { scrolled?: boolean }) {
  const { tabs, view, assistant, sidebar } = useUI();
  const notes = useVault((s) => s.notes);
  const activeId = view.kind === 'note' ? view.id : null;
  const open = tabs.filter((id) => notes[id] && !notes[id].meta.trashed);
  const strip = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState(open.length);
  const [more, setMore] = useState(false);

  // As many tabs as fit at their narrowest; the rest go into a » menu at the end of the strip.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      // The strip's right padding is the window's drag room, never room for tabs.
      const w = el.clientWidth - parseFloat(getComputedStyle(el).paddingRight);
      const all = Math.floor((w + TAB_GAP) / (TAB_MIN + TAB_GAP));
      setFit(all >= open.length ? open.length : Math.max(1, Math.floor((w - MORE_W + TAB_GAP) / (TAB_MIN + TAB_GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open.length]);

  let shown = open.slice(0, fit);
  // The open note always has its tab in view.
  if (activeId && open.includes(activeId) && !shown.includes(activeId)) shown = [...shown.slice(0, Math.max(0, fit - 1)), activeId];
  const hidden = open.filter((id) => !shown.includes(id));

  return (
    <header className={cx('mainbar drag', scrolled && 'is-scrolled')}>
      {!sidebar && (
        <button
          className="icon-btn mainbar-show no-drag"
          onClick={() => {
            useUI.getState().toggleSidebar();
            requestAnimationFrame(() => document.querySelector<HTMLElement>('.sidebar-hide')?.focus());
          }}
          aria-label="Show sidebar"
          title={`Show sidebar  ${MOD}\\`}
        >
          <PanelLeft size={18} strokeWidth={1.5} />
        </button>
      )}
      <div className="tabs" ref={strip} role="tablist" aria-label="Open notes">
        {shown.map((id) => {
          const n = notes[id];
          const name = displayTitle(n);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={id === activeId}
              className={cx('tab no-drag', id === activeId && 'is-active')}
              onClick={() => useUI.getState().openNote(id)}
              onAuxClick={(e) => e.button === 1 && useUI.getState().closeTab(id)}
              onContextMenu={(e) => openContextMenu(e, noteMenu(n))}
              title={name}
            >
              <span className="tab-title">{name}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  useUI.getState().closeTab(id);
                }}
                aria-label={`Close ${name}`}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
        {hidden.length > 0 && (
          <button ref={moreBtn} className={cx('icon-btn tab-more no-drag', more && 'is-on')} onClick={() => setMore(!more)} aria-label={`${hidden.length} more tabs`} title="More tabs">
            <ChevronsRight size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {activeId && (
        <button
          className={cx('btn top-btn is-assistant no-drag', assistant && 'is-on')}
          onClick={() => toggleAssistant()}
          aria-pressed={assistant}
          title={`Assistant  ${MOD}J`}
        >
          <PanelRight size={16} strokeWidth={1.5} />
          <span>Assistant</span>
        </button>
      )}
      <Popover anchor={moreBtn.current} open={more && hidden.length > 0} onClose={() => setMore(false)} align="start" className="menu-pop">
        <div className="menu" role="menu">
          {hidden.map((id) => (
            <button
              key={id}
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setMore(false);
                useUI.getState().openNote(id);
              }}
            >
              <span className="menu-label">{displayTitle(notes[id])}</span>
            </button>
          ))}
        </div>
      </Popover>
    </header>
  );
}
