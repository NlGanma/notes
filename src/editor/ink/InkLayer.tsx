import { forwardRef, memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { Copy, CopyPlus, GraduationCap, Sigma, MessageCircleQuestion, Trash2, Type } from 'lucide-react';
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
import { useInkHint, useTools } from '../../state/tools';
import { isElectron } from '../../lib/platform';
import { rhythmKey } from '../extensions/rhythm';
import type { Transaction } from '@tiptap/pm/state';
import { appendInkBlock, appendStrokes, applyInkEdits, gridCeil, inkOf, insertInkArea, removeInlineNode, removeStrokes } from './ops';
import {
  autoscrollSpeed,
  descenderAllowance,
  estimateBaseline,
  fitInline,
  frameCorners,
  hitSelection,
  isLoop,
  pageBlobs,
  rawBounds,
  resolveDropTarget,
  ruleY,
  selectionFrame,
  snapMove,
  strokeAt,
  type PlacedStroke,
  type SnapResult,
  type SnapTarget,
} from './snap';
import {
  findTextDropTarget,
  inlineSketchAttrs,
  inlineSketchStrokes,
  insertInlineSketch,
  textBlocksUnder,
  textLineEnd,
  type TextDropTarget,
} from './typeFlow';
import { cx, uid } from '../../lib/util';
import { SnipAsk, type AskMode } from './SnipAsk';

const EMPTY: Stroke[] = [];

/** How far (screen px) a press on ink must travel before it becomes a drag; less is a tap. */
const DRAG_START = 3;
/** How close (screen px) a dragged blob's edge must come to the margin or other writing to line up with it. */
const SNAP = 7;
const DROP_HINT = 'Release to put it in the text · ⌥ keeps it as ink';
const ROOM_HINT = 'Release to make room for it here · ⌥ places it on top';

const isUi = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('[data-ui], .math-editor, .ink-sel-menu, .snip-ask, button, input, textarea, a');

/** Copied handwriting, shared by all notes so you can copy in one and paste in another. */
let clipboard: Stroke[] | null = null;

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
  /** Turns the inline sketch at `pos` back into handwriting where it is, selected. */
  popOut(pos: number): void;
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

type Pt = { x: number; y: number };

/** What a drag knows about the selection it carries, from when it started. */
interface Carried {
  box: Bounds;
  baseline: number | null;
  /** Small enough to drop into a line of text. */
  inline: boolean;
  /** The line of text it started on (its top), if any: nudging a note written on the text keeps it a note. */
  home: number | null;
  /** May sit on typed text: a highlight, a circle or box around words, an underline, or a note already on the text. */
  overlay: boolean;
  /** Left edges of the other handwriting it can line up with, and the ruled line each sits on. */
  aligns: { x: number; k: number; top: number; bottom: number }[];
  /** The page's edges (layer coordinates): dragged ink stays on the paper. */
  limits: { left: number; right: number; bottom: number };
}

/**
 * Where a drag would put the ink: snapped onto the page, into a line of text,
 * into the handwriting area next to the text it would have covered (`into`),
 * or into new lines it makes between two blocks of text (`room`).
 */
interface DropPlan {
  snap: SnapResult;
  text: TextDropTarget | null;
  room: { index: number; y: number; dy: number; height: number } | null;
  into: string | null;
}

type Gesture =
  | { kind: 'draw'; id: number; stroke: Stroke; anchor: { x: number; y: number; t: number }; snapped: boolean; timer: number }
  | { kind: 'erase'; id: number; last: { x: number; y: number } | null }
  | { kind: 'lasso'; id: number; poly: number[]; client: Pt }
  | {
      kind: 'move';
      id: number;
      sx: number;
      sy: number;
      dx: number;
      dy: number;
      moved: boolean;
      client: Pt;
      alt: boolean;
      carried: Carried;
      /** A sketch being pulled out of the text (its strokes in layer coordinates) rather than the selection. */
      popped?: { pos: number; dom: HTMLElement; strokes: Stroke[] };
    }
  | { kind: 'scale'; id: number; ax: number; ay: number; d0: number; s: number; moved: boolean; client: Pt }
  | { kind: 'shape'; id: number; x0: number; y0: number; x1: number; y1: number; shift: boolean }
  | { kind: 'snip'; id: number; x0: number; y0: number; x1: number; y1: number };

type MoveGesture = Extract<Gesture, { kind: 'move' }>;

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

/** Every stroke on the page with the top of its block (cached per layout). */
const placedCache = new WeakMap<InkLayout, { items: PlacedStroke[]; keys: SelectionItem[] }>();
function placedAll(lay: InkLayout) {
  let p = placedCache.get(lay);
  if (!p) {
    p = { items: [], keys: [] };
    for (const b of lay.blocks)
      for (const s of b.ink) {
        p.items.push({ stroke: s, top: b.top });
        p.keys.push({ blockId: b.id, strokeId: s.id });
      }
    placedCache.set(lay, p);
  }
  return p;
}

/** The page's blobs (words, symbols, drawings), worked out once per layout. */
const blobsCache = new WeakMap<InkLayout, ReturnType<typeof pageBlobs>>();
function blobsOf(lay: InkLayout, line: number) {
  let b = blobsCache.get(lay);
  if (!b) blobsCache.set(lay, (b = pageBlobs(placedAll(lay).items, line)));
  return b;
}

/** Strokes of one block (memoised so typing elsewhere does not re-render ink). */
const BlockInk = memo(function BlockInk({
  top,
  ink,
  hidden,
  highlighter,
  grain,
}: {
  top: number;
  ink: Stroke[];
  hidden: Set<string> | null;
  highlighter: boolean;
  grain: string;
}) {
  const list = ink.filter((s) => (s.brush === 'highlighter') === highlighter && !hidden?.has(s.id));
  if (!list.length) return null;
  return (
    <g transform={`translate(0 ${top})`}>
      {list.map((s) => (
        <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} filter={s.brush === 'pencil' ? `url(#${grain})` : undefined} />
      ))}
    </g>
  );
});

