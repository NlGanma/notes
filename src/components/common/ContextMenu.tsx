import { create } from 'zustand';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/util';

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

export const useContextMenu = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  hide: () => set({ open: false }),
}));

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault();
  useContextMenu.getState().show(e.clientX, e.clientY, items);
}

export function ContextMenuHost() {
  const { open, x, y, items, hide } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({ left: Math.min(x, window.innerWidth - w - 8), top: Math.min(y, window.innerHeight - h - 8) });
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, [open, x, y, hide]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className="menu context-menu" style={pos} role="menu" data-ui>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'is-danger')}
            disabled={it.disabled}
            onClick={() => {
              hide();
              it.run?.();
            }}
          >
            {it.icon}
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
