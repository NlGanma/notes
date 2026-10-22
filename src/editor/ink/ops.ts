import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { Stroke } from '../../lib/ink/types';
import { strokeBounds, strokeCenter, translateStroke } from '../../lib/ink/geometry';
import { uid } from '../../lib/util';

/**
 * All edits to ink go through these helpers so that strokes, handwriting
 * areas and text live in one ProseMirror transaction history.
 */

export interface FoundBlock {
  node: PMNode;
  pos: number;
  index: number;
}

export function findBlock(doc: PMNode, id: string): FoundBlock | null {
  let found: FoundBlock | null = null;
  doc.forEach((node, pos, index) => {
    if (!found && node.attrs.id === id) found = { node, pos, index };
  });
  return found;
}

export function inkOf(node: PMNode | null | undefined): Stroke[] {
  return ((node?.attrs.ink as Stroke[] | null) ?? []) as Stroke[];
}

export const gridCeil = (v: number, line: number) => Math.ceil(v / line - 1e-6) * line;
export const gridFloor = (v: number, line: number) => Math.floor(v / line + 1e-6) * line;

export function inkBottom(strokes: Stroke[]): number {
  let b = 0;
  for (const s of strokes) b = Math.max(b, strokeBounds(s).maxY);
  return b;
}

/** Height an ink block needs so there is always a free line below the last stroke. */
export function grownHeight(current: number, strokes: Stroke[], line: number): number {
  return Math.max(current, gridCeil(inkBottom(strokes) + line * 0.9, line), line);
}

/** Handwriting may dip this far into the next ruled line (descenders) without taking it over. */
export const DESCENDER_ALLOWANCE = 9;

/** Height that just fits the strokes (used when text is inserted below). */
export function fittedHeight(strokes: Stroke[], line: number): number {
  return Math.max(line, gridCeil(inkBottom(strokes) - DESCENDER_ALLOWANCE, line));
}

function dispatch(editor: Editor, tr: Transaction, separateUndo = true) {
  if (separateUndo) closeHistory(tr);
  editor.view.dispatch(tr);
}

/** Adds strokes (already in block-local coordinates) to a block. */
export function appendStrokes(editor: Editor, blockId: string, strokes: Stroke[], line: number) {
  const { state } = editor;
  const found = findBlock(state.doc, blockId);
  if (!found) return;
  const ink = [...inkOf(found.node), ...strokes];
  const tr = state.tr.setNodeAttribute(found.pos, 'ink', ink);
  if (found.node.type.name === 'inkBlock') {
    const h = grownHeight(found.node.attrs.height as number, ink, line);
    if (h !== found.node.attrs.height) tr.setNodeAttribute(found.pos, 'height', h);
    if (found.node.attrs.transcript) tr.setNodeAttribute(found.pos, 'transcript', { ...found.node.attrs.transcript, stale: true });
  }
  dispatch(editor, tr);
}

export function createInkBlockNode(editor: Editor, strokes: Stroke[], line: number, height?: number): PMNode {
  return editor.schema.nodes.inkBlock.create({
    id: uid('b'),
    ink: strokes,
    height: height ?? grownHeight(line * 2, strokes, line),
  });
}

/** Appends a new handwriting area at the end of the document. */
export function appendInkBlock(editor: Editor, strokes: Stroke[], line: number): string {
  const node = createInkBlockNode(editor, strokes, line);
  const tr = editor.state.tr.insert(editor.state.doc.content.size, node);
  dispatch(editor, tr);
  return node.attrs.id as string;
}

/**
 * Replaces ink on several blocks at once and optionally appends new ink
 * blocks — one undo step (used by the eraser and lasso moves).
 */
export function applyInkEdits(editor: Editor, edits: Map<string, Stroke[]>, line: number, newBlockStrokes?: Stroke[]) {
  const { state } = editor;
  const tr = state.tr;
  state.doc.forEach((node, pos) => {
    const id = node.attrs.id as string;
    if (!id || !edits.has(id)) return;
    const ink = edits.get(id)!;
    tr.setNodeAttribute(pos, 'ink', ink.length ? ink : null);
    if (node.type.name === 'inkBlock') {
      // Edits (erase, move, recolour) only grow an area if ink now overflows it.
      const h = Math.max(node.attrs.height as number, gridCeil(inkBottom(ink) - DESCENDER_ALLOWANCE, line));
      if (h !== node.attrs.height) tr.setNodeAttribute(pos, 'height', h);
      if (node.attrs.transcript) tr.setNodeAttribute(pos, 'transcript', { ...node.attrs.transcript, stale: true });
    }
  });
  if (newBlockStrokes?.length) tr.insert(tr.doc.content.size, createInkBlockNode(editor, newBlockStrokes, line));
  if (tr.docChanged) dispatch(editor, tr);
}

/**
 * Splits a handwriting area at `y` (block-local) and inserts an empty
 * paragraph there, so typed text can go between lines of handwriting.
 * If the ruled line at `y` is empty it is consumed by the paragraph, so
 * nothing on the page moves. Returns the caret position inside the paragraph.
 */
