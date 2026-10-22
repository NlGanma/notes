import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { create } from 'zustand';
import { useTools } from '../../state/tools';
import { NOTE_STARTERS } from '../../lib/ai/prompts';
import { editorBus } from '../bus';

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  icon: string; // lucide icon name, resolved by the menu component
  keywords: string;
  group: 'Basic' | 'Lists' | 'Ink & math' | 'Blocks' | 'AI';
  shortcut?: string;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'text',
    title: 'Text',
    hint: 'Plain paragraph',
    icon: 'Pilcrow',
    keywords: 'paragraph body plain',
    group: 'Basic',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    hint: 'Big section title',
    icon: 'Heading1',
    keywords: 'title h1 #',
    group: 'Basic',
    shortcut: '#',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    hint: 'Section',
    icon: 'Heading2',
    keywords: 'subtitle h2 ##',
    group: 'Basic',
    shortcut: '##',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    hint: 'Sub-section',
    icon: 'Heading3',
    keywords: 'h3 ###',
    group: 'Basic',
    shortcut: '###',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullets',
    title: 'Bulleted list',
    hint: 'Simple list',
    icon: 'List',
    keywords: 'ul unordered bullet -',
    group: 'Lists',
    shortcut: '-',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'numbers',
    title: 'Numbered list',
    hint: 'Ordered steps',
    icon: 'ListOrdered',
    keywords: 'ol ordered numbered 1.',
    group: 'Lists',
    shortcut: '1.',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'Checklist',
    hint: 'Track tasks',
    icon: 'ListChecks',
    keywords: 'todo task check []',
    group: 'Lists',
    shortcut: '[]',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'ink',
    title: 'Handwriting area',
    hint: 'Space to write or sketch by hand',
    icon: 'PenLine',
    keywords: 'ink draw sketch scribble handwriting pen canvas',
    group: 'Ink & math',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertInkBlock(5).run();
      e.commands.blur();
      useTools.getState().setTool(useTools.getState().lastInkTool === 'highlighter' ? 'pen' : useTools.getState().lastInkTool);
    },
  },
  {
    id: 'sketch',
    title: 'Inline sketch',
    hint: 'Draw a symbol inside this line',
    icon: 'Signature',
    keywords: 'inline ink symbol glyph draw',
    group: 'Ink & math',
    shortcut: '⌘D',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      editorBus.emit('inlineInk:open', { editor: e });
    },
  },
  {
    id: 'math',
    title: 'Equation',
    hint: 'Display math (LaTeX)',
    icon: 'Sigma',
    keywords: 'math latex equation formula katex $$',
    group: 'Ink & math',
    shortcut: '$$',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathBlock('').run(),
  },
  {
    id: 'imath',
    title: 'Inline math',
    hint: 'Math inside a sentence',
    icon: 'Radical',
    keywords: 'math latex inline $',
    group: 'Ink & math',
    shortcut: '$x$',
    run: (e, r) => e.chain().focus().deleteRange(r).insertMathInline('').run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    hint: 'Highlight a key idea',
    icon: 'Info',
    keywords: 'note box info callout',
    group: 'Blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setCallout('note').run(),
  },
  {
    id: 'tip',
    title: 'Tip',
    hint: 'Green callout',
    icon: 'Lightbulb',
    keywords: 'tip hint callout',
    group: 'Blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setCallout('tip').run(),
  },
  {
    id: 'important',
    title: 'Important',
    hint: 'Will be on the exam',
    icon: 'TriangleAlert',
    keywords: 'warning important exam callout',
    group: 'Blocks',
    run: (e, r) => e.chain().focus().deleteRange(r).setCallout('important').run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    hint: 'Quotation or definition',
    icon: 'Quote',
    keywords: 'blockquote cite >',
    group: 'Blocks',
    shortcut: '>',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: 'code',
    title: 'Code',
    hint: 'Code snippet',
    icon: 'Code',
    keywords: 'code snippet program ```',
    group: 'Blocks',
    shortcut: '```',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    hint: 'Separate sections',
    icon: 'Minus',
    keywords: 'hr rule line separator ---',
    group: 'Blocks',
    shortcut: '---',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    id: 'image',
    title: 'Image',
    hint: 'Insert a picture or screenshot',
    icon: 'Image',
    keywords: 'picture photo screenshot png jpg',
    group: 'Blocks',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      window.dispatchEvent(new CustomEvent('nib:pick-image'));
    },
  },
  {
    id: 'ask',
    title: 'Ask AI',
    hint: 'About this note, with full context',
    icon: 'Sparkles',
    keywords: 'ai assistant ask chat question explain llm',
    group: 'AI',
    shortcut: '⌘J',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      window.dispatchEvent(new CustomEvent('nib:assistant', { detail: { focus: true } }));
    },
  },
  {
    id: 'summarize',
    title: 'Summarize note',
    hint: 'Insert a summary here',
    icon: 'AlignLeft',
    keywords: 'ai summary tldr',
    group: 'AI',
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
  index: number;
  rect: DOMRect | null;
  pick: ((item: SlashItem) => void) | null;
  set(p: Partial<SlashState>): void;
}

export const useSlash = create<SlashState>((set) => ({
  open: false,
  items: [],
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
              index: 0,
              rect: props.clientRect?.() ?? null,
              pick: (item) => props.command(item),
            });
          },
          onUpdate: (props) => {
            useSlash.getState().set({
              items: props.items,
              index: 0,
              rect: props.clientRect?.() ?? null,
              pick: (item) => props.command(item),
            });
          },
          onKeyDown: ({ event }) => {
            const s = useSlash.getState();
            if (!s.open) return false;
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
            if (event.key === 'Escape') {
              s.set({ open: false });
              return true;
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
