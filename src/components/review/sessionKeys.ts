import type { Current } from '../../state/review';

export type SessionKey = { do: 'end' } | { do: 'next' } | { do: 'show' } | { do: 'choose'; index: number };

/**
 * What a key does during a session: Esc ends it, Enter moves on from feedback
 * (or shows the notes for a self-check), 1–4 pick a choice. Nothing when the
 * key was meant for something else: handled already, a dialog, the palette or
 * a menu that's open, another part of the window, a field being typed in (or
 * composed in with an input method), or — for Enter — a focused button.
 */
export function sessionKey(
  e: { key: string; defaultPrevented: boolean; isComposing: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  where: { inSession: boolean; editable: boolean; control: boolean; overlay: boolean },
  cur: Pick<Current, 'phase' | 'item'> | null,
): SessionKey | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || where.overlay || !where.inSession) return null;
  if (e.key === 'Escape') return { do: 'end' };
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
  return null;
}
