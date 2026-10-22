import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useMemo } from 'react';
import type { InlineInkAttrs, Stroke } from '../../lib/ink/types';
import { strokePath, strokeSvgAttrs } from '../../lib/ink/render';
import { editorBus } from '../bus';
import { useTools } from '../../state/tools';
import { cx } from '../../lib/util';

/** Geometry for rendering an inline sketch at the current font size. */
export function inlineInkBox(a: InlineInkAttrs) {
  const pad = 2;
  return {
    viewBox: `${-pad} ${-pad} ${a.w + pad * 2} ${a.h + pad * 2}`,
    width: `${(a.w + pad * 2) / a.em}em`,
    height: `${(a.h + pad * 2) / a.em}em`,
    verticalAlign: `${-(a.drop + pad) / a.em}em`,
  };
}

export const InkInline = Node.create({
  name: 'inkInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    const json = (name: string, fallback: unknown) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => {
        const raw = el.getAttribute(`data-${name}`);
        if (raw == null) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: JSON.stringify(attrs[name]) }),
    });
    return {
      strokes: json('strokes', []),
      w: json('w', 10),
      h: json('h', 10),
      em: json('em', 16),
      drop: json('drop', 0),
      transcript: json('transcript', null),
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="ink-inline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'ink-inline' })];
  },

  renderText({ node }) {
    return node.attrs.transcript ? String(node.attrs.transcript) : '[sketch]';
  },

  addNodeView() {
    return ReactNodeViewRenderer(InkInlineView, { as: 'span', className: 'ink-inline-node' });
  },
});

function InkInlineView({ node, editor, selected, getPos }: ReactNodeViewProps) {
  const attrs = node.attrs as InlineInkAttrs;
  const box = useMemo(() => inlineInkBox(attrs), [attrs]);
  const strokes = attrs.strokes as Stroke[];
  return (
    <NodeViewWrapper
      as="span"
      className={cx('ink-inline', selected && 'is-selected')}
      title={attrs.transcript ? `Sketch · reads as “${attrs.transcript}” — click to edit` : 'Sketch — click to edit'}
      onClick={(e: React.MouseEvent) => {
        if (useTools.getState().tool !== 'text') return;
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos === 'number') editorBus.emit('inlineInk:open', { editor, pos });
      }}
    >
      <svg viewBox={box.viewBox} style={{ width: box.width, height: box.height, verticalAlign: box.verticalAlign }} aria-label={attrs.transcript ?? 'sketch'}>
        {strokes
          .filter((s) => s.brush === 'highlighter')
          .map((s) => (
            <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} style={{ mixBlendMode: 'multiply' }} />
          ))}
        {strokes
          .filter((s) => s.brush !== 'highlighter')
          .map((s) => (
            <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} />
          ))}
      </svg>
    </NodeViewWrapper>
  );
}
