import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { create } from 'zustand';
import { useTools } from '../../state/tools';
import { NOTE_STARTERS } from '../../lib/ai/prompts';
import { editorBus } from '../bus';

export type SlashGroup = 'Basic blocks' | 'Handwriting & math' | 'Media' | 'Assistant';
export const SLASH_GROUPS: SlashGroup[] = ['Basic blocks', 'Handwriting & math', 'Media', 'Assistant'];

export interface SlashItem {
  id: string;
  title: string;
  /** One line for the preview card. */
  hint: string;
  icon: string; // lucide icon name, resolved by the menu component
  keywords: string;
  group: SlashGroup;
  shortcut?: string;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'text',
    title: 'Text',
    hint: 'Just start writing with plain text.',
    icon: 'Pilcrow',
    keywords: 'paragraph body plain',
    group: 'Basic blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    hint: 'Big section heading.',
    icon: 'Heading1',
    keywords: 'title h1 #',
    group: 'Basic blocks',
    shortcut: '#',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    hint: 'Medium section heading.',
    icon: 'Heading2',
    keywords: 'subtitle h2 ##',
    group: 'Basic blocks',
    shortcut: '##',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    hint: 'Small section heading.',
    icon: 'Heading3',
    keywords: 'h3 ###',
    group: 'Basic blocks',
    shortcut: '###',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullets',
    title: 'Bulleted list',
    hint: 'Create a simple bulleted list.',
    icon: 'List',
    keywords: 'ul unordered bullet -',
    group: 'Basic blocks',
    shortcut: '-',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'numbers',
    title: 'Numbered list',
    hint: 'Create a list with numbering.',
    icon: 'ListOrdered',
    keywords: 'ol ordered numbered 1.',
    group: 'Basic blocks',
    shortcut: '1.',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'Checklist',
    hint: 'Track tasks with a checklist.',
    icon: 'ListChecks',
    keywords: 'todo to-do task check []',
    group: 'Basic blocks',
    shortcut: '[]',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    hint: 'Capture a quote or a definition.',
    icon: 'Quote',
    keywords: 'blockquote cite definition >',
    group: 'Basic blocks',
    shortcut: '>',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    // Tip and Important are colours of one callout now: click its icon to change it (Notion).
    id: 'callout',
    title: 'Callout',
    hint: 'Make a key idea stand out. Click its icon to change the colour.',
    icon: 'Info',
    keywords: 'note box info callout tip important warning exam',
    group: 'Basic blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setCallout('note').run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    hint: 'Visually divide sections.',
    icon: 'Minus',
    keywords: 'hr rule line separator ---',
    group: 'Basic blocks',
    shortcut: '---',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    id: 'code',
    title: 'Code',
    hint: 'Capture a code snippet.',
    icon: 'Code',
    keywords: 'code snippet program ```',
    group: 'Basic blocks',
    shortcut: '```',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'ink',
    title: 'Handwriting area',
    hint: 'Space to write or sketch by hand.',
    icon: 'PenLine',
    keywords: 'ink draw sketch scribble handwriting pen canvas',
    group: 'Handwriting & math',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertInkBlock(5).run();
      e.commands.blur();
      useTools.getState().setTool(useTools.getState().lastInkTool === 'highlighter' ? 'pen' : useTools.getState().lastInkTool);
    },
  },
  {
    id: 'sketch',
    title: 'Inline sketch',
    hint: 'Draw a symbol inside this line.',
    icon: 'Signature',
    keywords: 'inline ink symbol glyph draw',
    group: 'Handwriting & math',
    shortcut: '⌘D',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      editorBus.emit('inlineInk:open', { editor: e });
    },
  },
  {
    id: 'math',
    title: 'Equation',
    hint: 'Write a LaTeX equation on its own line.',
    icon: 'Sigma',
    keywords: 'math latex equation formula katex $$',
    group: 'Handwriting & math',
    shortcut: '$$',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathBlock('').run(),
  },
  {
    id: 'imath',
    title: 'Inline equation',
    hint: 'Math inside a sentence.',
    icon: 'Radical',
    keywords: 'math latex inline $',
    group: 'Handwriting & math',
    shortcut: '$x$',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathInline('').run(),
  },
  {
    id: 'image',
    title: 'Image',
    hint: 'Insert a picture or a screenshot.',
    icon: 'Image',
    keywords: 'picture photo screenshot png jpg',
    group: 'Media',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      window.dispatchEvent(new CustomEvent('nib:pick-image'));
    },
  },
  {
    id: 'ask',
    title: 'Ask about this note',
    hint: 'Ask the assistant, with this note as context.',
    icon: 'MessageCircleQuestion',
    keywords: 'ai assistant ask chat question explain llm',
    group: 'Assistant',
    shortcut: '⌘J',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      window.dispatchEvent(new CustomEvent('nib:assistant', { detail: { focus: true } }));
    },
  },
  {
    id: 'summarize',
    title: 'Summarize note',
    hint: 'Insert a summary of this note here.',
    icon: 'AlignLeft',
    keywords: 'ai summary tldr',
    group: 'Assistant',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      window.dispatchEvent(new CustomEvent('nib:assistant', { detail: { prompt: NOTE_STARTERS.summary, send: true } }));
    },
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  const scored = SLASH_ITEMS.map((item) => {
    const title = item.title.toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    else if (item.keywords.includes(q)) score = 1;
    return { item, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.item);
}

interface SlashState {
  open: boolean;
  items: SlashItem[];
  /** What was typed after "/", and its length the last time something matched. */
  query: string;
  matched: number;
  index: number;
  rect: DOMRect | null;
  pick: ((item: SlashItem) => void) | null;
  set(p: Partial<SlashState>): void;
}

export const useSlash = create<SlashState>((set) => ({
  open: false,
  items: [],
  query: '',
  matched: 0,
  index: 0,
  rect: null,
  pick: null,
  set: (p) => set(p),
}));

export const slashKey = new PluginKey('slash');

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          // Only trigger at the start of a block or after whitespace.
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
          return before === '' || /\s$/.test(before);
        },
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: (props) => {
            useSlash.getState().set({
              open: true,
              items: props.items,
              query: props.query,
              matched: 0,
              index: 0,
              rect: props.clientRect?.() ?? null,
              pick: (item) => props.command(item),
            });
          },
          onUpdate: (props) => {
            useSlash.getState().set({
              items: props.items,
              query: props.query,
              matched: props.items.length ? props.query.length : useSlash.getState().matched,
              index: 0,
              rect: props.clientRect?.() ?? null,
              pick: (item) => props.command(item),
            });
          },
          onKeyDown: ({ event }) => {
            const s = useSlash.getState();
            if (!s.open) return false;
            if (event.key === 'Escape') {
              s.set({ open: false });
              return true;
            }
            // Nothing matches: the keys belong to the text again.
            if (!s.items.length) return false;
            if (event.key === 'ArrowDown') {
              s.set({ index: (s.index + 1) % Math.max(1, s.items.length) });
              return true;
            }
            if (event.key === 'ArrowUp') {
              s.set({ index: (s.index - 1 + s.items.length) % Math.max(1, s.items.length) });
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = s.items[s.index];
              if (item && s.pick) {
                s.pick(item);
                return true;
              }
              return false;
            }
            return false;
          },
          onExit: () => {
            useSlash.getState().set({ open: false, items: [], pick: null });
          },
        }),
      }),
    ];
  },
});
