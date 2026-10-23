import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/util';

/**
 * A floating panel anchored to an element, rendered in a portal so it is never
 * clipped or scaled by the page. Closes on outside click and Escape.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom',
  align = 'center',
  offset = 8,
  className,
}: {
  anchor: HTMLElement | DOMRect | null;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  placement?: 'bottom' | 'top' | 'right' | 'left';
  align?: 'start' | 'center' | 'end';
  offset?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = 0;
      let top = 0;
      if (placement === 'bottom' || placement === 'top') {
        left = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2;
        top = placement === 'bottom' ? a.bottom + offset : a.top - h - offset;
        if (placement === 'bottom' && top + h > window.innerHeight - 8) top = a.top - h - offset;
      } else {
        top = align === 'start' ? a.top : align === 'end' ? a.bottom - h : a.top + a.height / 2 - h / 2;
        left = placement === 'right' ? a.right + offset : a.left - w - offset;
      }
      left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
      top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
      setPos({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, anchor, placement, align, offset]);

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // From the keyboard, focus goes back to what opened it rather than to the page.
        if (anchor instanceof HTMLElement && ref.current?.contains(document.activeElement)) anchor.focus();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={cx('popover', className)}
      data-ui
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
