import type { JSONContent } from '@tiptap/core';

const MARKS: Record<string, string> = { B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', U: 'underline' };

/**
 * Turns what the browser's contentEditable made of the Instructions field
 * (lines as <div>s or <br>s, <b>/<i>/<u>, <ul>/<ol>) into the note's blocks.
 */
export function editableToBlocks(root: Node): JSONContent[] {
  const out: JSONContent[] = [];
  let line: JSONContent[] = [];
  const flush = (keepEmpty = false) => {
    if (line.length) out.push({ type: 'paragraph', content: line });
    else if (keepEmpty) out.push({ type: 'paragraph' });
    line = [];
  };
  const walk = (n: Node, marks: string[]) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent ?? '').replace(/ /g, ' ');
      if (text) line.push(marks.length ? { type: 'text', text, marks: [...new Set(marks)].map((type) => ({ type })) } : { type: 'text', text });
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const tag = n.tagName;
    if (tag === 'BR') return flush(true);
    if (tag === 'UL' || tag === 'OL') {
      flush();
      const items = [...n.children].filter((c) => c.tagName === 'LI');
      out.push({
        type: tag === 'UL' ? 'bulletList' : 'orderedList',
        content: items.map((li) => {
          const inner = editableToBlocks(li);
          return { type: 'listItem', content: inner.length ? inner : [{ type: 'paragraph' }] };
        }),
      });
      return;
    }
    const block = tag === 'DIV' || tag === 'P';
    if (block) flush();
    const mark = MARKS[tag];
    for (const c of n.childNodes) walk(c, mark ? [...marks, mark] : marks);
    if (block) flush();
  };
  for (const c of root.childNodes) walk(c, []);
  flush();
  // Blank lines at either end are just where the caret was.
  const blank = (b: JSONContent) => b.type === 'paragraph' && !b.content?.length;
  while (out.length && blank(out[0])) out.shift();
  while (out.length && blank(out[out.length - 1])) out.pop();
  return out;
}
