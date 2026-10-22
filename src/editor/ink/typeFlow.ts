import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { InlineInkAttrs, Stroke } from '../../lib/ink/types';
import { strokeBounds, translateStroke, unionBounds } from '../../lib/ink/geometry';
import { findBlock, gridCeil, inkOf, insertParagraphAfter, insertParagraphInInk } from './ops';
import type { InkLayout, InkSession } from './InkLayer';
import { useTools } from '../../state/tools';

/**
 * The "seamless" hand-off between handwriting and typing.
 *
 *  1. Inline capture — if you handwrite a symbol just after the end of a
 *     typed line and then keep typing, the strokes become an inline sketch
 *     inside that sentence (scaled to the font and sitting on the baseline),
 *     and your typing continues after it.
 *  2. Type-after-ink — if you were writing in a handwriting area and simply
 *     start typing, the text lands on the ruled line right below what you
 *     just wrote (the area is split there; nothing else on the page moves).
 */

export interface FlowContext {
  editor: Editor;
  layout: InkLayout;
  session: InkSession;
  scale: number;
  line: number;
  wrap: HTMLElement;
}

/** Returns true if recent strokes were folded into the text as an inline sketch. */
export function captureInlineSketch(ctx: FlowContext, opts: { onlyIfCaretThere?: boolean } = {}): boolean {
  const { editor, layout, session, scale, line, wrap } = ctx;
  const recent = session.recent;
  if (!recent.length) return false;
  const last = recent[recent.length - 1];
  const block = layout.blocks.find((b) => b.id === last.blockId);
  if (!block || block.type === 'inkBlock' || block.type === 'mathBlock' || block.type === 'image') return false;
  // Read strokes from the live document: the layout snapshot refreshes a frame
  // later, so a stroke finished just before typing may not be in it yet.
  const live = findBlock(editor.state.doc, block.id);
  if (!live) return false;
  const ids = new Set(recent.filter((r) => r.blockId === block.id).map((r) => r.strokeId));
  const strokes = (inkOf(live.node) as Stroke[]).filter((s) => ids.has(s.id));
  if (!strokes.length) return false;
  const bb = unionBounds(strokes.map(strokeBounds));
  if (!bb) return false;
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  if (h > line * 2.4 || w > 420) return false;

  const wr = wrap.getBoundingClientRect();
  const left = wr.left + bb.minX * scale;
  const top = wr.top + (bb.minY + block.top) * scale;
  const bottom = wr.top + (bb.maxY + block.top) * scale;
  const cy = (top + bottom) / 2;
  const view = editor.view;
  const hit = view.posAtCoords({ left: Math.max(wr.left + 1, left - 3), top: cy });
  if (!hit) return false;
  const $pos = editor.state.doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  const end = $pos.end();
  const endRect = view.coordsAtPos(end);
  const tol = line * scale * 0.7;
  if (cy < endRect.top - tol || cy > endRect.bottom + tol) return false;
  if (left < endRect.left - 6 * scale) return false;
  if (opts.onlyIfCaretThere) {
    const sel = editor.state.selection;
    if (!sel.empty || sel.$from.parent !== $pos.parent) return false;
  }

  const textEl = view.nodeDOM($pos.before()) as HTMLElement | null;
  const fontPx = parseFloat(getComputedStyle(textEl instanceof HTMLElement ? textEl : (view.dom as HTMLElement)).fontSize) || 16;
  const baseline = endRect.bottom - 0.22 * fontPx * scale;
  const drop = (bottom - baseline) / scale;
  const attrs: InlineInkAttrs = {
    strokes: strokes.map((s) => translateStroke(s, -bb.minX, -bb.minY)),
    w: Math.round(w * 100) / 100,
    h: Math.round(h * 100) / 100,
    em: fontPx,
    drop: Math.round(drop * 100) / 100,
    transcript: null,
  };

  const remaining = (inkOf(live.node) as Stroke[]).filter((s) => !ids.has(s.id));
  const tr = editor.state.tr.setNodeAttribute(live.pos, 'ink', remaining.length ? remaining : null);
  const textBefore = $pos.parent.textContent;
  const gapPx = (left - endRect.left) / scale;
  let at = end;
  if (textBefore.length && !/\s$/.test(textBefore) && gapPx > fontPx * 0.45) {
    tr.insertText(' ', at);
    at += 1;
  }
  tr.insert(at, editor.schema.nodes.inkInline.create(attrs));
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  closeHistory(tr);
  view.dispatch(tr);
  session.recent = [];
  return true;
}

/** Starts typing after handwriting (see module comment). */
export function startTypingFromInk(ctx: FlowContext, text: string) {
  const { editor, session, line } = ctx;
  useTools.getState().setTool('text');
  if (captureInlineSketch(ctx)) {
    if (text) editor.view.dispatch(editor.state.tr.insertText(text));
    editor.view.focus();
    return;
  }
  const lastId = session.lastBlockId;
  const found = lastId ? findBlock(editor.state.doc, lastId) : null;
  if (found && found.node.type.name === 'inkBlock') {
    insertParagraphInInk(editor, lastId!, gridCeil(session.lastBottom + 2, line) + 1, line, text);
  } else if (found) {
    insertParagraphAfter(editor, lastId, text);
  } else {
    const doc = editor.state.doc;
    const lastNode = doc.lastChild;
    if (lastNode && lastNode.type.name === 'paragraph' && lastNode.content.size === 0) {
      const pos = doc.content.size - 1;
      const tr = editor.state.tr.setSelection(TextSelection.create(doc, pos));
      if (text) tr.insertText(text);
      editor.view.dispatch(tr.scrollIntoView());
    } else {
      insertParagraphAfter(editor, null, text);
    }
  }
  session.recent = [];
  editor.view.focus();
}
