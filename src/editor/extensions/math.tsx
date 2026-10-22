import { InputRule, mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, GraduationCap, MessageCircleQuestion, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { renderMath } from '../../lib/katex';
import { useTools } from '../../state/tools';
import { editorBus } from '../bus';
import { cx } from '../../lib/util';
import { Popover } from '../../components/common/Popover';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      insertMathBlock: (latex?: string) => ReturnType;
      insertMathInline: (latex?: string) => ReturnType;
    };
  }
}

// `$x^2$` → inline math. No space right after the opening or before the
// closing dollar, so "$5 and $10" stays plain text.
const INLINE_MATH = /(^|[^$\\\w])\$([^\s$](?:[^$]*?[^\s$\\])?)\$$/;

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'math-inline' }), `$${node.attrs.latex}$`];
  },

  renderText({ node }) {
    return `$${node.attrs.latex}$`;
  },

  addCommands() {
    return {
      insertMathInline:
        (latex = '') =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { latex } }).run(),
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: INLINE_MATH,
        handler: ({ state, range, match }) => {
          const lead = match[1] ?? '';
          const latex = match[2];
          const from = range.from + lead.length;
          state.tr.replaceWith(from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('[data-ui]'),
      as: 'span',
      className: 'math-inline-node',
    });
  },
});

function MathInlineView({ node, updateAttributes, selected, editor, getPos, deleteNode }: ReactNodeViewProps) {
  const latex = node.attrs.latex as string;
  const [editing, setEditing] = useState(!latex);
  const html = useMemo(() => renderMath(latex, false), [latex]);

  const finish = (value: string, moveAfter = true) => {
    setEditing(false);
    if (!value.trim()) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    if (value !== latex) updateAttributes({ latex: value });
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (moveAfter && typeof pos === 'number') {
      requestAnimationFrame(() => {
        const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1));
        editor.view.dispatch(tr);
        editor.view.focus();
      });
    }
  };

  return (
    <NodeViewWrapper
      as="span"
      className={cx('math-inline', selected && 'is-selected', editing && 'is-editing')}
      onDoubleClick={() => setEditing(true)}
      onClick={() => selected && setEditing(true)}
    >
      <span className="math-render" dangerouslySetInnerHTML={{ __html: html }} />
      {editing && <MathEditor initial={latex} inline onDone={finish} />}
    </NodeViewWrapper>
  );
}

function MathEditor({ initial, inline, onDone }: { initial: string; inline?: boolean; onDone: (value: string, moveAfter?: boolean) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const preview = useMemo(() => renderMath(value, !inline), [value, inline]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const commit = (moveAfter = true) => {
    if (done.current) return;
    done.current = true;
    onDone(value, moveAfter);
  };

  return (
    <span className={cx('math-editor', inline ? 'is-inline' : 'is-block')} data-ui contentEditable={false}>
      <textarea
        ref={ref}
        className="math-input"
        value={value}
        spellCheck={false}
        placeholder={inline ? 'x^2 + y^2' : '\\int_0^1 f(x)\\,dx'}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (inline || e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={() => commit(false)}
      />
      {inline && value && <span className="math-preview" dangerouslySetInnerHTML={{ __html: preview }} />}
      <span className="math-help">{inline ? 'Enter to finish' : '⌘↵ to finish · Esc'}</span>
    </span>
  );
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'math-block' }), `$$${node.attrs.latex}$$`];
  },

  renderText({ node }) {
    return `$$${node.attrs.latex}$$`;
  },

  addCommands() {
    return {
      insertMathBlock:
        (latex = '') =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { latex } }).run(),
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (sel instanceof NodeSelection && sel.node.type.name === this.name) {
          const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null;
          dom?.querySelector<HTMLElement>('.math-block')?.dispatchEvent(new CustomEvent('nib:edit'));
          return true;
        }
        return false;
      },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const start = $from.before();
          const end = $from.after();
          state.tr.replaceWith(start, end, this.type.create({ latex: '' }));
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('[data-ui]'),
      className: 'math-block-node',
    });
  },
});

function MathBlockView({ node, updateAttributes, selected, editor, getPos, deleteNode }: ReactNodeViewProps) {
  const latex = node.attrs.latex as string;
  const [editing, setEditing] = useState(!latex);
  const [menu, setMenu] = useState(false);
  const html = useMemo(() => renderMath(latex, true), [latex]);
  const rootRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const item = (icon: React.ReactNode, label: string, run: () => void, hint?: string, danger?: boolean) => (
    <button
      className={cx('menu-item', danger && 'is-danger')}
      role="menuitem"
      onClick={() => {
        setMenu(false);
        run();
      }}
    >
      {icon}
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onEdit = () => setEditing(true);
    el.addEventListener('nib:edit', onEdit);
    return () => el.removeEventListener('nib:edit', onEdit);
  }, []);

  const finish = (value: string, moveAfter = true) => {
    setEditing(false);
    if (!value.trim()) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    if (value !== latex) updateAttributes({ latex: value });
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (moveAfter && typeof pos === 'number') {
      requestAnimationFrame(() => {
        const after = pos + node.nodeSize;
        const doc = editor.state.doc;
        let tr = editor.state.tr;
        if (after >= doc.content.size || !doc.resolve(after).nodeAfter?.isTextblock) {
          tr = tr.insert(after, editor.schema.nodes.paragraph.create());
        }
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        editor.view.dispatch(tr);
        editor.view.focus();
      });
    }
  };

  return (
    <NodeViewWrapper ref={rootRef} className={cx('math-block', selected && 'is-selected', editing && 'is-editing')}>
      <div
        className="math-display"
        onDoubleClick={() => setEditing(true)}
        dangerouslySetInnerHTML={{ __html: latex || editing ? html : renderMath('\\text{Empty equation}', true) }}
      />
      {!editing && (
        <div className="math-actions" data-ui contentEditable={false}>
          <button
            ref={moreRef}
            className={cx('ink-action ink-more', menu && 'is-on')}
            title="Equation actions"
            aria-label="Equation actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      )}
      <Popover anchor={moreRef.current} open={menu} onClose={() => setMenu(false)} align="start" className="menu-pop">
        <div className="menu ink-menu" role="menu">
          {latex &&
            item(<MessageCircleQuestion size={20} />, 'Ask about this', () =>
              editorBus.emit('math:ask', { editor, latex, mode: 'explain', blockId: node.attrs.id }),
            )}
          {latex &&
            item(<GraduationCap size={20} />, 'Tutor me through it', () =>
              editorBus.emit('math:ask', { editor, latex, mode: 'tutor', blockId: node.attrs.id }),
            )}
          {latex && <div className="menu-sep" />}
          {item(<Pencil size={20} />, 'Edit equation', () => setEditing(true), 'Enter')}
          {latex &&
            item(<Copy size={20} />, 'Copy LaTeX', () => {
              navigator.clipboard?.writeText(latex).catch(() => undefined);
            })}
          <div className="menu-sep" />
          {item(
            <Trash2 size={20} />,
            'Delete',
            () => {
              deleteNode();
              if (useTools.getState().tool === 'text') editor.commands.focus();
            },
            undefined,
            true,
          )}
        </div>
      </Popover>
      {editing && <MathEditor initial={latex} onDone={finish} />}
    </NodeViewWrapper>
  );
}
