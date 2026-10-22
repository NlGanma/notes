import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { InlineInkAttrs, Stroke } from '../../lib/ink/types';
import { scaleStroke, strokeBounds, translateStroke, unionBounds } from '../../lib/ink/geometry';
import { findBlock, gridCeil, inkOf, insertParagraphAfter, insertParagraphInInk, removeInlineNode, removeStrokes } from './ops';
import { inlineSpacing, wordBoundary } from './snap';
import { uid } from '../../lib/util';
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
 *  3. Drop into text — dragging handwriting onto a line of text makes it an
 *     inline sketch at that spot (see findTextDropTarget).
 */

export interface FlowContext {
  editor: Editor;
  layout: InkLayout;
  session: InkSession;
  scale: number;
  line: number;
  wrap: HTMLElement;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Inline sketch attributes for strokes (any coordinates) whose baseline is at
 * `baseline` in the same coordinates, sized for text of `fontPx`. `fit` < 1
 * shrinks the sketch so it fits the line.
 */
export function inlineSketchAttrs(strokes: Stroke[], baseline: number, fontPx: number, fit = 1): InlineInkAttrs {
  const bb = unionBounds(strokes.map(strokeBounds))!;
  return {
    strokes: strokes.map((s) => translateStroke(s, -bb.minX, -bb.minY)),
    w: round2(bb.maxX - bb.minX),
    h: round2(bb.maxY - bb.minY),
    em: round2(fontPx / fit),
    drop: round2(bb.maxY - baseline),
    transcript: null,
    fit: round2(fit),
  };
}

/**
 * Puts an inline sketch into the text at `pos`, taking its strokes off the
 * page (or the sketch out of its old place in the text) — one undo step.
 * Adds a space either side where a word would otherwise touch it, unless
 * `lead` / `trail` say otherwise. Returns the sketch's position.
 */
export function insertInlineSketch(
  editor: Editor,
  opts: {
    pos: number;
    attrs: InlineInkAttrs;
    remove?: Map<string, Set<string>>;
    removeNode?: number;
    lead?: boolean;
    trail?: boolean;
    select?: boolean;
  },
): number {
  const tr = editor.state.tr;
  if (opts.remove) removeStrokes(tr, opts.remove);
  if (opts.removeNode !== undefined) removeInlineNode(tr, opts.removeNode);
  let at = tr.mapping.map(opts.pos);
  const $at = tr.doc.resolve(at);
  const before = $at.parent.textBetween(0, $at.parentOffset, undefined, '￼');
  const after = $at.parent.textBetween($at.parentOffset, $at.parent.content.size, undefined, '￼');
  const spacing = inlineSpacing(before, after);
  if (opts.lead ?? spacing.lead) {
    tr.insertText(' ', at);
    at += 1;
  }
  tr.insert(at, editor.schema.nodes.inkInline.create(opts.attrs));
  if (opts.trail ?? spacing.trail) tr.insertText(' ', at + 1);
  if (opts.select) tr.setSelection(TextSelection.create(tr.doc, at + 1));
  closeHistory(tr);
  editor.view.dispatch(tr);
  return at;
}

/**
 * The strokes of the inline sketch at `pos`, where they are drawn on the
 * page (layer coordinates), and the baseline they sit on.
 */
export function inlineSketchStrokes(editor: Editor, wrap: HTMLElement, scale: number, pos: number): { strokes: Stroke[]; baseline: number } | null {
  const node = editor.state.doc.nodeAt(pos);
  const dom = editor.view.nodeDOM(pos);
  const svg = dom instanceof Element ? dom.querySelector('svg') : null;
  if (!node || node.type.name !== 'inkInline' || !svg) return null;
  const a = node.attrs as InlineInkAttrs;
  const pad = 2; // inlineInkBox's padding
  const r = svg.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const shown = r.width / ((Number(a.w) || 0) + pad * 2) / scale; // layer px per sketch px, as drawn in the text
  // Back to the size it was written at (it may have been shrunk to fit the line), standing where it stood.
  const k = shown / Math.min(1, Math.max(0.1, Number(a.fit) || 1));
  const h = Number(a.h) || 0;
  const drop = Number(a.drop) || 0;
  const x0 = (r.left - wr.left) / scale + pad * shown;
  const baseline = (r.top - wr.top) / scale + (pad + h - drop) * shown;
  const y0 = baseline - (h - drop) * k;
  const strokes = (a.strokes as Stroke[]).map((s) => ({ ...translateStroke(scaleStroke(s, 0, 0, k), x0, y0), id: uid('s') }));
  return { strokes, baseline };
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
  // Keeps the sketch where it was written relative to the text (a raised "2" stays raised).
  const baseline = (endRect.bottom - 0.22 * fontPx * scale - wr.top) / scale - block.top;
  const textBefore = $pos.parent.textContent;
  const gapPx = (left - endRect.left) / scale;
  insertInlineSketch(editor, {
    pos: end,
    attrs: inlineSketchAttrs(strokes, baseline, fontPx),
    remove: new Map([[block.id, ids]]),
    lead: !!textBefore.length && !/\s$/.test(textBefore) && gapPx > fontPx * 0.45,
    select: true,
  });
  session.recent = [];
  return true;
}

// ------------------------------------------------------------------ drop into text

/** A spot in the text where a dragged sketch would land, in layer coordinates. */
export interface TextDropTarget {
  pos: number;
  /** The insertion caret. */
  x: number;
  top: number;
  bottom: number;
  baseline: number;
  fontPx: number;
  /** Room in the line above and below the baseline, so the sketch doesn't make the line taller. */
  roomAbove: number;
  roomBelow: number;
}

const metricsCache = new Map<string, { ascent: number; descent: number }>();
let measureCtx: CanvasRenderingContext2D | null = null;

function fontMetrics(el: Element): { ascent: number; descent: number; size: number } {
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize) || 16;
  const font = cs.font || `${size}px ${cs.fontFamily}`;
  let m = metricsCache.get(font);
  if (!m) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    let t: TextMetrics | null = null;
    if (measureCtx) {
      measureCtx.font = font;
      t = measureCtx.measureText('Hg');
    }
    m = t?.fontBoundingBoxAscent ? { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent } : { ascent: size * 0.95, descent: size * 0.25 };
    metricsCache.set(font, m);
  }
  return { ...m, size };
}

