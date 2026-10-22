import type { Current } from '../../state/review';

export type SessionKey = { do: 'end' } | { do: 'blur' } | { do: 'next' } | { do: 'show' } | { do: 'choose'; index: number } | { do: 'grade'; s: number };

/** "How did you do?" — 1 missed it, 2 partly, 3 got it. */
export const SELF_GRADES = [0, 0.5, 1];

/**
 * What a key does during a session: Esc leaves the answer box (what's typed
 * stays), and ends the session when nothing is being typed; Enter moves on
 * from feedback (or shows the notes for a self-check); 1–4 pick a choice and
 * 1–3 say how a self-check went. Nothing when the key was meant for something
 * else: handled already, a dialog, the palette or a menu that's open, another
 * part of the window, a field being typed in (or composed in with an input
 * method), or — for Enter — a focused button.
 */
export function sessionKey(
  e: { key: string; defaultPrevented: boolean; isComposing: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  where: { inSession: boolean; editable: boolean; control: boolean; overlay: boolean },
  cur: Pick<Current, 'phase' | 'item'> | null,
): SessionKey | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || where.overlay || !where.inSession) return null;
  if (e.key === 'Escape') return where.editable ? { do: 'blur' } : { do: 'end' };
  if (!cur || where.editable) return null;
  if (e.key === 'Enter') {
    if (e.shiftKey || where.control) return null;
    if (cur.phase === 'feedback') return { do: 'next' };
    if (cur.phase === 'ask' && cur.item.format === 'rate') return { do: 'show' };
    return null;
  }
  if (cur.phase === 'ask' && cur.item.format === 'mcq' && /^[1-4]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return cur.item.choices && index < cur.item.choices.length ? { do: 'choose', index } : null;
  }
  if (cur.phase === 'self' && /^[1-3]$/.test(e.key)) return { do: 'grade', s: SELF_GRADES[Number(e.key) - 1] };
  return null;
}
