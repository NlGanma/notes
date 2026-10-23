import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { Eye, MoreHorizontal, MessageCircleQuestion, Type, Sigma, ScanText, Trash2, FoldVertical } from 'lucide-react';
import { useTools } from '../../state/tools';
import type { InkTranscript, Stroke } from '../../lib/ink/types';
import { deleteBlock, fittedHeight, inkOf, insertParagraphInInk, setInkBlockHeight, trimInkBlock } from '../ink/ops';
import { editorBus } from '../bus';
import { cx } from '../../lib/util';
import { Popover } from '../../components/common/Popover';
import { renderMath } from '../../lib/katex';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    inkBlock: {
      insertInkBlock: (lines?: number) => ReturnType;
    };
  }
}

export function lineHeightOf(dom: Element): number {
  return parseFloat(getComputedStyle(dom).getPropertyValue('--line')) || 32;
}

/**
 * A handwriting area: a block of the page reserved for ink. The strokes are
 * drawn by the page-wide ink layer; this node only owns the space (its
 * height is always a whole number of ruled lines) plus the margin actions.
 */
export const InkBlock = Node.create({
  name: 'inkBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      height: {
        default: 128,
        parseHTML: (el) => Number(el.getAttribute('data-height')) || 128,
        renderHTML: (attrs) => ({ 'data-height': attrs.height, style: `height:${attrs.height}px` }),
      },
      transcript: {
        default: null,
        parseHTML: (el) => {
          try {
            return JSON.parse(el.getAttribute('data-transcript') || 'null');
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => (attrs.transcript ? { 'data-transcript': JSON.stringify(attrs.transcript) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="ink-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'ink-block', class: 'ink-block' })];
  },

  addCommands() {
    return {
      insertInkBlock:
        (lines = 4) =>
        ({ editor, chain }) => {
          const line = lineHeightOf(editor.view.dom);
          return chain()
            .insertContent({ type: 'inkBlock', attrs: { height: line * lines } })
            .run();
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(InkBlockView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('[data-ui]'),
      className: 'ink-block-node',
    });
  },
});

function InkBlockView({ node, editor, selected }: ReactNodeViewProps) {
  const tool = useTools((s) => s.tool);
  const id = node.attrs.id as string;
  const height = node.attrs.height as number;
  const ink = inkOf(node) as Stroke[];
  const transcript = node.attrs.transcript as InkTranscript | null;
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const moreRef = useRef<HTMLButtonElement>(null);
  // The ⋯ it hangs from goes away under the marker, highlighter and eraser: so does what was read.
  useEffect(() => {
    if (tool !== 'text' && tool !== 'lasso') setShowTranscript(false);
  }, [tool]);

  const line = () => lineHeightOf(editor.view.dom);
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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-ui]')) return;
    if (useTools.getState().tool !== 'text') return; // ink tools are handled by the ink layer
    if (e.pointerType === 'pen' && useTools.getState().stylusDraws) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const scale = rect.height / (el.offsetHeight || 1) || 1;
    insertParagraphInInk(editor, id, (e.clientY - rect.top) / scale, line());
    editor.view.focus();
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const rect = rootRef.current!.getBoundingClientRect();
    const scale = rect.height / (rootRef.current!.offsetHeight || 1) || 1;
    const l = line();
    const min = ink.length ? fittedHeight(ink, l) : l;
    let next = height;
    const move = (ev: PointerEvent) => {
      const raw = height + (ev.clientY - startY) / scale;
      next = Math.max(min, Math.round(raw / l) * l);
      setLiveHeight(next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setLiveHeight(null);
      if (next !== height) setInkBlockHeight(editor, id, next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <NodeViewWrapper
      ref={rootRef}
      className={cx('ink-block', selected && 'is-selected', !ink.length && 'is-empty', `tool-${tool}`)}
      style={{ height: liveHeight ?? height }}
      data-ink-block=""
      data-id={id}
      onPointerDown={onPointerDown}
    >
      {!ink.length && <div className="ink-block-hint">Handwriting area. Pick the marker and write, or click to type.</div>}

      {/* One hover-only handle in the left gutter (Notion's block handle) instead of a column of icons. */}
      <div className="ink-actions" data-ui contentEditable={false}>
        <button
          ref={moreRef}
          className={cx('ink-action ink-more', (menu || showTranscript) && 'is-on')}
          title="Handwriting actions"
          aria-label="Handwriting actions"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            setShowTranscript(false);
            setMenu((v) => !v);
          }}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
      <Popover anchor={moreRef.current} open={menu} onClose={() => setMenu(false)} align="start" className="menu-pop">
        <div className="menu ink-menu" role="menu">
          {ink.length > 0 && item(<MessageCircleQuestion size={20} />, 'Ask about this…', () => editorBus.emit('block:ask', { editor, blockId: id }))}
          {ink.length > 0 && <div className="menu-sep" />}
          {transcript &&
            !transcript.stale &&
            item(<Eye size={20} />, 'Show what was read', () => setShowTranscript(true))}
          {item(<ScanText size={20} />, 'Read handwriting', () => editorBus.emit('ink:transcribe', { editor, blockId: id }))}
          {item(<Type size={20} />, 'Convert to typed text', () => editorBus.emit('ink:convert', { editor, blockId: id, to: 'text' }))}
          {item(<Sigma size={20} />, 'Convert to typeset math', () => editorBus.emit('ink:convert', { editor, blockId: id, to: 'math' }))}
          <div className="menu-sep" />
          {item(<FoldVertical size={20} />, 'Remove empty space', () => {
            trimInkBlock(editor, id, line());
            if (useTools.getState().tool === 'text') editor.commands.focus();
          })}
          {item(
            <Trash2 size={20} />,
            'Delete',
            () => {
              deleteBlock(editor, id);
              // Back in the editor, so ⌘Z undoes it straight away.
              if (useTools.getState().tool === 'text') editor.commands.focus();
            },
            undefined,
            true,
          )}
        </div>
      </Popover>

      {/* Hangs from the ⋯ like its menu, over the handwriting it describes; Esc or a click elsewhere puts it away. */}
      <Popover
        anchor={moreRef.current}
        open={showTranscript && !!transcript}
        onClose={() => setShowTranscript(false)}
        align="start"
        className="ink-transcript"
      >
        {transcript && (
          <>
            <div className="ink-transcript-label">What was read</div>
            {transcript.latex ? <div className="ink-transcript-math" dangerouslySetInnerHTML={{ __html: renderMath(transcript.latex, true) }} /> : null}
            {transcript.text && <div className="ink-transcript-text">{transcript.text}</div>}
            {transcript.description && <div className="ink-transcript-desc">{transcript.description}</div>}
          </>
        )}
      </Popover>

      <div className="ink-resize" data-ui contentEditable={false} onPointerDown={startResize} title="Drag to add or remove lines">
        <span />
      </div>
    </NodeViewWrapper>
  );
}