export function insertParagraphInInk(editor: Editor, blockId: string, y: number, line: number, text = ''): number | null {
  const { state } = editor;
  const found = findBlock(state.doc, blockId);
  if (!found || found.node.type.name !== 'inkBlock') return null;
  const { node, pos } = found;
  const ink = inkOf(node);
  const height = node.attrs.height as number;
  let top = Math.max(0, gridFloor(Math.min(y, height - 1), line));
  const bandBusy = ink.some((s) => {
    const b = strokeBounds(s);
    return b.maxY > top + 3 && b.minY < top + line - 3;
  });
  let consume = 0;
  if (bandBusy) {
    // Split at the nearest line boundary instead.
    top = Math.min(height, Math.max(0, Math.round(y / line) * line));
  } else {
    consume = Math.min(line, height - top);
  }
  const cut = top + consume;
  const upper = ink.filter((s) => strokeCenter(s).y < top);
  const lowerRaw = ink.filter((s) => strokeCenter(s).y >= top);
  const lower = lowerRaw.map((s) => translateStroke(s, 0, -cut));
  const lowerHeight = height - cut;

  const schema = editor.schema;
  const para = schema.nodes.paragraph.create({ id: uid('b') }, text ? schema.text(text) : undefined);
  const nodes: PMNode[] = [];
  if (top > 0) nodes.push(schema.nodes.inkBlock.create({ ...node.attrs, ink: upper.length ? upper : null, height: top, transcript: null }));
  nodes.push(para);
  if (lowerHeight >= line && (lower.length || lowerHeight >= line * 2)) {
    nodes.push(
      schema.nodes.inkBlock.create({
        id: uid('b'),
        ink: lower.length ? lower : null,
        height: Math.max(line, Math.round(lowerHeight / line) * line),
        transcript: null,
      }),
    );
  }
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, nodes);
  const paraStart = pos + (top > 0 ? nodes[0].nodeSize : 0) + 1;
  tr.setSelection(TextSelection.create(tr.doc, paraStart + text.length));
  dispatch(editor, tr.scrollIntoView());
  return paraStart;
}

/** Inserts an empty paragraph right after a block and puts the caret in it. */
export function insertParagraphAfter(editor: Editor, blockId: string | null, text = ''): number {
  const { state } = editor;
  const schema = editor.schema;
  const found = blockId ? findBlock(state.doc, blockId) : null;
  const at = found ? found.pos + found.node.nodeSize : state.doc.content.size;
  const para = schema.nodes.paragraph.create({ id: uid('b') }, text ? schema.text(text) : undefined);
  const tr = state.tr.insert(at, para);
  tr.setSelection(TextSelection.create(tr.doc, at + 1 + text.length));
  dispatch(editor, tr.scrollIntoView());
  return at + 1;
}

export function setInkBlockHeight(editor: Editor, blockId: string, height: number) {
  const found = findBlock(editor.state.doc, blockId);
  if (!found) return;
  const tr = editor.state.tr.setNodeAttribute(found.pos, 'height', Math.max(16, Math.round(height)));
  dispatch(editor, tr);
}

/** Shrinks a handwriting area to fit its strokes (removes trailing blank lines). */
export function trimInkBlock(editor: Editor, blockId: string, line: number) {
  const found = findBlock(editor.state.doc, blockId);
  if (!found) return;
  const ink = inkOf(found.node);
  if (!ink.length) {
    deleteBlock(editor, blockId);
    return;
  }
  // Also remove blank space above the first stroke.
  let top = Infinity;
  for (const s of ink) top = Math.min(top, strokeBounds(s).minY);
  const shift = Math.max(0, gridFloor(top - 4, line));
  const moved = shift ? ink.map((s) => translateStroke(s, 0, -shift)) : ink;
  const tr = editor.state.tr.setNodeAttribute(found.pos, 'ink', moved).setNodeAttribute(found.pos, 'height', fittedHeight(moved, line) + line);
  dispatch(editor, tr);
}

export function deleteBlock(editor: Editor, blockId: string) {
  const found = findBlock(editor.state.doc, blockId);
  if (!found) return;
  const tr = editor.state.tr.delete(found.pos, found.pos + found.node.nodeSize);
  if (tr.doc.childCount === 0) tr.insert(0, editor.schema.nodes.paragraph.create());
  dispatch(editor, tr);
}

/** Replaces a block with other content (used by ink → text / math conversion). */
export function replaceBlockWith(editor: Editor, blockId: string, nodes: PMNode[], keepOriginal = false) {
  const found = findBlock(editor.state.doc, blockId);
  if (!found) return;
  const end = found.pos + found.node.nodeSize;
  const tr = keepOriginal ? editor.state.tr.insert(end, nodes) : editor.state.tr.replaceWith(found.pos, end, nodes);
  dispatch(editor, tr);
}

export function setTranscript(editor: Editor, blockId: string, transcript: unknown) {
  const found = findBlock(editor.state.doc, blockId);
  if (!found) return;
  const tr = editor.state.tr.setNodeAttribute(found.pos, 'transcript', transcript).setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
