import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Copy, CopyPlus, GraduationCap, Sigma, Sparkles, Trash2, Type } from 'lucide-react';
import type { Bounds, Stroke } from '../../lib/ink/types';
import { livePath, strokePath, strokeSvgAttrs } from '../../lib/ink/render';
import {
  boundsIntersect,
  compactPoints,
  eraseFromStroke,
  fractionInside,
  hitStroke,
  offsetBounds,
  pathLength,
  polygonBounds,
  scaleStroke,
  simplifyPoints,
  strokeBounds,
  strokeCenter,
  translateStroke,
  unionBounds,
} from '../../lib/ink/geometry';
import { recognizeShape, shapeFromDrag, straightenIfLinear } from '../../lib/ink/shapes';
import { HIGHLIGHT_COLORS, INK_COLORS } from '../../lib/ink/brushes';
import { useTools } from '../../state/tools';
import { rhythmKey } from '../extensions/rhythm';
import { appendInkBlock, appendStrokes, applyInkEdits } from './ops';
import { cx, uid } from '../../lib/util';
import { SnipAsk, type AskMode } from './SnipAsk';

const EMPTY: Stroke[] = [];

export interface BlockBox {
  id: string;
  index: number;
  type: string;
  top: number;
  height: number;
  zoneStart: number;
  zoneEnd: number;
  ink: Stroke[];
}

export interface InkLayout {
  blocks: BlockBox[];
  contentBottom: number;
}

/** Shared between the ink layer and the note editor (for "just start typing"). */
export interface InkSession {
  /** Strokes drawn since the user last typed (for inline capture). */
  recent: { blockId: string; strokeId: string }[];
  lastBlockId: string | null;
  lastBottom: number;
  lastAt: number;
}

export interface InkAskRequest {
  mode: AskMode;
  prompt?: string;
  /** PNG (base64) of exactly what is on screen, when available. */
  image?: string | null;
  /** Strokes involved, in absolute (layer) coordinates. */
  strokes: Stroke[];
  blockIds: string[];
  label: string;
}

export interface InkLayerHandle {
  layout(): InkLayout;
  clearSelection(): void;
  hasSelection(): boolean;
}

interface Props {
  editor: Editor;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  line: number;
  session: React.MutableRefObject<InkSession>;
  onAsk(req: InkAskRequest): void;
  onConvert(req: { to: 'text' | 'math'; strokes: Stroke[]; selection: SelectionItem[] }): void;
  captureRegion(clientRect: DOMRect): Promise<string | null>;
}

export interface SelectionItem {
  blockId: string;
  strokeId: string;
}

interface Selection {
  items: SelectionItem[];
  bounds: Bounds; // absolute
}

type Gesture =
  | { kind: 'draw'; id: number; stroke: Stroke; anchor: { x: number; y: number; t: number }; snapped: boolean; timer: number }
  | { kind: 'erase'; id: number; last: { x: number; y: number } | null }
  | { kind: 'lasso'; id: number; poly: number[] }
  | { kind: 'move'; id: number; sx: number; sy: number; dx: number; dy: number }
  | { kind: 'scale'; id: number; ax: number; ay: number; d0: number; s: number }
  | { kind: 'shape'; id: number; x0: number; y0: number; x1: number; y1: number; shift: boolean }
  | { kind: 'snip'; id: number; x0: number; y0: number; x1: number; y1: number };

export function measureLayout(editor: Editor): InkLayout {
  const view = editor.view;
  const pm = view.dom as HTMLElement;
  const pmTop = pm.offsetTop;
  const pads = rhythmKey.getState(view.state)?.pads ?? [];
  const blocks: BlockBox[] = [];
  let prevEnd = 0;
  view.state.doc.forEach((node, offset, index) => {
    const el = view.nodeDOM(offset);
    if (!(el instanceof HTMLElement)) return;
    const top = pmTop + el.offsetTop;
    const height = el.offsetHeight;
    const zoneEnd = top + height + (pads[index] ?? 0);
    blocks.push({
      id: (node.attrs.id as string) ?? `i${index}`,
      index,
      type: node.type.name,
      top,
      height,
      zoneStart: blocks.length ? prevEnd : Math.min(0, top),
      zoneEnd,
      ink: (node.attrs.ink as Stroke[] | null) || EMPTY,
    });
    prevEnd = zoneEnd;
  });
  return { blocks, contentBottom: prevEnd };
}

function sameLayout(a: InkLayout, b: InkLayout) {
  if (a.blocks.length !== b.blocks.length || a.contentBottom !== b.contentBottom) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    const x = a.blocks[i];
    const y = b.blocks[i];
    if (x.id !== y.id || x.top !== y.top || x.height !== y.height || x.ink !== y.ink || x.zoneEnd !== y.zoneEnd) return false;
  }
  return true;
}

export function hitBlock(layout: InkLayout, y: number): BlockBox | null {
  for (const b of layout.blocks) if (y >= b.zoneStart && y < b.zoneEnd) return b;
  return null;
}

