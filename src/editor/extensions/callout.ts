import { mergeAttributes, Node } from '@tiptap/core';

export type CalloutVariant = 'note' | 'tip' | 'important' | 'question' | 'ai';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (variant?: CalloutVariant) => ReturnType;
      toggleCallout: (variant?: CalloutVariant) => ReturnType;
    };
  }
}

const ICONS: Record<CalloutVariant, string> = {
  note: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  tip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  important:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  question:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  ai: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>',
};

const ORDER: CalloutVariant[] = ['note', 'tip', 'important', 'question'];
const LABEL: Record<CalloutVariant, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  question: 'Question',
  ai: 'From your assistant',
};

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'note',
        parseHTML: (el) => (el.getAttribute('data-variant') as CalloutVariant) || 'note',
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]', contentElement: '.callout-body' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'callout' }), ['div', { class: 'callout-body' }, 0]];
  },

  addCommands() {
    return {
      setCallout:
        (variant = 'note') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { variant }),
      toggleCallout:
        (variant = 'note') =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { variant }),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'callout';
      dom.setAttribute('data-type', 'callout');
      const icon = document.createElement('button');
      icon.className = 'callout-icon';
      icon.contentEditable = 'false';
      icon.tabIndex = -1;
      const content = document.createElement('div');
      content.className = 'callout-body';
      dom.append(icon, content);

      const paint = () => {
        const v = current.attrs.variant as CalloutVariant;
        dom.setAttribute('data-variant', v);
        if (current.attrs.id) dom.setAttribute('data-id', current.attrs.id);
        icon.innerHTML = ICONS[v] ?? ICONS.note;
        icon.title = v === 'ai' ? LABEL.ai : `${LABEL[v]} — click to change`;
      };
      paint();

      icon.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const v = current.attrs.variant as CalloutVariant;
        if (v === 'ai') return;
        const next = ORDER[(ORDER.indexOf(v) + 1) % ORDER.length];
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'variant', next));
      });

      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
        ignoreMutation(m) {
          return !content.contains(m.target);
        },
      };
    };
  },
});
