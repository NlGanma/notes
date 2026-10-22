import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { GraduationCap, MoreHorizontal, MessageCircleQuestion, Type, Sigma, ScanText, Trash2, FoldVertical } from 'lucide-react';
import { useTools } from '../../state/tools';
import type { InkTranscript, Stroke } from '../../lib/ink/types';
import { deleteBlock, fittedHeight, inkOf, insertParagraphInInk, setInkBlockHeight, trimInkBlock } from '../ink/ops';
import { editorBus } from '../bus';
import { cx } from '../../lib/util';
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

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.querySelector('.ink-menu')?.contains(e.target as globalThis.Node)) setMenu(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [menu]);

  const line = () => lineHeightOf(editor.view.dom);

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

  const isMath = transcript && (transcript.kind === 'math' || transcript.kind === 'mixed');

  return (
    <NodeViewWrapper
      ref={rootRef}
      className={cx('ink-block', selected && 'is-selected', !ink.length && 'is-empty', `tool-${tool}`)}
      style={{ height: liveHeight ?? height }}
      data-ink-block=""
      data-id={id}
      onPointerDown={onPointerDown}
    >
      {!ink.length && <div className="ink-block-hint">Handwriting area — pick a pen and write, or click to type</div>}

      <div className="ink-actions" data-ui contentEditable={false}>
        {transcript && !transcript.stale && (
          <button className={cx('ink-action', showTranscript && 'is-on')} title="Show what Nib read" onClick={() => setShowTranscript((v) => !v)}>
            <ScanText size={14} />
          </button>
        )}
        <button className="ink-action" title="Ask about this handwriting" onClick={() => editorBus.emit('ink:ask', { editor, blockId: id, mode: 'explain' })}>
          <MessageCircleQuestion size={14} />
        </button>
        {(isMath || ink.length > 0) && (
          <button
            className={cx('ink-action', isMath && 'is-math')}
            title="Math tutor — guide me through this"
            onClick={() => editorBus.emit('ink:ask', { editor, blockId: id, mode: 'tutor' })}
          >
            <GraduationCap size={14} />
          </button>
        )}
        <button className={cx('ink-action', menu && 'is-on')} title="More" onClick={() => setMenu((v) => !v)}>
          <MoreHorizontal size={14} />
        </button>
        {menu && (
          <div className="menu ink-menu" role="menu">
            <button
              className="menu-item"
              onClick={() => {
                setMenu(false);
                editorBus.emit('ink:transcribe', { editor, blockId: id });
              }}
            >
              <ScanText size={15} /> Read handwriting
              <span className="menu-hint">makes it searchable</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setMenu(false);
                editorBus.emit('ink:convert', { editor, blockId: id, to: 'text' });
              }}
            >
              <Type size={15} /> Convert to typed text
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setMenu(false);
                editorBus.emit('ink:convert', { editor, blockId: id, to: 'math' });
              }}
            >
              <Sigma size={15} /> Convert to typeset math
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                setMenu(false);
                trimInkBlock(editor, id, line());
              }}
            >
              <FoldVertical size={15} /> Remove empty space
            </button>
            <button
              className="menu-item is-danger"
              onClick={() => {
                setMenu(false);
                deleteBlock(editor, id);
              }}
            >
              <Trash2 size={15} /> Delete handwriting area
            </button>
          </div>
        )}
      </div>

      {showTranscript && transcript && (
        <div className="ink-transcript" data-ui contentEditable={false}>
          <div className="ink-transcript-label">Nib read{transcript.model ? ` · ${transcript.model}` : ''}</div>
          {transcript.latex ? <div className="ink-transcript-math" dangerouslySetInnerHTML={{ __html: renderMath(transcript.latex, true) }} /> : null}
          {transcript.text && <div className="ink-transcript-text">{transcript.text}</div>}
          {transcript.description && <div className="ink-transcript-desc">{transcript.description}</div>}
        </div>
      )}

      <div className="ink-resize" data-ui contentEditable={false} onPointerDown={startResize} title="Drag to add or remove lines">
        <span />
      </div>
    </NodeViewWrapper>
  );
}