/**
 * Where a sketch dragged to `probe` (its left edge, at its body's height;
 * layer coordinates) would go into the text: on a line of typed text, within
 * it or just after its end, between two words. Null when it isn't over text.
 */
export function findTextDropTarget(editor: Editor, wrap: HTMLElement, scale: number, probe: { x: number; y: number }): TextDropTarget | null {
  const view = editor.view;
  const wr = wrap.getBoundingClientRect();
  const cx = wr.left + probe.x * scale;
  const cy = wr.top + probe.y * scale;
  const hit = view.posAtCoords({ left: cx, top: cy });
  if (!hit) return null;
  const doc = editor.state.doc;
  const $hit = doc.resolve(hit.pos);
  const parent = $hit.parent;
  if (!parent.isTextblock || parent.type.spec.code || !parent.textContent.trim()) return null;
  if (!parent.canReplaceWith($hit.index(), $hit.index(), editor.schema.nodes.inkInline)) return null;
  const r0 = view.coordsAtPos(hit.pos);
  const el0 = view.domAtPos(hit.pos).node;
  const m = fontMetrics(el0 instanceof Element ? el0 : (el0.parentElement ?? view.dom));
  // On this line of text (not between two lines), and not far past its end or before its start.
  if (cy < r0.top - 4 * scale || cy > r0.bottom + 4 * scale) return null;
  if (Math.abs(cx - r0.left) > m.size * 2 * scale) return null;

  const start = $hit.start();
  const text = doc.textBetween(start, $hit.end(), undefined, '￼');
  const off = wordBoundary(text, hit.pos - start);
  const pos = start + off;
  // Stay on the same visual line when the word boundary sits at a line wrap.
  const r = pos === hit.pos ? r0 : view.coordsAtPos(pos, pos < hit.pos ? 1 : -1);
  const el = view.domAtPos(pos).node;
  const lineHeight = parseFloat(getComputedStyle(el instanceof Element ? el : (el.parentElement ?? view.dom)).lineHeight) || m.size * 1.5;
  // The caret box is centred on the line, and so is the font's ascent + descent.
  const mid = ((r.top + r.bottom) / 2 - wr.top) / scale;
  const baseline = mid + (m.ascent - m.descent) / 2;
  const lineTop = mid - lineHeight / 2;
  return {
    pos,
    x: (r.left - wr.left) / scale,
    top: (r.top - wr.top) / scale,
    bottom: (r.bottom - wr.top) / scale,
    baseline,
    fontPx: m.size,
    roomAbove: baseline - lineTop - 0.5,
    roomBelow: lineTop + lineHeight - baseline - 0.5,
  };
}

/**
 * Top-level blocks whose typed letters a box (layer coordinates) would cover.
 * Only the letters count, so ink beside a short line, on an empty line, on a
 * handwriting area or on an image or equation is fine.
 */
export function textBlocksUnder(editor: Editor, wrap: HTMLElement, scale: number, box: { minX: number; minY: number; maxX: number; maxY: number }): number[] {
  const view = editor.view;
  const wr = wrap.getBoundingClientRect();
  const out: number[] = [];
  view.state.doc.forEach((node, offset, index) => {
    if (node.type.name === 'inkBlock' || !node.textContent.trim()) return;
    const el = view.nodeDOM(offset);
    if (!(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    if ((r.bottom - wr.top) / scale < box.minY || (r.top - wr.top) / scale > box.maxY) return;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!t.textContent?.trim()) continue;
      range.selectNodeContents(t);
      for (const q of range.getClientRects()) {
        const minX = (q.left - wr.left) / scale;
        const maxX = (q.right - wr.left) / scale;
        const minY = (q.top - wr.top) / scale;
        const maxY = (q.bottom - wr.top) / scale;
        if (minX < box.maxX - 1 && maxX > box.minX + 1 && minY < box.maxY - 1 && maxY > box.minY + 1) {
          out.push(index);
          return;
        }
      }
    }
  });
  return out;
}

/**
 * Where the next word would start on the line of text at height `y` (layer
 * coordinates): a dragged drawing can line up after it. Null if no text there.
 */
export function textLineEnd(editor: Editor, wrap: HTMLElement, scale: number, y: number): number | null {
  const view = editor.view;
  const wr = wrap.getBoundingClientRect();
  const cy = wr.top + y * scale;
  const hit = view.posAtCoords({ left: wr.right - 2, top: cy });
  if (!hit) return null;
  const $pos = editor.state.doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock || !$pos.parent.textContent.trim()) return null;
  const r = view.coordsAtPos(hit.pos);
  if (cy < r.top - 4 * scale || cy > r.bottom + 4 * scale) return null;
  const el = view.domAtPos(hit.pos).node;
  const size = parseFloat(getComputedStyle(el instanceof Element ? el : (el.parentElement ?? view.dom)).fontSize) || 16;
  return (r.left - wr.left) / scale + size * 0.3;
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
