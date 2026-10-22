import type { JSONContent } from '@tiptap/core';
import type { FolderMeta, NoteDoc, NoteMeta } from '../../src/lib/vault/types';

let n = 0;
export function note(title: string, folder: string, content: JSONContent[], meta: Partial<NoteMeta> = {}): NoteDoc {
  n++;
  return {
    version: 1,
    meta: { id: meta.id ?? `n${n}`, title, folder, tags: [], created: 1, updated: 1, ...meta },
    content: { type: 'doc', content },
  };
}

export const p = (text: string, id?: string): JSONContent => ({ type: 'paragraph', attrs: { id: id ?? null }, content: [{ type: 'text', text }] });
export const h = (text: string, level = 2): JSONContent => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
export const m = (latex: string): JSONContent => ({ type: 'mathInline', attrs: { latex } });
export const callout = (variant: string, ...content: JSONContent[]): JSONContent => ({ type: 'callout', attrs: { variant }, content });

export function byId(list: NoteDoc[]): Record<string, NoteDoc> {
  return Object.fromEntries(list.map((x) => [x.meta.id, x]));
}

export const CLASSES: Record<string, FolderMeta> = {
  'Calculus I': { kind: 'class', code: 'MATH 1A', color: '#2160e8', icon: 'sigma' },
  Biology: { kind: 'class' },
  'Old Class': { kind: 'class', archived: true },
  Drafts: { color: '#ff0000' },
};

/** A small vault: two calculus lectures, a biology note, homework and noise. */
export function vault() {
  const lecture4 = note('Lecture 4 — Limits & Continuity', 'Calculus I', [
    h('Squeeze theorem'),
    p('If g(x) ≤ f(x) ≤ h(x) near a and lim g = lim h = L, then lim f = L.'),
    h('Continuity'),
    p('f is continuous at a when f(a) is defined, the limit exists, and they are equal. A removable discontinuity is a hole.'),
    callout('ai', p('AI explanation pasted by the student about squeeze theorem tricks.')),
  ]);
  const lecture5 = note('Lecture 5 — Derivatives', 'Calculus I/Unit 2', [h('Definition'), p('The derivative is the limit of the difference quotient.')]);
  const cells = note('Cell Structure', 'Biology', [h('Mitochondria'), p('Mitochondria make ATP through cellular respiration.')]);
  const loose = note('Shopping list', '', [p('Milk, eggs, bread.')]);
  const hw = note(
    'Problem Set 4',
    'Calculus I/Homework',
    [p('1. Use the squeeze theorem to find the limit of x^2 sin(1/x).'), p('2. Is the function continuous at 3? What kind of discontinuity?')],
    {
      homework: { sources: [], folders: ['Calculus I'], due: undefined },
    },
  );
  const trashed = note('Old lecture', 'Calculus I', [p('Squeeze theorem squeeze squeeze.')], { trashed: 5 });
  const list = [lecture4, lecture5, cells, loose, hw, trashed];
  return { lecture4, lecture5, cells, loose, hw, trashed, list, notes: byId(list) };
}

/** Visible text of rendered HTML outside every caution box and inline mark. */
export function unlabeled(html: string): string {
  let out = '';
  let skip = 0;
  const stack: boolean[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      if (!skip) out += m[4];
      continue;
    }
    const [, close, tag, attrs] = m;
    if (/^(?:br|hr|img|input)$/i.test(tag) || /\/$/.test(attrs)) continue;
    if (!close) {
      const labelled = /class="[^"]*\b(?:outside-notes|own-inline|own-tag)\b/.test(attrs);
      stack.push(labelled);
      if (labelled) skip++;
    } else if (stack.pop()) skip--;
  }
  return out.replace(/\s+/g, ' ');
}
