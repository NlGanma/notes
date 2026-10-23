import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * How far (in page-layer px) a menu centred over the page must move sideways to stay inside the note's
 * visible area: a selection near the margin would otherwise put half its menu under the sidebar.
 */
export function useSideShift(ref: RefObject<HTMLElement | null>, inv: number, deps: unknown[]): number {
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest('.note-scroll');
    if (!el || !scroller) return;
    const r = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    // Where it would be without the current shift (screen px = layer px × scale).
    const now = shiftRef.current / inv;
    const left = r.left - now;
    const right = r.right - now;
    const min = box.left + 8;
    const max = box.right - 18; // (the scrollbar)
    let fix = 0;
    if (right - left > max - min) fix = min - left;
    else if (left < min) fix = min - left;
    else if (right > max) fix = max - right;
    const next = fix * inv;
    if (Math.abs(next - shiftRef.current) > 0.5) {
      shiftRef.current = next;
      setShift(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return shift;
}
