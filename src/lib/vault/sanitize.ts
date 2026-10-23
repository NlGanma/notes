import type { JSONContent } from '@tiptap/core';
import type { Brush, Stroke } from '../ink/types';

/**
 * Notes come from files anyone can hand you (a shared .nib, a synced vault),
 * and parts of them end up in HTML (thumbnails, PDF export). Everything that
 * is interpolated into markup — numbers, colours, ids — is coerced to the
 * shape the app expects, so a crafted file can't inject markup or script.
 */

const BRUSHES: Brush[] = ['fountain', 'ballpoint', 'brush', 'pencil', 'marker', 'highlighter', 'mono'];
/**
 * Any CSS colour syntax (hex, names, rgb()/hsl() with commas or spaces,
 * oklch(), color(), var(--x, #fff)…) is allowed; what can't appear is
 * anything that ends a declaration or attribute, or loads a resource.
 */
const COLOR_CHARS = /^[#\w\s().,%+\-/]{1,120}$/;
const COLOR_BAD = /url\s*\(|expression|javascript|image|element\s*\(/i;

export function isSafeColor(c: unknown): c is string {
  return typeof c === 'string' && COLOR_CHARS.test(c.trim()) && !COLOR_BAD.test(c);
}

export function safeColor(c: unknown, fallback = '#1c1c1e'): string {
  return isSafeColor(c) ? c.trim() : fallback;
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const safeId = (v: unknown, i: number) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : `s${i}`);

export function sanitizeStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  raw.forEach((o, i) => {
    if (!o || typeof o !== 'object' || !Array.isArray((o as Stroke).pts)) return;
    const s = o as Record<string, unknown>;
    const stroke: Stroke = {
      id: safeId(s.id, i),
      brush: BRUSHES.includes(s.brush as Brush) ? (s.brush as Brush) : 'marker',
      color: safeColor(s.color),
      size: Math.min(200, Math.max(0.1, num(s.size, 2))),
      pts: (s.pts as unknown[]).map((p) => num(p, 0)),
    };
    if (s.pressure !== undefined) stroke.pressure = !!s.pressure;
    if (s.closed !== undefined) stroke.closed = !!s.closed;
    if (s.opacity !== undefined) stroke.opacity = Math.min(1, Math.max(0, num(s.opacity, 1)));
    out.push(stroke);
  });
  return out;
}

/** Cleans a note document in place-safe fashion (returns a sanitized copy of the risky parts). */
export function sanitizeDoc(node: JSONContent): JSONContent {
  const n: JSONContent = { ...node };
  if (n.attrs) {
    const a: Record<string, unknown> = { ...n.attrs };
    if ('ink' in a) a.ink = a.ink == null ? null : sanitizeStrokes(a.ink);
    if (n.type === 'inkInline') {
      a.strokes = sanitizeStrokes(a.strokes);
      a.w = Math.max(1, num(a.w, 24));
      a.h = Math.max(1, num(a.h, 24));
      a.em = Math.max(1, num(a.em, 16));
      a.drop = num(a.drop, 0);
      if (a.transcript != null && typeof a.transcript !== 'string') a.transcript = null;
    }
    if (n.type === 'heading') a.level = Math.min(6, Math.max(1, Math.round(num(a.level, 2))));
    if (n.type === 'inkBlock') a.height = Math.max(0, num(a.height, 64));
    if (n.type === 'orderedList' && 'start' in a) a.start = Math.round(num(a.start, 1));
    n.attrs = a;
  }
  if (n.marks)
    n.marks = n.marks.map((m) => {
      const color = m.attrs?.color;
      // An unusable colour is dropped (the text keeps its normal colour) rather than replaced.
      if ((m.type === 'highlight' || m.type === 'textStyle') && color != null && !isSafeColor(color)) return { ...m, attrs: { ...m.attrs, color: null } };
      return m;
    });
  if (Array.isArray(n.content)) n.content = n.content.map(sanitizeDoc);
  return n;
}