export const InkLayer = forwardRef<InkLayerHandle, Props>(function InkLayer(props, ref) {
  const { editor, wrapRef, scale, session } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  // Filter ids per note: url(#id) finds the first match in the whole window,
  // and a match inside a hidden note's layer draws nothing.
  const uidPart = useId().replace(/[^\w-]/g, '');
  const ids = { grain: `nib-grain-${uidPart}`, selected: `nib-selected-${uidPart}`, lifted: `nib-lifted-${uidPart}` };

  const [layout, setLayout] = useState<InkLayout>({ blocks: [], contentBottom: 0 });
  const layoutRef = useRef(layout);
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const selectionRef = useRef(selection);
  // The ref changes at once, so a press can select a blob and start dragging it in one go.
  const setSelection = (s: Selection | null) => {
    selectionRef.current = s;
    setSelectionState(s);
  };
  /** Working copy of ink while erasing (block id → strokes). */
  const [erasing, setErasing] = useState<Map<string, Stroke[]> | null>(null);
  const erasingRef = useRef<Map<string, Stroke[]> | null>(null);
  /** A press on the selection ('press': hide the menu) or a drag that is moving it ('drag'). */
  const [held, setHeld] = useState<'press' | 'drag' | null>(null);
  /** Strokes of a sketch being dragged out of the text. */
  const [popped, setPopped] = useState<Stroke[] | null>(null);
  /** Just dropped: the menu waits for a tap, so it doesn't cover the next thing you reach for. */
  const [quiet, setQuiet] = useState(false);
  const [overlay, setOverlay] = useState<{ lasso?: number[]; shape?: Stroke; snip?: Bounds } | null>(null);
  const [snip, setSnip] = useState<{ bounds: Bounds; capturing: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const gesture = useRef<Gesture | null>(null);
  const livePathRef = useRef<SVGPathElement>(null);
  const liveHlRef = useRef<SVGPathElement>(null);
  const cursorRef = useRef<SVGGElement>(null);
  const rafRef = useRef(0);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // Drag preview: moved with a transform, never re-rendered while dragging.
  const dragPenRef = useRef<SVGGElement>(null);
  const dragHlRef = useRef<SVGGElement>(null);
  const dragBoxRef = useRef<SVGRectElement>(null);
  const ruleRef = useRef<SVGLineElement>(null);
  const baseRef = useRef<SVGLineElement>(null);
  const edgeRef = useRef<SVGLineElement>(null);
  const caretRef = useRef<SVGPathElement>(null);
  const roomRef = useRef<SVGRectElement>(null);
  const roomLineRef = useRef<SVGLineElement>(null);
  const paintRaf = useRef(0);
  const autoRaf = useRef(0);
  const lastNudge = useRef<{ at: number; doc: unknown } | null>(null);
  /** The pointer's look over the page ('grab', 'grabbing', resize arrows) and what it was last over. */
  const cursorKind = useRef<string | null>(null);
  const hover = useRef<{ p: Pt; touch: boolean; target: EventTarget | null; mouse: boolean } | null>(null);

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

  // Keep the selection valid when the document changes (undo, deletes…), following strokes into other blocks.
  useEffect(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    const where = new Map<string, string>();
    for (const b of layout.blocks) for (const s of b.ink) where.set(s.id, b.id);
    const items = sel.items.flatMap((it) => (where.has(it.strokeId) ? [{ blockId: where.get(it.strokeId)!, strokeId: it.strokeId }] : []));
    setSelection(items.length ? selectionFromItems(items, layout) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Leaving the lasso tool clears the selection.
  const tool = useTools((s) => s.tool);
  useEffect(() => {
    if (tool !== 'lasso') setSelection(null);
    if (tool !== 'ask') setSnip(null);
    if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'eraser' && cursorRef.current) cursorRef.current.style.display = 'none';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  useImperativeHandle(ref, () => ({
    layout: () => layoutRef.current,
    clearSelection: () => setSelection(null),
    // (ink picked up with ⌘ and the pen doesn't stop you from typing)
    hasSelection: () => !!selectionRef.current && useTools.getState().tool === 'lasso',
    popOut: (pos: number) => {
      const out = wrapRef.current && inlineSketchStrokes(propsRef.current.editor, wrapRef.current, propsRef.current.scale || 1, pos);
      if (!out) return;
      useTools.getState().setTool('lasso');
      (propsRef.current.editor.view.dom as HTMLElement).blur();
      place(out.strokes, new Set(), undefined, (tr) => removeInlineNode(tr, pos));
    },
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

  function placedOf(sel: Selection | null, lay = layoutRef.current): PlacedStroke[] {
    const out: PlacedStroke[] = [];
    if (!sel) return out;
    for (const it of sel.items) {
      const b = lay.blocks.find((x) => x.id === it.blockId);
      const s = b?.ink.find((x) => x.id === it.strokeId);
      if (b && s) out.push({ stroke: s, top: b.top });
    }
    return out;
  }

  function selectedStrokesAbs(sel: Selection | null = selectionRef.current): Stroke[] {
    return placedOf(sel).map(({ stroke, top }) => translateStroke(stroke, 0, top));
  }

  /** The blob of handwriting under the point (a word, a symbol, a drawing), or null. */
  function blobAt(p: Pt, touch: boolean): SelectionItem[] | null {
    const { items, keys } = placedAll(layoutRef.current);
    const inv = 1 / (propsRef.current.scale || 1);
    const i = strokeAt(items, p.x, p.y, (touch ? 9 : 4) * inv);
    if (i < 0) return null;
    return blobsOf(layoutRef.current, propsRef.current.line)
      .pick(i)
      .map((k) => keys[k]);
  }

  function inkUnder(p: Pt, touch: boolean): boolean {
    const { items } = placedAll(layoutRef.current);
    return strokeAt(items, p.x, p.y, (touch ? 9 : 4) / (propsRef.current.scale || 1)) >= 0;
  }

  // ---------------------------------------------------------------- pointer look
  function setCursor(c: string | null) {
    if (c === cursorKind.current) return;
    cursorKind.current = c;
    const el = (wrapRef.current?.closest('.surface') as HTMLElement | null) ?? wrapRef.current;
    if (!el) return;
    if (c) el.dataset.inkCursor = c;
    else delete el.dataset.inkCursor;
  }

  /** A hand over ink you can pick up (with the lasso, or ⌘ and the pen), arrows over the resize handles. */
  function hoverCursor(meta: boolean): string | null {
    const h = hover.current;
    if (!h || isUi(h.target)) return null;
    const t = useTools.getState().tool;
    const penGrab = (t === 'pen' || t === 'highlighter') && meta;
    if (t !== 'lasso' && !penGrab) return null;
    if (t === 'lasso' && h.target instanceof Element && h.target.closest('.ink-inline-node')) return 'grab';
    const sel = selectionRef.current;
    const hit = sel ? hitSelection(sel.bounds, h.p, 1 / (propsRef.current.scale || 1)) : null;
    if (hit?.kind === 'handle' && t === 'lasso') return hit.corner === 0 || hit.corner === 3 ? 'nwse-resize' : 'nesw-resize';
    if (hit || inkUnder(h.p, h.touch)) return 'grab';
    return null;
  }

  /** The pen's dot follows the pointer, except while the hand shows. */
  function showPenDot() {
    const c = cursorRef.current;
    if (!c) return;
    const h = hover.current;
    const t = useTools.getState().tool;
    const show = (t === 'pen' || t === 'highlighter' || t === 'eraser') && !!h?.mouse && !cursorKind.current;
    c.style.display = show ? '' : 'none';
    if (show && h) c.setAttribute('transform', `translate(${h.p.x} ${h.p.y})`);
  }

  /** What a drag carries along (see Carried). `exclude`: the strokes being carried. */
  function carry(placed: PlacedStroke[], box: Bounds, baseline: number | null, exclude: Set<string>, popped: boolean): Carried {
    const { editor: ed, line: l } = propsRef.current;
    const s = propsRef.current.scale || 1;
    const wrap = wrapRef.current!;
    const h = box.maxY - box.minY;
    const w = box.maxX - box.minX;
    const highlight = placed.some(({ stroke }) => stroke.brush === 'highlighter');
    const loop = placed.some(({ stroke }) => isLoop(stroke) && rawBounds(stroke).maxY - rawBounds(stroke).minY >= l * 0.6);
    const flat = h < l * 0.3 && w > l * 1.5;
    // Highlights stay highlights, an underline isn't a word, and a circle or box drawn around words stays a drawing.
    const inline = baseline !== null && !highlight && !loop && !flat && h <= l * 2.4 && w <= 420;
    const probeX = (box.minX + box.maxX) / 2 >= 0 ? Math.max(1, box.minX) : box.minX;
    const start = inline && !popped && baseline !== null ? findTextDropTarget(ed, wrap, s, { x: probeX, y: baseline - l * 0.25 }) : null;
    const onText = !popped && textBlocksUnder(ed, wrap, s, box).length > 0;
    // The left edges of the other handwriting on the page, to line up with.
    const { items } = placedAll(layoutRef.current);
    const aligns: Carried['aligns'] = [];
    if (!highlight) {
      for (const group of blobsOf(layoutRef.current, l).groups) {
        const parts = group.map((i) => items[i]).filter(({ stroke }) => !exclude.has(stroke.id) && stroke.brush !== 'highlighter');
        if (!parts.length) continue;
        const bb = unionBounds(parts.map(({ stroke, top }) => offsetBounds(strokeBounds(stroke), 0, top)))!;
        const b = estimateBaseline(parts, l) ?? bb.maxY;
        aligns.push({ x: bb.minX, k: Math.round((b + 1) / l - 0.75), top: bb.minY, bottom: bb.maxY });
      }
    }
    const page = wrap.closest('.page')?.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const limits = page
      ? { left: (page.left - wr.left) / s + 4, right: (page.right - wr.left) / s - 4, bottom: (page.bottom - wr.top) / s - 8 }
      : { left: -Infinity, right: Infinity, bottom: Infinity };
    // (a box or circle counts as drawn around words only if it is around words now)
    return { box, baseline, inline, home: start?.top ?? null, overlay: highlight || flat || onText, aligns, limits };
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

  // ---------------------------------------------------------------- placing ink
  /**
   * Puts strokes (layer coordinates) into the one block under their centre,
   * taking the strokes in `remove` out of wherever they are, as one undo step;
   * then selects them. Reads the page fresh rather than from the last layout,
   * so a layout a frame behind can't write back old ink.
   */
  function place(strokes: Stroke[], remove: Set<string>, nudge?: 'first' | 'more', before?: (tr: Transaction) => void, into?: string | null) {
    const { editor: ed, line: l } = propsRef.current;
    if (!strokes.length) return;
    const lay = measureLayout(ed);
    const edits = new Map<string, Stroke[]>();
    if (remove.size) for (const b of lay.blocks) if (b.ink.some((s) => remove.has(s.id))) edits.set(b.id, b.ink.filter((s) => !remove.has(s.id)));
    const bb = unionBounds(strokes.map(strokeBounds))!;
    const target = (into && lay.blocks.find((b) => b.id === into)) || resolveDropTarget(lay.blocks, (bb.minY + bb.maxY) / 2, l);
    let tail: Stroke[] | undefined;
    if (target) {
      const list = edits.get(target.id) ?? [...inkOf(ed.state.doc.child(target.index))];
      for (const s of strokes) list.push(translateStroke(s, 0, -target.top));
      edits.set(target.id, list);
    } else tail = strokes.map((s) => translateStroke(s, 0, -lay.contentBottom));
    const created = applyInkEdits(ed, edits, l, tail, { nudge, before });
    const blockId = target?.id ?? created;
    // Measure the updated page now, not next frame, so the selection never flickers back.
    const next = measureLayout(ed);
    layoutRef.current = next;
    setLayout(next);
    setSelection(blockId ? selectionFromItems(strokes.map((s) => ({ blockId, strokeId: s.id })), next) : null);
  }

  /** Moves the selection (`fn` maps each stroke, in layer coordinates) to wherever it now belongs (or into block `into`). */
  function moveSelection(fn: (s: Stroke) => Stroke, nudge?: 'first' | 'more', into?: string | null) {
    const sel = selectionRef.current;
    if (!sel) return;
    const ids = new Set(sel.items.map((i) => i.strokeId));
    const lay = measureLayout(propsRef.current.editor);
    const moved: Stroke[] = [];
    for (const b of lay.blocks) for (const s of b.ink) if (ids.has(s.id)) moved.push(fn(translateStroke(s, 0, b.top)));
    place(moved, ids, nudge, undefined, into);
  }

  /** Drops the dragged ink (the selection, or a sketch pulled out of the text) into a line of text. */
  function dropIntoText(t: TextDropTarget, g: MoveGesture, dx: number, dy: number) {
    const ed = propsRef.current.editor;
    const strokes: Stroke[] = [];
    const remove = new Map<string, Set<string>>();
    if (g.popped) strokes.push(...g.popped.strokes.map((s) => translateStroke(s, dx, dy)));
    else {
      const ids = new Set(selectionRef.current?.items.map((i) => i.strokeId));
      for (const b of measureLayout(ed).blocks)
        for (const s of b.ink) {
          if (!ids.has(s.id)) continue;
          strokes.push(translateStroke(s, dx, b.top + dy));
          if (!remove.has(b.id)) remove.set(b.id, new Set());
          remove.get(b.id)!.add(s.id);
        }
    }
    if (!strokes.length) return;
    const bb = unionBounds(strokes.map(strokeBounds))!;
    // It sits on the text's baseline, shrunk if needed so the line doesn't grow.
    const baseline = (g.carried.baseline ?? g.carried.box.maxY) + dy;
    const fit = fitInline(baseline - bb.minY, bb.maxY - baseline, t.roomAbove, t.roomBelow);
    const attrs = inlineSketchAttrs(strokes, baseline, t.fontPx, fit);
    const at = insertInlineSketch(ed, { pos: t.pos, attrs, remove, removeNode: g.popped?.pos });
    setSelection(null);
    const dom = ed.view.nodeDOM(at);
    if (dom instanceof HTMLElement) {
      dom.classList.add('is-landed');
      setTimeout(() => dom.classList.remove('is-landed'), 900);
    }
  }

  /** Drops the dragged ink into new lines of its own between two blocks (pushing the text below down). */
  function makeRoom(room: NonNullable<DropPlan['room']>, g: MoveGesture, dx: number) {
    const ed = propsRef.current.editor;
    const strokes: Stroke[] = [];
    const remove = new Map<string, Set<string>>();
    if (g.popped) strokes.push(...g.popped.strokes.map((s) => translateStroke(s, dx, room.dy)));
    else {
      const ids = new Set(selectionRef.current?.items.map((i) => i.strokeId));
      for (const b of measureLayout(ed).blocks)
        for (const s of b.ink) {
          if (!ids.has(s.id)) continue;
          strokes.push(translateStroke(s, dx, b.top + room.dy));
          if (!remove.has(b.id)) remove.set(b.id, new Set());
          remove.get(b.id)!.add(s.id);
        }
    }
    if (!strokes.length) return;
    const local = strokes.map((s) => translateStroke(s, 0, -room.y));
    const popped = g.popped?.pos;
    const id = insertInkArea(ed, room.index, local, room.height, (tr) => {
      removeStrokes(tr, remove);
      if (popped !== undefined) removeInlineNode(tr, popped);
    });
    const next = measureLayout(ed);
    layoutRef.current = next;
    setLayout(next);
    setSelection(selectionFromItems(local.map((s) => ({ blockId: id, strokeId: s.id })), next));
  }

  function editSelected(fn: (s: Stroke) => Stroke | null, reselect = true) {
    const sel = selectionRef.current;
    if (!sel) return;
    const { editor: ed, line: l } = propsRef.current;
    const ids = new Set(sel.items.map((i) => i.strokeId));
    const edits = new Map<string, Stroke[]>();
    ed.state.doc.forEach((node) => {
      const ink = inkOf(node);
      if (!ink.some((s) => ids.has(s.id))) return;
      const next: Stroke[] = [];
      for (const s of ink) {
        if (!ids.has(s.id)) next.push(s);
        else {
          const r = fn(s);
          if (r) next.push(r);
        }
      }
      edits.set(node.attrs.id as string, next);
    });
    applyInkEdits(ed, edits, l);
    if (!reselect) setSelection(null);
  }

  function deleteSelection() {
    editSelected(() => null, false);
  }

  function duplicateSelection(offset = 18) {
    const picked = selectedStrokesAbs();
    if (picked.length) pasteStrokes(picked, offset, offset);
  }

  function pasteStrokes(absStrokes: Stroke[], dx: number, dy: number) {
    const fresh = absStrokes.map((st) => ({ ...translateStroke(st, dx, dy), id: uid('s') }));
    useTools.getState().setTool('lasso');
    setQuiet(false);
    place(fresh, new Set());
  }

  // ---------------------------------------------------------------- dragging
  /** Where the dragged selection would land right now: snapped to the page, or into a line of text. */
  function resolveDrag(g: MoveGesture): DropPlan & { free: SnapResult } {
    const { editor: ed, line: l } = propsRef.current;
    const s = propsRef.current.scale || 1;
    const { box, baseline, inline, home, limits } = g.carried;
    // Ink stays on the paper: not off its edges, and not above the first line,
    // where it would sit over the title out of reach. (Ink already past an
    // edge isn't pushed back, only kept from going further.)
    const right = Math.max(limits.right, box.maxX);
    const left = Math.min(limits.left, box.minX);
    const bottom = Math.max(limits.bottom, box.maxY);
    const top = Math.min(0, box.minY);
    const onPage = (r: SnapResult): SnapResult => {
      let { dx, dy, rule, x } = r;
      if (box.maxX + dx > right) [dx, x] = [right - box.maxX, null];
      if (box.minX + dx < left) [dx, x] = [left - box.minX, null];
      if (box.maxY + dy > bottom) [dy, rule] = [bottom - box.maxY, null];
      if (box.minY + dy < top) [dy, rule] = [top - box.minY, null];
      return { dx, dy, rule, x };
    };
    const free = onPage({ dx: g.dx, dy: g.dy, rule: null, x: null });
    const plan = (snap: SnapResult, text: TextDropTarget | null = null, room: DropPlan['room'] = null, into: string | null = null) => ({ snap, text, room, into, free });
    if (g.alt || !wrapRef.current) return plan(free);
    const wrap = wrapRef.current;
    if (inline && baseline !== null) {
      // Probe just inside the text when the ink is over the column, so a word dropped at the very start of a line joins it.
      const left = box.minX + g.dx;
      const probeX = (box.minX + box.maxX) / 2 + g.dx >= 0 ? Math.max(1, left) : left;
      const text = findTextDropTarget(ed, wrap, s, { x: probeX, y: baseline + g.dy - l * 0.25 });
      // (too big to sit in a line without shrinking to a speck: it stays ink)
      const fits = text && fitInline(baseline - box.minY, box.maxY - baseline, text.roomAbove, text.roomBelow) >= 0.5;
      if (text && fits && (home === null || Math.abs(text.top - home) > 2)) return plan(free, text);
    }
    // Always onto the nearest ruled line. The left edge lines up with the
    // margin, the end of a line of text, or handwriting on the line above or
    // below. Notes on the text (a circle round a word, a tick after a line)
    // keep their height on it, moving by whole lines.
    const xTol = Math.min(SNAP / s, l * 0.3);
    const lineBase = g.carried.overlay || home !== null ? null : baseline;
    const { dy } = snapMove({ box, baseline: lineBase, dx: g.dx, dy: g.dy, line: l, tol: l / 2 });
    const base = (baseline ?? box.maxY) + dy;
    const k = Math.round((base + 1) / l - 0.75);
    const end = textLineEnd(ed, wrap, s, base - l * 0.25);
    // (on a line of text the margin would put it on the first letters)
    const xTargets: SnapTarget[] = [end === null ? { x: 0, kind: 'margin' } : { x: end, kind: 'text' }];
    for (const a of g.carried.aligns) if (a.k === k - 1 || a.k === k + 1) xTargets.push({ x: a.x, kind: 'ink', top: a.top, bottom: a.bottom });
    const snap = onPage(snapMove({ box, baseline: lineBase, dx: g.dx, dy: g.dy, line: l, tol: l / 2, xTol, xTargets }));
    if (g.carried.overlay || baseline === null) return plan(snap);
    // About to land on typed words: make room for it between the blocks
    // instead, at the gap nearest to where it is being let go.
    const at = offsetBounds(box, snap.dx, snap.dy);
    const under = textBlocksUnder(ed, wrap, s, at);
    if (!under.length) return plan(snap);
    const mid = g.sy + g.dy;
    let gap = { index: 0, y: 0, d: Infinity };
    for (const b of layoutRef.current.blocks) {
      if (!under.includes(b.index)) continue;
      for (const [index, y] of [
        [b.index, b.zoneStart],
        [b.index + 1, b.zoneEnd],
      ])
        if (Math.abs(y - mid) < gap.d) gap = { index, y, d: Math.abs(y - mid) };
    }
    // Below the gap, its baseline goes on the first ruled line its top fits under.
    const first = ruleY(Math.round(gap.y / l), l);
    const newBase = first + Math.max(0, Math.ceil((gap.y + (baseline - box.minY) + 2 - first) / l)) * l;
    const roomDy = newBase - baseline;
    const height = Math.max(l, gridCeil(box.maxY + roomDy - gap.y - descenderAllowance(l), l));
    const x = onPage(snapMove({ box, baseline, dx: g.dx, dy: roomDy, line: l, tol: 0, xTol, xTargets: [{ x: 0, kind: 'margin' }] }));
    const landed: SnapResult = { dx: x.dx, dy: roomDy, rule: newBase, x: x.x };
    // Next to a handwriting area it goes into that area (nothing moves when
    // the area is below the gap; one above it grows). Only between two blocks
    // of text do new lines open.
    const blocks = layoutRef.current.blocks;
    const below = blocks.find((b) => b.index === gap.index);
    const above = blocks.find((b) => b.index === gap.index - 1);
    if (below?.type === 'inkBlock') return plan(landed, null, null, below.id);
    const room = { index: gap.index, y: gap.y, dy: roomDy, height };
    if (above?.type === 'inkBlock') return plan(landed, null, room, above.id);
    return plan(landed, null, room);
  }

  function requestPaint() {
    if (!paintRaf.current) paintRaf.current = requestAnimationFrame(() => {
      paintRaf.current = 0;
      paintDrag();
    });
  }

  /** Moves the drag preview and its guides (straight to the DOM: no React render per frame). */
  function paintDrag() {
    const g = gesture.current;
    if (!g || (g.kind !== 'move' && g.kind !== 'scale') || !g.moved) return;
    const sel = selectionRef.current;
    if (!sel && !(g.kind === 'move' && g.popped)) return;
    const inv = 1 / (propsRef.current.scale || 1);
    const show = (el: SVGElement | null, on: boolean) => el?.setAttribute('display', on ? 'inline' : 'none');
    let transform: string;
    let box: Bounds;
    let text: TextDropTarget | null = null;
    let snap: SnapResult | null = null;
    let room: DropPlan['room'] = null;
    if (g.kind === 'move') {
      const plan = resolveDrag(g);
      ({ snap, text, room } = plan);
      // Over text, or about to make room, the ink stays under the pointer; otherwise it shows where it will land.
      const at = text || room ? plan.free : snap;
      transform = `translate(${at.dx} ${at.dy})`;
      box = offsetBounds(g.carried.box, at.dx, at.dy);
    } else {
      transform = `translate(${g.ax} ${g.ay}) scale(${g.s}) translate(${-g.ax} ${-g.ay})`;
      const b = sel!.bounds;
      const xs = [g.ax + (b.minX - g.ax) * g.s, g.ax + (b.maxX - g.ax) * g.s];
      const ys = [g.ay + (b.minY - g.ay) * g.s, g.ay + (b.maxY - g.ay) * g.s];
      box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    for (const el of [dragPenRef.current, dragHlRef.current]) {
      el?.setAttribute('transform', transform);
      // Over text the ink fades: it is about to become part of the sentence, or move to its own lines.
      if (text || room) el?.setAttribute('opacity', '0.45');
      else el?.removeAttribute('opacity');
    }
    const frame = selectionFrame(box, inv).frame;
    const rect = dragBoxRef.current;
    if (rect) {
      show(rect, !text && !room);
      rect.setAttribute('x', String(frame.minX));
      rect.setAttribute('y', String(frame.minY));
      rect.setAttribute('width', String(frame.maxX - frame.minX));
      rect.setAttribute('height', String(frame.maxY - frame.minY));
    }
    // Guides: the ruled line it will sit on and the edge it lines up with; the
    // caret where it goes into the text; or the gap that opens between blocks.
    const width = wrapRef.current?.offsetWidth ?? 0;
    const rule = snap && !text && !room ? snap.rule : null;
    show(ruleRef.current, rule !== null);
    show(baseRef.current, rule !== null);
    if (rule !== null) {
      const y = String(rule + 0.5);
      ruleRef.current?.setAttribute('x1', String(Math.min(0, box.minX) - 12 * inv));
      ruleRef.current?.setAttribute('x2', String(Math.max(width, box.maxX) + 12 * inv));
      for (const el of [ruleRef.current, baseRef.current]) {
        el?.setAttribute('y1', y);
        el?.setAttribute('y2', y);
      }
      baseRef.current?.setAttribute('x1', String(box.minX - 4 * inv));
      baseRef.current?.setAttribute('x2', String(box.maxX + 4 * inv));
    }
    const edge = snap && !text && !room ? snap.x : null;
    show(edgeRef.current, !!edge);
    if (edge) {
      edgeRef.current?.setAttribute('x1', String(edge.x));
      edgeRef.current?.setAttribute('x2', String(edge.x));
      edgeRef.current?.setAttribute('y1', String(Math.min(box.minY, edge.top ?? Infinity) - 10 * inv));
      edgeRef.current?.setAttribute('y2', String(Math.max(box.maxY, edge.bottom ?? -Infinity) + 10 * inv));
    }
    show(caretRef.current, !!text);
    if (text) {
      const t = 3 * inv;
      caretRef.current?.setAttribute('d', `M${text.x} ${text.top - t}V${text.bottom + t}M${text.x - t} ${text.top - t}H${text.x + t}M${text.x - t} ${text.bottom + t}H${text.x + t}`);
    }
    show(roomRef.current, !!room);
    show(roomLineRef.current, !!room);
    if (room) {
      roomRef.current?.setAttribute('x', String(-12 * inv));
      roomRef.current?.setAttribute('width', String(width + 24 * inv));
      roomRef.current?.setAttribute('y', String(room.y));
      roomRef.current?.setAttribute('height', String(room.height));
      roomLineRef.current?.setAttribute('x1', String(-12 * inv));
      roomLineRef.current?.setAttribute('x2', String(width + 12 * inv));
      roomLineRef.current?.setAttribute('y1', String(room.y));
      roomLineRef.current?.setAttribute('y2', String(room.y));
    }
    const hint = useInkHint.getState();
    const want = text ? DROP_HINT : room ? ROOM_HINT : null;
    if (hint.hint !== want) hint.setHint(want);
  }

  function endDragVisuals(g: Gesture) {
    if (paintRaf.current) cancelAnimationFrame(paintRaf.current);
    paintRaf.current = 0;
    for (const el of [dragPenRef.current, dragHlRef.current]) {
      el?.removeAttribute('transform');
      el?.removeAttribute('opacity');
    }
    if (g.kind === 'move' && g.popped) {
      g.popped.dom.style.visibility = '';
      setPopped(null);
    }
    if (useInkHint.getState().hint) useInkHint.getState().setHint(null);
  }

  /** Esc while dragging: put it back. */
  function cancelDrag() {
    const g = gesture.current;
    if (g?.kind !== 'move' && g?.kind !== 'scale') return;
    gesture.current = null;
    if (autoRaf.current) cancelAnimationFrame(autoRaf.current);
    autoRaf.current = 0;
    endDragVisuals(g);
    setHeld(null);
    setCursor(hoverCursor(false));
  }

  // Keyboard shortcuts for a lasso selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = gesture.current;
      // While dragging: ⌥ switches snapping off and on, Esc puts the ink back.
      if (g?.kind === 'move' || g?.kind === 'scale') {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelDrag();
        } else if (e.key === 'Alt' && g.kind === 'move') {
          g.alt = true;
          requestPaint();
        }
        return;
      }
      if (!wrapRef.current?.isConnected || wrapRef.current.offsetParent === null) return;
      // ⌘ held over ink with the pen shows the hand straight away.
      if (e.key === 'Meta' && !g) {
        setCursor(hoverCursor(true));
        showPenDot();
      }
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]') && !target.classList.contains('ProseMirror')) return;
      if (editor.isFocused) return;
      const sel = selectionRef.current;
      const mod = e.metaKey || e.ctrlKey;
      // Redo after moving ink. (⌘Z already reaches the editor; in the Mac app the menu handles both.)
      if (!isElectron && mod && !e.altKey && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y'))) {
        e.preventDefault();
        editor.commands.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v' && clipboard?.length) {
        e.preventDefault();
        const b = unionBounds(clipboard.map(strokeBounds))!;
        const at = lastPointer.current;
        const dx = at ? at.x - (b.minX + b.maxX) / 2 : 24;
        const dy = at ? at.y - (b.minY + b.maxY) / 2 : 24;
        pasteStrokes(clipboard, dx, dy);
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
        clipboard = selectedStrokesAbs();
        if (e.key.toLowerCase() === 'x') deleteSelection();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        // ⌥↑ / ⌥↓ put it on the next ruled line up or down; a burst of presses is one undo step.
        const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
        const l = propsRef.current.line;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        let dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (e.altKey && vertical) {
          const base = estimateBaseline(placedOf(sel), l);
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          dy = base === null ? dir * l : ruleY(Math.round((base + 1) / l - 0.75) + dir, l) - base;
        }
        const now = performance.now();
        const last = lastNudge.current;
        const burst = !!last && now - last.at < 600 && last.doc === editor.state.doc;
        moveSelection((s) => translateStroke(s, dx, dy), burst ? 'more' : 'first');
        lastNudge.current = { at: now, doc: editor.state.doc };
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const g = gesture.current;
      if (e.key === 'Alt' && g?.kind === 'move') {
        g.alt = false;
        requestPaint();
      }
      if (e.key === 'Meta' && !g) {
        setCursor(hoverCursor(false));
        showPenDot();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ---------------------------------------------------------------- pointer input
  useEffect(() => {
    // Listen on the whole page surface so ink tools also work in the margins;
    // coordinates stay relative to the text column (wrapRef).
    const el = (wrapRef.current?.closest('.surface') as HTMLElement | null) ?? wrapRef.current;
    if (!el) return;

    const effectiveTool = (e: PointerEvent) => {
      const st = useTools.getState();
      if (st.tool !== 'text') return st.tool;
      if (e.pointerType === 'pen' && st.stylusDraws) return st.lastInkTool;
      return null;
    };

    const startMove = (e: PointerEvent, p: Pt) => {
      const sel = selectionRef.current!;
      const placed = placedOf(sel);
      const baseline = estimateBaseline(placed, propsRef.current.line);
      gesture.current = {
        kind: 'move',
        id: e.pointerId,
        sx: p.x,
        sy: p.y,
        dx: 0,
        dy: 0,
        moved: false,
        client: { x: e.clientX, y: e.clientY },
        alt: e.altKey,
        carried: carry(placed, sel.bounds, baseline, new Set(sel.items.map((i) => i.strokeId)), false),
      };
      setHeld('press');
    };

    /** Pressing on a sketch in the text with the lasso pulls it back out as handwriting. */
    const startPopOut = (e: PointerEvent, p: Pt, dom: HTMLElement): boolean => {
      const ed = propsRef.current.editor;
      let pos = -1;
      ed.state.doc.descendants((node, at) => {
        if (pos < 0 && node.type.name === 'inkInline' && ed.view.nodeDOM(at) === dom) pos = at;
        return pos < 0;
      });
      const out = pos >= 0 && wrapRef.current ? inlineSketchStrokes(ed, wrapRef.current, propsRef.current.scale || 1, pos) : null;
      if (!out) return false;
      setSelection(null);
      gesture.current = {
        kind: 'move',
        id: e.pointerId,
        sx: p.x,
        sy: p.y,
        dx: 0,
        dy: 0,
        moved: false,
        client: { x: e.clientX, y: e.clientY },
        alt: e.altKey,
        carried: carry(
          out.strokes.map((stroke) => ({ stroke, top: 0 })),
          unionBounds(out.strokes.map(strokeBounds))!,
          out.baseline,
          new Set(),
          true,
        ),
        popped: { pos, dom, strokes: out.strokes },
      };
      setHeld('press');
      return true;
    };

    const onDown = (e: PointerEvent) => {
      if (isUi(e.target)) return;
      const t = effectiveTool(e);
      if (!t) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // One drag at a time (a resting palm must not take over).
      const busy = gesture.current;
      if (busy && (busy.kind === 'move' || busy.kind === 'scale')) return;
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

      // With the lasso — or ⌘ with the pen — a press on ink picks up the whole word or drawing.
      const penGrab = (t === 'pen' || t === 'highlighter') && e.metaKey;
      if (t === 'lasso' || penGrab) {
        const sketch = t === 'lasso' ? (e.target as Element | null)?.closest?.('.ink-inline-node') : null;
        if (sketch instanceof HTMLElement && startPopOut(e, p, sketch)) return;
        const sel = selectionRef.current;
        const inv = 1 / (propsRef.current.scale || 1);
        const hit = sel ? hitSelection(sel.bounds, p, inv) : null;
        if (hit?.kind === 'inside') return startMove(e, p);
        if (hit?.kind === 'handle' && sel && t === 'lasso') {
          const b = sel.bounds;
          // Resize about the opposite corner.
          const ax = hit.corner % 2 ? b.minX : b.maxX;
          const ay = hit.corner > 1 ? b.minY : b.maxY;
          gesture.current = { kind: 'scale', id, ax, ay, d0: Math.hypot(p.x - ax, p.y - ay) || 1, s: 1, moved: false, client: { x: e.clientX, y: e.clientY } };
          setHeld('press');
          return;
        }
        const blob = blobAt(p, e.pointerType === 'touch');
        if (blob) {
          // ⇧ adds to the selection.
          const items = e.shiftKey && sel ? [...sel.items, ...blob.filter((b) => !sel.items.some((i) => i.strokeId === b.strokeId))] : blob;
          setSelection(selectionFromItems(items));
          return startMove(e, p);
        }
        if (hit) return startMove(e, p);
        if (t === 'lasso') {
          setSelection(null);
          gesture.current = { kind: 'lasso', id, poly: [p.x, p.y], client: { x: e.clientX, y: e.clientY } };
          setOverlay({ lasso: [p.x, p.y] });
          return;
        }
      }

      if (t === 'pen' || t === 'highlighter') {
        // Writing again ends a selection picked up with ⌘.
        if (selectionRef.current) setSelection(null);
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

    /** Follows the pointer (or the page scrolling under it) during a lasso, move or resize. */
    const pointerAt = (g: Gesture, client: Pt) => {
      const p = toLocal({ clientX: client.x, clientY: client.y });
      lastPointer.current = p;
      if (hover.current) hover.current = { ...hover.current, p, target: null };
      if (g.kind === 'lasso') {
        g.client = client;
        g.poly.push(p.x, p.y);
        setOverlay({ lasso: g.poly.slice() });
      } else if (g.kind === 'move') {
        g.client = client;
        const dx = p.x - g.sx;
        const dy = p.y - g.sy;
        if (!g.moved) {
          if (Math.hypot(dx, dy) < DRAG_START / (propsRef.current.scale || 1)) return;
          g.moved = true;
          const popped = g.popped;
          flushSync(() => {
            setHeld('drag');
            if (popped) setPopped(popped.strokes);
          });
          // The sketch leaves its place in the text while it is carried.
          if (popped) popped.dom.style.visibility = 'hidden';
          setCursor('grabbing');
          startAutoscroll();
        }
        g.dx = dx;
        g.dy = dy;
        requestPaint();
      } else if (g.kind === 'scale') {
        g.client = client;
        if (!g.moved) {
          g.moved = true;
          flushSync(() => setHeld('drag'));
          startAutoscroll();
        }
        const d = Math.hypot(p.x - g.ax, p.y - g.ay);
        g.s = Math.max(0.15, Math.min(8, d / g.d0));
        requestPaint();
      }
    };

    // Dragging near the top or bottom of the window scrolls the page.
    const startAutoscroll = () => {
      if (autoRaf.current) return;
      const tick = () => {
        autoRaf.current = 0;
        const g = gesture.current;
        if (!g || (g.kind !== 'lasso' && g.kind !== 'move' && g.kind !== 'scale')) return;
        const sc = wrapRef.current?.closest('.note-scroll') as HTMLElement | null;
        if (sc) {
          const r = sc.getBoundingClientRect();
          // The toolbar floats over the top of the page: the zone starts below it.
          const dock = sc.querySelector('.toolbar-dock')?.getBoundingClientRect();
          const v = autoscrollSpeed(g.client.y, Math.max(r.top, dock?.bottom ?? r.top), r.bottom);
          if (v) {
            const before = sc.scrollTop;
            sc.scrollTop = before + v;
            if (sc.scrollTop !== before) pointerAt(g, g.client);
          }
        }
        autoRaf.current = requestAnimationFrame(tick);
      };
      autoRaf.current = requestAnimationFrame(tick);
    };
    const stopAutoscroll = () => {
      if (autoRaf.current) cancelAnimationFrame(autoRaf.current);
      autoRaf.current = 0;
    };

    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      const p = toLocal(e);
      lastPointer.current = p;
      hover.current = { p, touch: e.pointerType === 'touch', target: e.target, mouse: e.pointerType !== 'touch' };
      if (!g) setCursor(hoverCursor(e.metaKey));
      showPenDot();
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
      } else if (g.kind === 'lasso' || g.kind === 'move' || g.kind === 'scale') {
        if (g.kind === 'move') g.alt = e.altKey;
        if (g.kind === 'lasso') startAutoscroll();
        pointerAt(g, { x: e.clientX, y: e.clientY });
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
      stopAutoscroll();
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
      } else if (g.kind === 'move' || g.kind === 'scale') {
        if (g.kind === 'move' && g.moved && !cancelled) {
          g.alt = e.altKey;
          // The same answer the preview showed.
          const { snap, text, room, into } = resolveDrag(g);
          if (text) dropIntoText(text, g, snap.dx, snap.dy);
          else if (room && !into) makeRoom(room, g, snap.dx);
          else if (g.popped) {
            // Out of the text and onto the page, in one undo step.
            const { pos, strokes } = g.popped;
            place(
              strokes.map((s) => translateStroke(s, snap.dx, snap.dy)),
              new Set(),
              undefined,
              (tr) => removeInlineNode(tr, pos),
              into,
            );
          } else if (into || Math.abs(snap.dx) > 0.5 || Math.abs(snap.dy) > 0.5) moveSelection((s) => translateStroke(s, snap.dx, snap.dy), undefined, into);
        } else if (g.kind === 'scale' && g.moved && !cancelled && Math.abs(g.s - 1) > 0.01) {
          moveSelection((s) => scaleStroke(s, g.ax, g.ay, g.s));
        }
        endDragVisuals(g);
        setHeld(null);
        // After a drop the menu waits for a tap on the selection; a tap shows it.
        setQuiet(g.moved && !cancelled);
        hover.current = { p: toLocal(e), touch: e.pointerType === 'touch', target: e.target, mouse: e.pointerType !== 'touch' };
        setCursor(hoverCursor(e.metaKey));
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

    const onLeave = () => {
      hover.current = null;
      if (cursorRef.current) cursorRef.current.style.display = 'none';
      if (!gesture.current) setCursor(null);
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
      stopAutoscroll();
      delete el.dataset.inkCursor;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, wrapRef]);

  function finishLasso(poly: number[]) {
    setQuiet(false);
    const lay = layoutRef.current;
    const pb = polygonBounds(poly);
    const tiny = pb.maxX - pb.minX < 6 && pb.maxY - pb.minY < 6;
    if (tiny) {
      // A tap just off the ink still picks up the blob it was meant for.
      const blob = blobAt({ x: poly[0], y: poly[1] }, true);
      setSelection(blob ? selectionFromItems(blob) : null);
      return;
    }
    const items: SelectionItem[] = [];
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
    setSelection(items.length ? selectionFromItems(items) : null);
  }

  // ---------------------------------------------------------------- render
  const dragging = held === 'drag';
  const hidden = useMemo(() => (dragging && selection ? new Set(selection.items.map((i) => i.strokeId)) : null), [dragging, selection]);
  const selParts = useMemo(() => placedOf(selection, layout), [selection, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const blockInk = (b: BlockBox) => (erasing?.get(b.id) ?? b.ink) as Stroke[];

  const st = useTools();
  const cursorR = st.tool === 'eraser' ? st.eraser.size / 2 : st.tool === 'highlighter' ? st.highlighter.size / 2 : Math.max(1.2, st.pen.size * 0.65);
  const cursorColor = st.tool === 'highlighter' ? st.highlighter.color : st.pen.color;
  const inv = 1 / (scale || 1);
  const frame = selection ? selectionFrame(selection.bounds, inv).frame : null;

  return (
    <>
      <svg className="ink-overlay ink-hl" aria-hidden>
        {layout.blocks.map((b) =>
          b.ink.length || erasing?.has(b.id) ? <BlockInk key={b.id} top={b.top} ink={blockInk(b)} hidden={hidden} highlighter grain={ids.grain} /> : null,
        )}
        <g ref={dragHlRef}>
          {dragging &&
            selParts
              .filter(({ stroke }) => stroke.brush === 'highlighter')
              .map(({ stroke, top }) => <path key={stroke.id} transform={`translate(0 ${top})`} d={strokePath(stroke)} {...strokeSvgAttrs(stroke)} />)}
          {popped
            ?.filter((s) => s.brush === 'highlighter')
            .map((s) => (
              <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} />
            ))}
        </g>
        <path ref={liveHlRef} />
      </svg>
      <svg className="ink-overlay ink-pen" aria-hidden>
        <defs>
          <filter id={ids.grain} x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="3" result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.25" result="mask" />
            <feComposite in="SourceGraphic" in2="mask" operator="in" />
          </filter>
          <filter id={ids.selected} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="2.2" floodColor="#2160e8" floodOpacity="0.55" />
          </filter>
          <filter id={ids.lifted} x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#1c1c1e" floodOpacity="0.22" />
          </filter>
        </defs>
        {layout.blocks.map((b) =>
          b.ink.length || erasing?.has(b.id) ? <BlockInk key={b.id} top={b.top} ink={blockInk(b)} hidden={hidden} highlighter={false} grain={ids.grain} /> : null,
        )}
        {/* The selection, drawn again on top with a glow; while dragging it is the only copy, lifted off the page. */}
        <g ref={dragPenRef}>
          {selection && (
            <g filter={`url(#${dragging ? ids.lifted : ids.selected})`} opacity={dragging ? 1 : 0.9}>
              {selParts
                .filter(({ stroke }) => stroke.brush !== 'highlighter')
                .map(({ stroke, top }) => (
                  <path key={stroke.id} transform={`translate(0 ${top})`} d={strokePath(stroke)} {...strokeSvgAttrs(stroke)} />
                ))}
            </g>
          )}
          {popped && (
            <g filter={`url(#${ids.lifted})`}>
              {popped
                .filter((s) => s.brush !== 'highlighter')
                .map((s) => (
                  // Sketches drawn to match the text colour follow it here too.
                  <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} style={{ color: 'var(--text)' }} />
                ))}
            </g>
          )}
        </g>
        <path ref={livePathRef} className={cx(flash && 'ink-snap-flash')} />
        {overlay?.shape && <path d={strokePath(overlay.shape)} {...strokeSvgAttrs(overlay.shape)} />}
        {overlay?.lasso && overlay.lasso.length > 3 && <polyline className="lasso-path" points={overlay.lasso.join(' ')} style={{ strokeWidth: 1.5 * inv }} />}
        {(overlay?.snip || snip) && <SnipRect b={(overlay?.snip ?? snip!.bounds) as Bounds} inv={inv} hidden={!!snip?.capturing} />}
        {frame && !snip && !dragging && (
          <g className="sel-box" style={{ strokeWidth: inv }}>
            <rect x={frame.minX} y={frame.minY} width={frame.maxX - frame.minX} height={frame.maxY - frame.minY} rx={6 * inv} />
            {frameCorners(frame).map(([x, y], i) => (
              <circle key={i} className="sel-handle" cx={x} cy={y} r={5 * inv} />
            ))}
          </g>
        )}
        {dragging && (
          <g className="drag-guides">
            <line ref={ruleRef} className="snap-rule" display="none" style={{ strokeWidth: 2 * inv }} />
            <line ref={baseRef} className="snap-base" display="none" style={{ strokeWidth: 2 * inv }} />
            <line ref={edgeRef} className="snap-edge" display="none" style={{ strokeWidth: inv, strokeDasharray: `${3 * inv} ${3 * inv}` }} />
            <path ref={caretRef} className="drop-caret" display="none" style={{ strokeWidth: 2 * inv }} />
            <rect ref={roomRef} className="room-band" display="none" rx={6 * inv} />
            <line ref={roomLineRef} className="room-line" display="none" style={{ strokeWidth: 3 * inv }} />
            <rect ref={dragBoxRef} className="drag-box" display="none" rx={6 * inv} style={{ strokeWidth: inv, strokeDasharray: `${4 * inv} ${4 * inv}` }} />
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

      {selection && frame && !held && !quiet && (
        <SelectionMenu
          frame={frame}
          inv={inv}
          scale={scale || 1}
          count={selection.items.length}
          onAsk={(mode) => {
            props.onAsk({
              mode,
              strokes: selectedStrokesAbs(),
              blockIds: [...new Set(selection.items.map((i) => i.blockId))],
              label: 'Selected handwriting',
            });
          }}
          onConvert={(to) => props.onConvert({ to, strokes: selectedStrokesAbs(), selection: selection.items })}
          onColor={(color) => editSelected((s) => ({ ...s, id: s.id, color }))}
          onDuplicate={() => duplicateSelection()}
          onCopy={() => {
            clipboard = selectedStrokesAbs();
          }}
          onDelete={deleteSelection}
          highlighterOnly={selParts.every(({ stroke }) => stroke.brush === 'highlighter')}
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
  /** The selection's frame (with its handles at the corners). */
  frame: Bounds;
  inv: number;
  scale: number;
  count: number;
  highlighterOnly: boolean;
  onAsk(mode: AskMode): void;
  onConvert(to: 'text' | 'math'): void;
  onColor(c: string): void;
  onDuplicate(): void;
  onCopy(): void;
  onDelete(): void;
}) {
  const { frame, inv, scale } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  // Clear of the frame and its handles: above it, unless that would put it under the toolbar.
  const gap = 8 * inv;
  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest('.note-scroll');
    if (!el || !scroller) return;
    const check = () => {
      const wrapTop = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0;
      const dock = scroller.querySelector('.toolbar-dock')?.getBoundingClientRect();
      const limit = Math.max(scroller.getBoundingClientRect().top, dock?.bottom ?? 0) + 6;
      setBelow(wrapTop + (frame.minY - 5 * inv - gap) * scale - el.offsetHeight < limit);
    };
    check();
    scroller.addEventListener('scroll', check, { passive: true });
    return () => scroller.removeEventListener('scroll', check);
  }, [frame, inv, scale, gap]);
  const colors = props.highlighterOnly ? HIGHLIGHT_COLORS.slice(0, 5) : INK_COLORS.filter((_, i) => [0, 2, 5, 7, 8, 10].includes(i));
  // (5: the handles' radius)
  const top = below ? frame.maxY + 5 * inv + gap : frame.minY - 5 * inv - gap;
  const left = (frame.minX + frame.maxX) / 2;
  return (
    <div
      ref={ref}
      className="ink-sel-menu"
      data-ui
      data-strokes={props.count}
      style={{ left, top, transform: `translate(-50%, ${below ? '0' : '-100%'}) scale(${inv})`, transformOrigin: below ? '50% 0' : '50% 100%' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="sel-btn" onClick={() => props.onAsk('explain')} title="Ask about this">
        <MessageCircleQuestion size={14} /> Ask
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
