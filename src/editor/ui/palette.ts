import type { Editor } from '@tiptap/core';

/** Notion's text and background colours (as replicated by react-notion-x), shared by the bubble and the Aa panel. */
export const TEXT_COLORS: { name: string; value: string }[] = [
  { name: 'Default', value: '' },
  { name: 'Gray', value: 'rgb(155, 154, 151)' },
  { name: 'Brown', value: 'rgb(100, 71, 58)' },
  { name: 'Orange', value: 'rgb(217, 115, 13)' },
  { name: 'Yellow', value: 'rgb(223, 171, 1)' },
  { name: 'Green', value: 'rgb(77, 100, 97)' },
  { name: 'Blue', value: 'rgb(11, 110, 153)' },
  { name: 'Purple', value: 'rgb(105, 64, 165)' },
  { name: 'Pink', value: 'rgb(173, 26, 114)' },
  { name: 'Red', value: 'rgb(224, 62, 62)' },
];

/** Background colours. Nib's highlighter yellow comes first, so "highlight" is one click. */
export const BG_COLORS: { name: string; value: string }[] = [
  { name: 'Default', value: '' },
  { name: 'Highlight', value: '#fff3a3' },
  { name: 'Gray', value: 'rgb(235, 236, 237)' },
  { name: 'Brown', value: 'rgb(233, 229, 227)' },
  { name: 'Orange', value: 'rgb(250, 235, 221)' },
  { name: 'Yellow', value: 'rgb(251, 243, 219)' },
  { name: 'Green', value: 'rgb(221, 237, 234)' },
  { name: 'Blue', value: 'rgb(221, 235, 241)' },
  { name: 'Purple', value: 'rgb(234, 228, 242)' },
  { name: 'Pink', value: 'rgb(244, 223, 235)' },
  { name: 'Red', value: 'rgb(251, 228, 228)' },
];

export type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock';

export const BLOCK_LABEL: Record<BlockKind, string> = {
  paragraph: 'Text',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  taskList: 'Checklist',
  blockquote: 'Quote',
  codeBlock: 'Code',
};

/** The type of the block the selection is in, innermost wrapper first (a heading in a list reads as the list). */
export function currentBlockKind(e: Editor): BlockKind {
  if (e.isActive('codeBlock')) return 'codeBlock';
  if (e.isActive('taskList')) return 'taskList';
  if (e.isActive('orderedList')) return 'orderedList';
  if (e.isActive('bulletList')) return 'bulletList';
  if (e.isActive('blockquote')) return 'blockquote';
  for (const level of [1, 2, 3] as const) if (e.isActive('heading', { level })) return `h${level}`;
  return 'paragraph';
}

/** Notion's "Turn into": replaces the block's type, unwrapping lists and quotes first. */
export function turnInto(e: Editor, kind: BlockKind) {
  const c = e.chain().focus();
  const cur = currentBlockKind(e);
  if (kind === cur && kind !== 'paragraph') return;
  switch (kind) {
    case 'paragraph':
      c.clearNodes().run();
      break;
    case 'h1':
    case 'h2':
    case 'h3':
      c.clearNodes()
        .setHeading({ level: Number(kind[1]) as 1 | 2 | 3 })
        .run();
      break;
    case 'bulletList':
      c.clearNodes().toggleBulletList().run();
      break;
    case 'orderedList':
      c.clearNodes().toggleOrderedList().run();
      break;
    case 'taskList':
      c.clearNodes().toggleTaskList().run();
      break;
    case 'blockquote':
      c.clearNodes().toggleBlockquote().run();
      break;
    case 'codeBlock':
      c.clearNodes().toggleCodeBlock().run();
      break;
  }
}
