import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Eraser, Palette, Undo2 } from 'lucide-react';
import type { InlineInkAttrs, Stroke } from '../../lib/ink/types';
import { livePath, strokePath, strokeSvgAttrs } from '../../lib/ink/render';
import { compactPoints, simplifyPoints, strokeBounds, translateStroke, unionBounds } from '../../lib/ink/geometry';
import { useTools } from '../../state/tools';
import { BRUSHES } from '../../lib/ink/brushes';
import { cx, uid } from '../../lib/util';

const W = 440;
const H = 160;
const CAP = 46; // cap line
const BASE = 104; // baseline
const EM = (BASE - CAP) / 0.7; // capture pixels per em (cap height ≈ 0.7em)

export interface InkPadState {
  editor: Editor;
  /** Position of an existing inline sketch being edited. */
  pos?: number;
}

/**
 * The inline sketch pad (⌘D): draw a symbol that is too awkward to type —
 * an arrow, a Greek letter, a chemical structure — and it drops into the
 * sentence at the caret, scaled to the text and sitting on its baseline.
 */
export function InkPad({ state, onClose, onPopOut }: { state: InkPadState; onClose(): void; onPopOut?(pos: number): void }) {
  const { editor, pos } = state;
  const tools = useTools();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [matchText, setMatchText] = useState(true);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const liveRef = useRef<SVGPathElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const savedSel = useRef(editor.state.selection);

  // Load an existing sketch for editing.
  useEffect(() => {
    if (typeof pos !== 'number') return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'inkInline') return;
    const a = node.attrs as InlineInkAttrs;
    const k = EM / a.em;
    const x0 = 24;
    const y0 = BASE + a.drop * k - a.h * k;
    setStrokes(
      a.strokes.map((s) => {
        const pts = s.pts.slice();
        for (let i = 0; i + 1 < pts.length; i += 3) {
          pts[i] = x0 + pts[i] * k;
          pts[i + 1] = y0 + pts[i + 1] * k;
        }
        return { ...s, pts, size: s.size * k };
      }),
    );
    setMatchText(a.strokes.every((s) => s.color === 'currentColor'));
  }, [editor, pos]);

  useLayoutEffect(() => {
    const view = editor.view;
    const at = typeof pos === 'number' ? pos : editor.state.selection.from;
    const r = view.coordsAtPos(at);
    const w = boxRef.current?.offsetWidth ?? W + 24;
    const h = boxRef.current?.offsetHeight ?? H + 80;
    let top = r.bottom + 10;
    if (top + h > window.innerHeight - 12) top = r.top - h - 10;
    setAnchor({ left: Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 40)), top: Math.max(12, top) });
  }, [editor, pos]);

  // The pad is drawn big and shrunk into the line. The same felt marker, about 2.2× its width on the page, which
  // is how thick sketches have always come out in the text.
  const scale = BRUSHES.marker.sizeScale;
  const penSize = Math.max(4.5, Math.min(14, tools.pen.size * scale * 2.2)) / scale;
  const color = matchText ? 'currentColor' : tools.pen.color;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = local(e);
    drawing.current = {
      id: uid('s'),
      brush: 'marker',
      color,
      size: penSize,
      pts: [p.x, p.y, e.pointerType === 'pen' ? e.pressure : 0.5],
      pressure: e.pointerType === 'pen',
    };
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = drawing.current;
    if (!s) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = local(ev);
      s.pts.push(p.x, p.y, ev.pointerType === 'pen' ? ev.pressure : 0.5);
    }
    liveRef.current?.setAttribute('d', livePath(s));
  };
  const onUp = () => {
    const s = drawing.current;
    drawing.current = null;
    liveRef.current?.setAttribute('d', '');
    if (!s) return;
    setStrokes((list) => [...list, { ...s, pts: compactPoints(simplifyPoints(s.pts, 0.6)) }]);
  };

  const insert = () => {
    if (!strokes.length) {
      onClose();
      return;
    }
    const bb = unionBounds(strokes.map(strokeBounds))!;
    const attrs: InlineInkAttrs = {
      strokes: strokes.map((s) => ({ ...translateStroke(s, -bb.minX, -bb.minY), color: matchText ? 'currentColor' : s.color })),
      w: Math.round((bb.maxX - bb.minX) * 100) / 100,
      h: Math.round((bb.maxY - bb.minY) * 100) / 100,
      em: EM,
      drop: Math.round((bb.maxY - BASE) * 100) / 100,
      transcript: null,
    };
    const { state: s } = editor;
    let tr = s.tr;
    if (typeof pos === 'number' && s.doc.nodeAt(pos)?.type.name === 'inkInline') {
      tr = tr.setNodeMarkup(pos, undefined, attrs);
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    } else {
      const sel = savedSel.current;
      const from = Math.min(sel.from, s.doc.content.size);
      const to = sel instanceof NodeSelection ? from : Math.min(sel.to, s.doc.content.size);
      tr = tr.replaceWith(from, to, editor.schema.nodes.inkInline.create(attrs));
      tr.setSelection(TextSelection.create(tr.doc, from + 1));
    }
    editor.view.dispatch(tr);
    onClose();
    requestAnimationFrame(() => editor.view.focus());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        editor.view.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        insert();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        setStrokes((l) => l.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return createPortal(
    <div className="inkpad-backdrop" onPointerDown={(e) => e.target === e.currentTarget && insert()}>
      <div ref={boxRef} className="inkpad" style={{ left: anchor?.left ?? -9999, top: anchor?.top ?? -9999 }} data-ui>
        <div className="inkpad-head">
          <span className="inkpad-title">Sketch inline</span>
          <span className="inkpad-sub">Write between the guides. It sits on the line like text.</span>
        </div>
        <svg
          ref={svgRef}
          className="inkpad-canvas"
          viewBox={`0 0 ${W} ${H}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{ color: 'var(--text)' }}
        >
          <line x1="0" x2={W} y1={CAP} y2={CAP} className="inkpad-guide is-cap" />
          <line x1="0" x2={W} y1={BASE} y2={BASE} className="inkpad-guide" />
          <text x="10" y={BASE - 6} className="inkpad-sample">
            Aa
          </text>
          {strokes.map((s) => (
            <path key={s.id} d={strokePath(s)} {...strokeSvgAttrs(s)} fill={s.brush === 'mono' ? 'none' : matchText ? 'currentColor' : s.color} />
          ))}
          <path ref={liveRef} fill={matchText ? 'currentColor' : tools.pen.color} />
        </svg>
        <div className="inkpad-foot">
          <button className="icon-btn" onClick={() => setStrokes((l) => l.slice(0, -1))} disabled={!strokes.length} title="Undo stroke">
            <Undo2 size={15} />
          </button>
          <button className="icon-btn" onClick={() => setStrokes([])} disabled={!strokes.length} title="Clear">
            <Eraser size={15} />
          </button>
          <button className={cx('chip', matchText && 'is-on')} onClick={() => setMatchText((v) => !v)} title="Use the color of the surrounding text">
            <Palette size={13} /> {matchText ? 'Matches text color' : 'Marker color'}
          </button>
          <span className="grow" />
          {typeof pos === 'number' && onPopOut && (
            <button className="btn is-ghost" onClick={() => onPopOut(pos)} title="Turn it back into handwriting on the page">
              Pop out
            </button>
          )}
          <button className="btn is-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn is-primary" onClick={insert} disabled={!strokes.length}>
            {typeof pos === 'number' ? 'Update' : 'Insert'} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
