import { Extension, type Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Image from '@tiptap/extension-image';
import Typography from '@tiptap/extension-typography';
import { TextSelection } from '@tiptap/pm/state';
import { BlockAttrs } from './blockAttrs';
import { Rhythm } from './rhythm';
import { InkBlock } from './inkBlock';
import { InkInline } from './inkInline';
import { MathBlock, MathInline } from './math';
import { Callout } from './callout';
import { SlashCommand } from './slash';
import { editorBus } from '../bus';

/** Moves the top-level block containing the selection up or down. */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const { state } = editor;
  const { doc, selection } = state;
  const index = selection.$from.index(0);
  const target = index + dir;
  if (target < 0 || target >= doc.childCount) return true;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const node = doc.child(index);
  const other = doc.child(target);
  const offset = selection.from - pos;
  const tr = state.tr.delete(pos, pos + node.nodeSize);
  const insertAt = dir < 0 ? pos - other.nodeSize : pos + other.nodeSize;
  tr.insert(insertAt, node);
  const caret = Math.min(insertAt + Math.max(1, offset), tr.doc.content.size);
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
  } catch {
    /* keep default mapping */
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const NibKeymap = Extension.create({
  name: 'nibKeymap',
  addKeyboardShortcuts() {
    return {
      'Mod-d': ({ editor }) => {
        editorBus.emit('inlineInk:open', { editor });
        return true;
      },
      'Mod-Shift-m': ({ editor }) => {
        const { from, to, empty } = editor.state.selection;
        const text = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
        return editor
          .chain()
          .focus()
          .insertContentAt({ from, to }, { type: 'mathInline', attrs: { latex: text } })
          .run();
      },
      'Alt-Shift-ArrowUp': ({ editor }) => moveBlock(editor, -1),
      'Alt-Shift-ArrowDown': ({ editor }) => moveBlock(editor, 1),
    };
  },
});

export function buildExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      trailingNode: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      dropcursor: { color: '#2160e8', width: 2 },
      undoRedo: { depth: 500, newGroupDelay: 650 },
      codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
    }),
    Placeholder.configure({
      includeChildren: false,
      showOnlyCurrent: true,
      placeholder: ({ editor, node }) => {
        if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
        if (editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.content.size === 0) {
          return 'Start typing, or pick up the pen and write…   “/” for blocks';
        }
        return 'Type “/” for blocks, ⌘D to sketch inline';
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    Image.configure({ allowBase64: true, inline: false }),
    Typography.configure({ oneHalf: false, oneQuarter: false, threeQuarters: false }),
    BlockAttrs,
    Rhythm,
    InkBlock,
    InkInline,
    MathInline,
    MathBlock,
    Callout,
    SlashCommand,
    NibKeymap,
  ];
}
