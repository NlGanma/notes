import type { JSONContent } from '@tiptap/core';
import type { NoteDoc } from './vault/types';

/*
 * The name a note goes by when nobody gave it one. Nothing ever requires a title: an untitled note
 * is named by its first typed line, else what its handwriting says, else its date.
 *
 * UI only (labels, tabs, the window title, the palette, export file names). Never stored in
 * meta.title, never used for vault file paths or for the notes the AI searches: a derived name
 * changing as the first line is typed must not rename files or count words as "in your notes".
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX = 60;

// Built by hand rather than with toLocaleDateString, so a name reads the same on every machine.
const shortDate = (t: number) => {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const dayDate = (t: number) => `${DAYS[new Date(t).getDay()]}, ${shortDate(t)}`;

/** Cuts a line to 60 characters at a word boundary. */
function clip(line: string): string {
  const s = line.replace(/\s+/g, ' ').trim();
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

function inlineText(nodes: JSONContent[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') out += n.text ?? '';
    else if (n.type === 'hardBreak') out += '\n';
    else if (n.type === 'mathInline') out += String(n.attrs?.latex ?? '');
    else if (n.content) out += inlineText(n.content);
  }
  return out;
}

/** The first non-empty line of typed text, in document order. */
function firstTypedLine(blocks: JSONContent[] | undefined, skip: (line: string) => boolean): string | null {
  for (const b of blocks ?? []) {
    if (b.type === 'paragraph' || b.type === 'heading') {
      for (const line of inlineText(b.content).split('\n')) {
        const t = line.trim();
        if (t && !skip(t)) return t;
      }
    } else if (b.content && b.type !== 'inkBlock' && b.type !== 'codeBlock') {
      const inner = firstTypedLine(b.content, skip);
      if (inner) return inner;
    }
  }
  return null;
}

/** The first line of what Nib read from the handwriting. */
function firstInkLine(blocks: JSONContent[] | undefined): string | null {
  for (const b of blocks ?? []) {
    if (b.type === 'inkBlock') {
      const t = b.attrs?.transcript as { text?: string; description?: string } | null | undefined;
      const line = (t?.text || t?.description || '').split('\n').find((l) => l.trim());
      if (line) return line.trim();
    } else if (b.content) {
      const inner = firstInkLine(b.content);
      if (inner) return inner;
    }
  }
  return null;
}

/** The name an untitled note falls back to when it has nothing written yet: its date (homework: when it's due). */
export function dateTitle(note: NoteDoc): string {
  const hw = note.meta.homework;
  if (hw) return hw.due ? `Homework · due ${dayDate(hw.due)}` : `Homework · ${shortDate(note.meta.created)}`;
  return `Note · ${shortDate(note.meta.created)}`;
}

const memo = new WeakMap<NoteDoc, string>();

/** What to call a note anywhere it is shown. Notes are replaced, never mutated, so one name per object is safe. */
export function displayTitle(note: NoteDoc): string {
  const hit = memo.get(note);
  if (hit !== undefined) return hit;
  const title = note.meta.title.trim();
  // New homework starts with a "My work" heading; that is the page's scaffolding, not its name.
  const skip = note.meta.homework ? (l: string) => l === 'My work' : () => false;
  const name = title ? title : clip(firstTypedLine(note.content.content, skip) ?? firstInkLine(note.content.content) ?? '') || dateTitle(note);
  memo.set(note, name);
  return name;
}

/** True when the shown name is only the date fallback (the title field then shows it as its placeholder). */
export function isDateTitle(note: NoteDoc): boolean {
  return !note.meta.title.trim() && displayTitle(note) === dateTitle(note);
}