/** Strokes of one block (memoised so typing elsewhere does not re-render ink). */
const BlockInk = memo(function BlockInk({ top, ink, hidden, highlighter }: { top: number; ink: Stroke[]; hidden: Set<string> | null; highlighter: boolean }) {
  const list = ink.filter((s) => (s.brush === 'highlighter') === highlighter && !hidden?.has(s.id));
  if (!list.length) return null;
  return (
    <g transform={`translate(0 ${top})`}>
      {list.map((s) => (
        <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} filter={s.brush === 'pencil' ? 'url(#nib-grain)' : undefined} />
      ))}
    </g>
  );
});

export const InkLayer = forwardRef<InkLayerHandle, Props>(function InkLayer(props, ref) {
  const { editor, wrapRef, scale, session } = props;
  const propsRef = useRef(props);
  propsRef.current = props;

  const [layout, setLayout] = useState<InkLayout>({ blocks: [], contentBottom: 0 });
  const layoutRef = useRef(layout);
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** Working copy of ink while erasing (block id → strokes). */
  const [erasing, setErasing] = useState<Map<string, Stroke[]> | null>(null);
  const erasingRef = useRef<Map<string, Stroke[]> | null>(null);
  const [transform, setTransform] = useState<{ dx: number; dy: number; s: number; ax: number; ay: number } | null>(null);
  const [overlay, setOverlay] = useState<{ lasso?: number[]; shape?: Stroke; snip?: Bounds } | null>(null);
  const [snip, setSnip] = useState<{ bounds: Bounds; capturing: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const gesture = useRef<Gesture | null>(null);
  const livePathRef = useRef<SVGPathElement>(null);
  const liveHlRef = useRef<SVGPathElement>(null);
  const cursorRef = useRef<SVGGElement>(null);
  const rafRef = useRef(0);
  const clipboard = useRef<Stroke[] | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  // ---------------------------------------------------------------- layout
  useEffect(() => {
    let raf = 0;
    const run = () => {
      raf = 0;
      if (editor.isDestroyed) return;
      const dom = editor.view.dom as HTMLElement;
      if (!dom.isConnected || dom.offsetParent === null) return;
      const next = measureLayout(editor);
      if (!sameLayout(layoutRef.current, next)) {
        layoutRef.current = next;
        setLayout(next);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    editor.on('transaction', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(editor.view.dom);
    schedule();
    document.fonts?.ready.then(schedule).catch(() => undefined);
    return () => {
      editor.off('transaction', schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor]);

  // Keep the selection valid when the document changes (undo, deletes…).
  useEffect(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    const items = sel.items.filter((it) => {
      const b = layout.blocks.find((x) => x.id === it.blockId);
      return b?.ink.some((s) => s.id === it.strokeId);
    });
    if (!items.length) setSelection(null);
    else if (items.length !== sel.items.length) setSelection(selectionFromItems(items, layout));
    else setSelection(selectionFromItems(items, layout));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Leaving the lasso tool clears the selection.
  const tool = useTools((s) => s.tool);
  useEffect(() => {
    if (tool !== 'lasso') setSelection(null);
    if (tool !== 'ask') setSnip(null);
    if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'eraser' && cursorRef.current) cursorRef.current.style.display = 'none';
  }, [tool]);

  useImperativeHandle(ref, () => ({
    layout: () => layoutRef.current,
    clearSelection: () => setSelection(null),
    hasSelection: () => !!selectionRef.current,
  }));

  // ---------------------------------------------------------------- helpers
  function toLocal(e: { clientX: number; clientY: number }) {
    const rect = wrapRef.current!.getBoundingClientRect();
    const s = propsRef.current.scale || 1;
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }

  function selectionFromItems(items: SelectionItem[], lay = layoutRef.current): Selection | null {
    const bounds: Bounds[] = [];
    for (const it of items) {
      const b = lay.blocks.find((x) => x.id === it.blockId);
      const s = b?.ink.find((x) => x.id === it.strokeId);
      if (b && s) bounds.push(offsetBounds(strokeBounds(s), 0, b.top));
    }
    const u = unionBounds(bounds);
    return u ? { items, bounds: u } : null;
  }

  function selectedStrokesAbs(sel: Selection | null = selectionRef.current): { stroke: Stroke; block: BlockBox }[] {
    if (!sel) return [];
    const out: { stroke: Stroke; block: BlockBox }[] = [];
    for (const it of sel.items) {
      const b = layoutRef.current.blocks.find((x) => x.id === it.blockId);
      const s = b?.ink.find((x) => x.id === it.strokeId);
      if (b && s) out.push({ stroke: translateStroke(s, 0, b.top), block: b });
    }
    return out;
  }

  function scheduleLive() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const g = gesture.current;
      if (g?.kind === 'draw') {
        const d = livePath(g.stroke);
        const isHl = g.stroke.brush === 'highlighter';
        const target = isHl ? liveHlRef.current : livePathRef.current;
        const other = isHl ? livePathRef.current : liveHlRef.current;
        other?.setAttribute('d', '');
        if (target) {
          target.setAttribute('d', d);
          const attrs = strokeSvgAttrs(g.stroke);
          if (g.stroke.brush === 'mono') {
            target.setAttribute('fill', 'none');
            target.setAttribute('stroke', g.stroke.color);
            target.setAttribute('stroke-width', String(g.stroke.size));
          } else {
            target.setAttribute('fill', g.stroke.color);
            target.removeAttribute('stroke');
          }
          target.setAttribute('opacity', String(attrs.opacity));
        }
      }
    });
  }

  function clearLive() {
    livePathRef.current?.setAttribute('d', '');
    liveHlRef.current?.setAttribute('d', '');
  }

  /** Commits a finished stroke (absolute coordinates) to the right block. */
  function commitStroke(abs: Stroke) {
    const lay = layoutRef.current;
    const { editor: ed, line: l } = propsRef.current;
    const startY = abs.pts[1];
    const center = strokeCenter(abs);
    let target = hitBlock(lay, startY) ?? hitBlock(lay, center.y);
    const last = lay.blocks[lay.blocks.length - 1];
    let blockId: string;
    let local: Stroke;
    if (!target && last && last.type === 'inkBlock' && startY - last.zoneEnd < l * 6) target = last;
    if (target) {
      local = translateStroke(abs, 0, -target.top);
      appendStrokes(ed, target.id, [local], l);
      blockId = target.id;
    } else {
      const top = lay.contentBottom;
      local = translateStroke(abs, 0, -top);
      blockId = appendInkBlock(ed, [local], l);
    }
    const s = session.current;
    s.recent.push({ blockId, strokeId: local.id });
    s.lastBlockId = blockId;
    s.lastBottom = strokeBounds(local).maxY;
    s.lastAt = Date.now();
  }

  // ---------------------------------------------------------------- erase
  function eraseAt(x: number, y: number) {
    const { eraser } = useTools.getState();
    const r = eraser.size / 2;
    const work = erasingRef.current ?? new Map<string, Stroke[]>();
    let changed = false;
    for (const b of layoutRef.current.blocks) {
      const ink = work.get(b.id) ?? b.ink;
      if (!ink.length) continue;
      const ly = y - b.top;
      if (eraser.mode === 'stroke') {
        const next = ink.filter((s) => !((!eraser.highlighterOnly || s.brush === 'highlighter') && hitStroke(s, x, ly, r)));
        if (next.length !== ink.length) {
          work.set(b.id, next);
          changed = true;
        }
      } else {
        let touched = false;
        const next: Stroke[] = [];
        for (const s of ink) {
          if (eraser.highlighterOnly && s.brush !== 'highlighter') {
            next.push(s);
            continue;
          }
          const res = eraseFromStroke(s, x, ly, r);
          if (res === null) next.push(s);
          else {
            touched = true;
            next.push(...res);
          }
        }
        if (touched) {
          work.set(b.id, next);
          changed = true;
        }
      }
    }
    if (changed) {
      erasingRef.current = work;
      setErasing(new Map(work));
    }
  }

  function eraseAlong(from: { x: number; y: number } | null, to: { x: number; y: number }) {
    const r = useTools.getState().eraser.size / 2;
    if (!from) {
      eraseAt(to.x, to.y);
      return;
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(2, r / 2)));
    for (let i = 1; i <= steps; i++) eraseAt(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }

  // ---------------------------------------------------------------- selection edits
  function commitSelectionTransform(dx: number, dy: number, s: number, ax: number, ay: number) {
    const sel = selectionRef.current;
    if (!sel) return;
    const { editor: ed, line: l } = propsRef.current;
    const lay = layoutRef.current;
    const picked = selectedStrokesAbs(sel);
    const edits = new Map<string, Stroke[]>();
    const ids = new Set(sel.items.map((i) => i.strokeId));
    for (const { block } of picked) {
      if (!edits.has(block.id))
        edits.set(
          block.id,
          block.ink.filter((st) => !ids.has(st.id)),
        );
    }
    const tail: Stroke[] = [];
    const newItems: SelectionItem[] = [];
    const lastBlock = lay.blocks[lay.blocks.length - 1];
    for (const { stroke } of picked) {
      let moved = s !== 1 ? scaleStroke(stroke, ax, ay, s) : stroke;
      moved = translateStroke(moved, dx, dy);
      const c = strokeCenter(moved);
      let target = hitBlock(lay, c.y);
      if (!target && lastBlock?.type === 'inkBlock' && c.y - lastBlock.zoneEnd < l * 6) target = lastBlock;
      if (target) {
        const list = edits.get(target.id) ?? target.ink.filter((st) => !ids.has(st.id));
        list.push(translateStroke(moved, 0, -target.top));
        edits.set(target.id, list);
        newItems.push({ blockId: target.id, strokeId: moved.id });
      } else {
        tail.push(translateStroke(moved, 0, -lay.contentBottom));
      }
    }
    applyInkEdits(ed, edits, l, tail);
    // Re-select after the layout updates (tail strokes get a new block id).
    requestAnimationFrame(() => {
      const lay2 = measureLayout(ed);
      const all: SelectionItem[] = [];
      for (const b of lay2.blocks) for (const st of b.ink) if (ids.has(st.id)) all.push({ blockId: b.id, strokeId: st.id });
      layoutRef.current = lay2;
      setLayout(lay2);
      setSelection(selectionFromItems(all.length ? all : newItems, lay2));
    });
  }

  function editSelected(fn: (s: Stroke) => Stroke | null, reselect = true) {
    const sel = selectionRef.current;
    if (!sel) return;
    const { editor: ed, line: l } = propsRef.current;
    const ids = new Set(sel.items.map((i) => i.strokeId));
    const edits = new Map<string, Stroke[]>();
    for (const b of layoutRef.current.blocks) {
      if (!b.ink.some((s) => ids.has(s.id))) continue;
      const next: Stroke[] = [];
      for (const s of b.ink) {
        if (!ids.has(s.id)) next.push(s);
        else {
          const r = fn(s);
          if (r) next.push(r);
        }
      }
      edits.set(b.id, next);
    }
    applyInkEdits(ed, edits, l);
    if (!reselect) setSelection(null);
  }

  function deleteSelection() {
    editSelected(() => null, false);
  }

  function duplicateSelection(offset = 18) {
    const picked = selectedStrokesAbs();
    if (!picked.length) return;
    pasteStrokes(
      picked.map(({ stroke }) => stroke),
      offset,
      offset,
    );
  }

  function pasteStrokes(absStrokes: Stroke[], dx: number, dy: number) {
    const { editor: ed, line: l } = propsRef.current;
    const lay = layoutRef.current;
    const edits = new Map<string, Stroke[]>();
    const tail: Stroke[] = [];
    const freshIds = new Set<string>();
    for (const st of absStrokes) {
      const moved = { ...translateStroke(st, dx, dy), id: uid('s') };
      freshIds.add(moved.id);
      const c = strokeCenter(moved);
      const target = hitBlock(lay, c.y);
      if (target) {
        const list = edits.get(target.id) ?? [...target.ink];
        list.push(translateStroke(moved, 0, -target.top));
        edits.set(target.id, list);
      } else tail.push(translateStroke(moved, 0, -lay.contentBottom));
    }
    applyInkEdits(ed, edits, l, tail);
    requestAnimationFrame(() => {
      const lay2 = measureLayout(ed);
      const items: SelectionItem[] = [];
      for (const b of lay2.blocks) for (const st of b.ink) if (freshIds.has(st.id)) items.push({ blockId: b.id, strokeId: st.id });
      layoutRef.current = lay2;
      setLayout(lay2);
      useTools.getState().setTool('lasso');
      setSelection(selectionFromItems(items, lay2));
    });
  }

  // Keyboard shortcuts for a lasso selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]') && !target.classList.contains('ProseMirror')) return;
      if (editor.isFocused) return;
      if (!wrapRef.current?.isConnected || wrapRef.current.offsetParent === null) return;
      const sel = selectionRef.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'v' && clipboard.current?.length) {
        e.preventDefault();
        const b = unionBounds(clipboard.current.map(strokeBounds))!;
        const at = lastPointer.current;
        const dx = at ? at.x - (b.minX + b.maxX) / 2 : 24;
        const dy = at ? at.y - (b.minY + b.maxY) / 2 : 24;
        pasteStrokes(clipboard.current, dx, dy);
        return;
      }
      if (!sel) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'Escape') {
        setSelection(null);
      } else if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
        e.preventDefault();
        clipboard.current = selectedStrokesAbs().map(({ stroke }) => stroke);
        if (e.key.toLowerCase() === 'x') deleteSelection();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        commitSelectionTransform(dx, dy, 1, 0, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ---------------------------------------------------------------- pointer input
  useEffect(() => {
    // Listen on the whole page surface so ink tools also work in the margins;
    // coordinates stay relative to the text column (wrapRef).
    const el = (wrapRef.current?.closest('.surface') as HTMLElement | null) ?? wrapRef.current;
    if (!el) return;

    const isUi = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('[data-ui], .math-editor, .ink-sel-menu, .snip-ask, button, input, textarea, a');

    const effectiveTool = (e: PointerEvent) => {
      const st = useTools.getState();
      if (st.tool !== 'text') return st.tool;
      if (e.pointerType === 'pen' && st.stylusDraws) return st.lastInkTool;
      return null;
    };

    const onDown = (e: PointerEvent) => {
      if (isUi(e.target)) return;
      const t = effectiveTool(e);
      if (!t) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (useTools.getState().tool !== 'text') (editor.view.dom as HTMLElement).blur();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const p = toLocal(e);
      lastPointer.current = p;
      const st = useTools.getState();
      const id = e.pointerId;

      if (t === 'pen' || t === 'highlighter') {
        const isHl = t === 'highlighter';
        const stroke: Stroke = {
          id: uid('s'),
          brush: isHl ? 'highlighter' : st.pen.brush,
          color: isHl ? st.highlighter.color : st.pen.color,
          size: isHl ? st.highlighter.size : st.pen.size,
          pts: [p.x, p.y, e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 0.5],
          pressure: e.pointerType === 'pen',
        };
        const g: Gesture = { kind: 'draw', id, stroke, anchor: { ...p, t: performance.now() }, snapped: false, timer: 0 };
        gesture.current = g;
        armHold(g);
        scheduleLive();
      } else if (t === 'eraser') {
        gesture.current = { kind: 'erase', id, last: null };
        erasingRef.current = new Map();
        eraseAlong(null, p);
        (gesture.current as Extract<Gesture, { kind: 'erase' }>).last = p;
      } else if (t === 'lasso') {
        const sel = selectionRef.current;
        if (sel) {
          const b = sel.bounds;
          const pad = 8 / (propsRef.current.scale || 1);
          const corners = [
            [b.minX, b.minY, b.maxX, b.maxY],
            [b.maxX, b.minY, b.minX, b.maxY],
            [b.minX, b.maxY, b.maxX, b.minY],
            [b.maxX, b.maxY, b.minX, b.minY],
          ];
          for (const [cx0, cy0, ax, ay] of corners) {
            if (Math.hypot(p.x - cx0, p.y - cy0) < 12 / (propsRef.current.scale || 1)) {
              gesture.current = { kind: 'scale', id, ax, ay, d0: Math.hypot(cx0 - ax, cy0 - ay) || 1, s: 1 };
              return;
            }
          }
          if (p.x > b.minX - pad && p.x < b.maxX + pad && p.y > b.minY - pad && p.y < b.maxY + pad) {
            gesture.current = { kind: 'move', id, sx: p.x, sy: p.y, dx: 0, dy: 0 };
            return;
          }
        }
        setSelection(null);
        gesture.current = { kind: 'lasso', id, poly: [p.x, p.y] };
        setOverlay({ lasso: [p.x, p.y] });
      } else if (t === 'shapes') {
        gesture.current = { kind: 'shape', id, x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
      } else if (t === 'ask') {
        setSnip(null);
        gesture.current = { kind: 'snip', id, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
    };

    const armHold = (g: Extract<Gesture, { kind: 'draw' }>) => {
      window.clearTimeout(g.timer);
      if (!useTools.getState().holdToSnap || g.stroke.brush === 'highlighter' || g.snapped) return;
      g.timer = window.setTimeout(() => {
        if (gesture.current !== g || g.snapped) return;
        if (pathLength(g.stroke.pts) < 24) return;
        const shape = recognizeShape(g.stroke.pts);
        if (!shape) return;
        g.snapped = true;
        g.stroke = { ...g.stroke, brush: 'mono', pts: shape.pts, closed: shape.closed, size: Math.max(1.2, g.stroke.size * 0.95) };
        setFlash(g.stroke.id);
        setTimeout(() => setFlash(null), 380);
        scheduleLive();
      }, 520);
    };

    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      const p = toLocal(e);
      lastPointer.current = p;
      updateCursor(e, p);
      if (!g || g.id !== e.pointerId) return;
      e.preventDefault();
      if (g.kind === 'draw') {
        if (g.snapped) return;
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = toLocal(ev);
          const pts = g.stroke.pts;
          const lx = pts[pts.length - 3];
          const ly = pts[pts.length - 2];
          if ((q.x - lx) ** 2 + (q.y - ly) ** 2 < 0.16) continue;
          pts.push(q.x, q.y, ev.pointerType === 'pen' ? Math.max(0.05, ev.pressure) : 0.5);
        }
        if (Math.hypot(p.x - g.anchor.x, p.y - g.anchor.y) > 3.5) {
          g.anchor = { ...p, t: performance.now() };
          armHold(g);
        }
        scheduleLive();
      } else if (g.kind === 'erase') {
        eraseAlong(g.last, p);
        g.last = p;
      } else if (g.kind === 'lasso') {
        g.poly.push(p.x, p.y);
        setOverlay({ lasso: g.poly.slice() });
      } else if (g.kind === 'move') {
        g.dx = p.x - g.sx;
        g.dy = p.y - g.sy;
        setTransform({ dx: g.dx, dy: g.dy, s: 1, ax: 0, ay: 0 });
      } else if (g.kind === 'scale') {
        const d = Math.hypot(p.x - g.ax, p.y - g.ay);
        g.s = Math.max(0.15, Math.min(8, d / g.d0));
        setTransform({ dx: 0, dy: 0, s: g.s, ax: g.ax, ay: g.ay });
      } else if (g.kind === 'shape') {
        g.x1 = p.x;
        g.y1 = p.y;
        g.shift = e.shiftKey;
        setOverlay({ shape: shapeStroke(g) });
      } else if (g.kind === 'snip') {
        g.x1 = p.x;
        g.y1 = p.y;
        setOverlay({
          snip: { minX: Math.min(g.x0, g.x1), minY: Math.min(g.y0, g.y1), maxX: Math.max(g.x0, g.x1), maxY: Math.max(g.y0, g.y1) },
        });
      }
    };

    const shapeStroke = (g: Extract<Gesture, { kind: 'shape' }>): Stroke => {
      const st = useTools.getState();
      const geo = shapeFromDrag(st.shape.kind, g.x0, g.y0, g.x1, g.y1, g.shift, st.pen.size);
      return { id: 'shape-preview', brush: 'mono', color: st.pen.color, size: Math.max(1.2, st.pen.size), pts: geo.pts, closed: geo.closed };
    };

    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      gesture.current = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const cancelled = e.type === 'pointercancel';
      if (g.kind === 'draw') {
        window.clearTimeout(g.timer);
        clearLive();
        if (cancelled) return;
        let stroke = g.stroke;
        if (stroke.brush !== 'mono') {
          let pts = simplifyPoints(stroke.pts, 0.5);
          if (stroke.brush === 'highlighter' && useTools.getState().highlighter.straighten) pts = straightenIfLinear(pts) ?? pts;
          stroke = { ...stroke, pts: compactPoints(pts) };
        } else stroke = { ...stroke, pts: compactPoints(stroke.pts) };
        commitStroke(stroke);
      } else if (g.kind === 'erase') {
        const work = erasingRef.current;
        erasingRef.current = null;
        setErasing(null);
        if (work && work.size && !cancelled) applyInkEdits(propsRef.current.editor, work, propsRef.current.line);
      } else if (g.kind === 'lasso') {
        setOverlay(null);
        if (cancelled) return;
        finishLasso(g.poly);
      } else if (g.kind === 'move') {
        setTransform(null);
        if (!cancelled && (Math.abs(g.dx) > 0.5 || Math.abs(g.dy) > 0.5)) commitSelectionTransform(g.dx, g.dy, 1, 0, 0);
      } else if (g.kind === 'scale') {
        setTransform(null);
        if (!cancelled && Math.abs(g.s - 1) > 0.01) commitSelectionTransform(0, 0, g.s, g.ax, g.ay);
      } else if (g.kind === 'shape') {
        setOverlay(null);
        if (cancelled || Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 4) return;
        const s = shapeStroke(g);
        commitStroke({ ...s, id: uid('s'), pts: compactPoints(s.pts) });
      } else if (g.kind === 'snip') {
        setOverlay(null);
        const b = { minX: Math.min(g.x0, g.x1), minY: Math.min(g.y0, g.y1), maxX: Math.max(g.x0, g.x1), maxY: Math.max(g.y0, g.y1) };
        if (cancelled || b.maxX - b.minX < 12 || b.maxY - b.minY < 12) return;
        setSnip({ bounds: b, capturing: false });
      }
    };

    const updateCursor = (e: PointerEvent, p: { x: number; y: number }) => {
      const c = cursorRef.current;
      if (!c) return;
      const st = useTools.getState();
      const t = st.tool;
      const show = (t === 'pen' || t === 'highlighter' || t === 'eraser') && e.pointerType !== 'touch';
      c.style.display = show ? '' : 'none';
      if (show) c.setAttribute('transform', `translate(${p.x} ${p.y})`);
    };

    const onLeave = () => {
      if (cursorRef.current) cursorRef.current.style.display = 'none';
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, wrapRef]);

  function finishLasso(poly: number[]) {
    const lay = layoutRef.current;
    const pb = polygonBounds(poly);
    const items: SelectionItem[] = [];
    const tiny = pb.maxX - pb.minX < 6 && pb.maxY - pb.minY < 6;
    if (tiny) {
      // A tap selects the stroke under the pointer.
      const x = poly[0];
      const y = poly[1];
      for (let i = lay.blocks.length - 1; i >= 0 && !items.length; i--) {
        const b = lay.blocks[i];
        for (let j = b.ink.length - 1; j >= 0; j--) {
          if (hitStroke(b.ink[j], x, y - b.top, 5)) {
            items.push({ blockId: b.id, strokeId: b.ink[j].id });
            break;
          }
        }
      }
    } else {
      for (const b of lay.blocks) {
        for (const s of b.ink) {
          const sb = offsetBounds(strokeBounds(s), 0, b.top);
          if (!boundsIntersect(sb, pb)) continue;
          const frac = fractionInside(s, poly, 0, b.top);
          const c = strokeCenter(s);
          if (frac >= 0.5 || (s.pts.length <= 9 && fractionInside({ ...s, pts: [c.x, c.y, 0.5] }, poly, 0, b.top) === 1)) {
            items.push({ blockId: b.id, strokeId: s.id });
          }
        }
      }
    }
    setSelection(items.length ? selectionFromItems(items) : null);
  }

  // ---------------------------------------------------------------- render
  const hidden = new Set<string>();
  if (transform && selection) for (const it of selection.items) hidden.add(it.strokeId);
  const hiddenOrNull = hidden.size ? hidden : null;

  const blockInk = (b: BlockBox) => (erasing?.get(b.id) ?? b.ink) as Stroke[];

  const selected = selection ? selectedStrokesAbs(selection) : [];
  const transformed = transform
    ? selected.map(({ stroke }) => {
        let s = transform.s !== 1 ? scaleStroke(stroke, transform.ax, transform.ay, transform.s) : stroke;
        if (transform.dx || transform.dy) s = translateStroke(s, transform.dx, transform.dy);
        return s;
      })
    : null;
  let selBounds = selection?.bounds ?? null;
  if (selBounds && transform) {
    selBounds = unionBounds(transformed!.map(strokeBounds)) ?? selBounds;
  }

  const st = useTools();
  const cursorR = st.tool === 'eraser' ? st.eraser.size / 2 : st.tool === 'highlighter' ? st.highlighter.size / 2 : Math.max(1.2, st.pen.size * 0.65);
  const cursorColor = st.tool === 'highlighter' ? st.highlighter.color : st.pen.color;
  const inv = 1 / (scale || 1);

  return (
    <>
      <svg className="ink-overlay ink-hl" aria-hidden>
        {layout.blocks.map((b) =>
          b.ink.length || erasing?.has(b.id) ? <BlockInk key={b.id} top={b.top} ink={blockInk(b)} hidden={hiddenOrNull} highlighter /> : null,
        )}
        {transformed
          ?.filter((s) => s.brush === 'highlighter')
          .map((s) => (
            <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} />
          ))}
        <path ref={liveHlRef} />
      </svg>
      <svg className="ink-overlay ink-pen" aria-hidden>
        <defs>
          <filter id="nib-grain" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="3" result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.25" result="mask" />
            <feComposite in="SourceGraphic" in2="mask" operator="in" />
          </filter>
          <filter id="nib-selected" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="2.2" floodColor="#2160e8" floodOpacity="0.55" />
          </filter>
        </defs>
        {layout.blocks.map((b) =>
          b.ink.length || erasing?.has(b.id) ? <BlockInk key={b.id} top={b.top} ink={blockInk(b)} hidden={hiddenOrNull} highlighter={false} /> : null,
        )}
        {selection && !transform && (
          <g filter="url(#nib-selected)" opacity="0.9">
            {selected
              .filter(({ stroke }) => stroke.brush !== 'highlighter')
              .map(({ stroke }) => (
                <path key={stroke.id} d={strokePath(stroke)} {...strokeSvgAttrs(stroke)} />
              ))}
          </g>
        )}
        {transformed
          ?.filter((s) => s.brush !== 'highlighter')
          .map((s) => (
            <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} />
          ))}
        <path ref={livePathRef} className={cx(flash && 'ink-snap-flash')} />
        {overlay?.shape && <path d={strokePath(overlay.shape)} {...strokeSvgAttrs(overlay.shape)} />}
        {overlay?.lasso && overlay.lasso.length > 3 && <polyline className="lasso-path" points={overlay.lasso.join(' ')} style={{ strokeWidth: 1.5 * inv }} />}
        {(overlay?.snip || snip) && <SnipRect b={(overlay?.snip ?? snip!.bounds) as Bounds} inv={inv} hidden={!!snip?.capturing} />}
        {selBounds && !snip && (
          <g className="sel-box" style={{ strokeWidth: inv }}>
            <rect
              x={selBounds.minX - 6 * inv}
              y={selBounds.minY - 6 * inv}
              width={selBounds.maxX - selBounds.minX + 12 * inv}
              height={selBounds.maxY - selBounds.minY + 12 * inv}
              rx={6 * inv}
            />
            {[
              [selBounds.minX, selBounds.minY],
              [selBounds.maxX, selBounds.minY],
              [selBounds.minX, selBounds.maxY],
              [selBounds.maxX, selBounds.maxY],
            ].map(([x, y], i) => (
              <circle key={i} className="sel-handle" cx={x + (i % 2 ? 6 : -6) * inv} cy={y + (i > 1 ? 6 : -6) * inv} r={5 * inv} />
            ))}
          </g>
        )}
        <g ref={cursorRef} className="ink-cursor" style={{ display: 'none' }}>
          {st.tool === 'eraser' ? (
            <circle r={cursorR} className="eraser-cursor" style={{ strokeWidth: inv }} />
          ) : (
            <circle r={cursorR} fill={cursorColor} opacity={st.tool === 'highlighter' ? 0.45 : 0.85} />
          )}
        </g>
      </svg>

      {selection && selBounds && !transform && (
        <SelectionMenu
          bounds={selBounds}
          inv={inv}
          count={selection.items.length}
          onAsk={(mode) => {
            const strokes = selectedStrokesAbs().map((x) => x.stroke);
            props.onAsk({
              mode,
              strokes,
              blockIds: [...new Set(selection.items.map((i) => i.blockId))],
              label: 'Selected handwriting',
            });
          }}
          onConvert={(to) => props.onConvert({ to, strokes: selectedStrokesAbs().map((x) => x.stroke), selection: selection.items })}
          onColor={(color) => editSelected((s) => ({ ...s, id: s.id, color }))}
          onDuplicate={() => duplicateSelection()}
          onCopy={() => {
            clipboard.current = selectedStrokesAbs().map(({ stroke }) => stroke);
          }}
          onDelete={deleteSelection}
          highlighterOnly={selected.every(({ stroke }) => stroke.brush === 'highlighter')}
        />
      )}

      {snip && !snip.capturing && (
        <SnipAsk
          bounds={snip.bounds}
          inv={inv}
          onCancel={() => setSnip(null)}
          onSubmit={async (mode, prompt) => {
            const b = snip.bounds;
            const lay = layoutRef.current;
            const strokes: Stroke[] = [];
            const blockIds: string[] = [];
            for (const blk of lay.blocks) {
              if (blk.zoneEnd < b.minY || blk.top > b.maxY) continue;
              blockIds.push(blk.id);
              for (const s of blk.ink) {
                const abs = translateStroke(s, 0, blk.top);
                if (boundsIntersect(strokeBounds(abs), b)) strokes.push(abs);
              }
            }
            setSnip({ bounds: b, capturing: true });
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            let image: string | null = null;
            try {
              const wrap = wrapRef.current!.getBoundingClientRect();
              const s = propsRef.current.scale || 1;
              const rect = new DOMRect(wrap.left + b.minX * s, wrap.top + b.minY * s, (b.maxX - b.minX) * s, (b.maxY - b.minY) * s);
              image = await propsRef.current.captureRegion(rect);
            } catch {
              image = null;
            }
            setSnip({ bounds: b, capturing: false });
            props.onAsk({ mode, prompt, image, strokes, blockIds, label: 'Area of the page' });
          }}
        />
      )}
    </>
  );
});

function SnipRect({ b, inv, hidden }: { b: Bounds; inv: number; hidden: boolean }) {
  if (hidden) return null;
  return (
    <g className="snip-rect" style={{ strokeWidth: 1.5 * inv }}>
      <rect x={b.minX} y={b.minY} width={b.maxX - b.minX} height={b.maxY - b.minY} rx={8 * inv} />
    </g>
  );
}

function SelectionMenu(props: {
  bounds: Bounds;
  inv: number;
  count: number;
  highlighterOnly: boolean;
  onAsk(mode: AskMode): void;
  onConvert(to: 'text' | 'math'): void;
  onColor(c: string): void;
  onDuplicate(): void;
  onCopy(): void;
  onDelete(): void;
}) {
  const { bounds, inv } = props;
  const colors = props.highlighterOnly ? HIGHLIGHT_COLORS.slice(0, 5) : INK_COLORS.filter((_, i) => [0, 2, 5, 7, 8, 10].includes(i));
  const top = bounds.minY - 14 * inv;
  const left = (bounds.minX + bounds.maxX) / 2;
  return (
    <div
      className="ink-sel-menu"
      data-ui
      style={{ left, top, transform: `translate(-50%, -100%) scale(${inv})`, transformOrigin: '50% 100%' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="sel-btn is-ai" onClick={() => props.onAsk('explain')} title="Ask your local AI about this">
        <Sparkles size={14} /> Ask
      </button>
      <button className="sel-btn" onClick={() => props.onAsk('tutor')} title="Guide me through this problem">
        <GraduationCap size={14} /> Tutor
      </button>
      <span className="sel-sep" />
      <button className="sel-btn icon" onClick={() => props.onConvert('text')} title="Convert to typed text">
        <Type size={14} />
      </button>
      <button className="sel-btn icon" onClick={() => props.onConvert('math')} title="Convert to typeset math">
        <Sigma size={14} />
      </button>
      <span className="sel-sep" />
      {colors.map((c) => (
        <button key={c.value} className="sel-swatch" title={c.name} onClick={() => props.onColor(c.value)}>
          <span style={{ background: c.value }} />
        </button>
      ))}
      <span className="sel-sep" />
      <button className="sel-btn icon" onClick={props.onDuplicate} title="Duplicate (⌘D)">
        <CopyPlus size={14} />
      </button>
      <button className="sel-btn icon" onClick={props.onCopy} title="Copy (⌘C)">
        <Copy size={14} />
      </button>
      <button className="sel-btn icon is-danger" onClick={props.onDelete} title="Delete (⌫)">
        <Trash2 size={14} />
      </button>
    </div>
  );
}
