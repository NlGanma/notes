import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  ArrowUpRight,
  Bold,
  ChevronDown,
  Circle,
  Eraser,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Lasso,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  PenLine,
  Pilcrow,
  Plus,
  Redo2,
  Shapes,
  Sigma,
  Signature,
  MessageCircleQuestion,
  Square,
  Triangle,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { useInkHint, useTools } from '../../state/tools';
import { BRUSHES, HIGHLIGHT_COLORS, INK_COLORS, PEN_BRUSHES, TEXT_HIGHLIGHTS } from '../../lib/ink/brushes';
import type { Brush, ShapeKind, Stroke, Tool } from '../../lib/ink/types';
import { strokePath, strokeSvgAttrs } from '../../lib/ink/render';
import { Popover } from '../../components/common/Popover';
import { cx } from '../../lib/util';
import { ALT, MOD } from '../../lib/platform';
import { editorBus } from '../bus';

const TOOLS: { id: Tool; label: string; icon: ReactNode; key: string }[] = [
  { id: 'text', label: 'Type', icon: <Type size={17} />, key: 'T' },
  { id: 'pen', label: 'Pen', icon: <PenLine size={17} />, key: 'P' },
  { id: 'highlighter', label: 'Highlighter', icon: <Highlighter size={17} />, key: 'H' },
  { id: 'eraser', label: 'Eraser', icon: <Eraser size={17} />, key: 'E' },
  { id: 'lasso', label: 'Lasso', icon: <Lasso size={17} />, key: 'L' },
  { id: 'shapes', label: 'Shapes', icon: <Shapes size={17} />, key: 'S' },
];

const SHAPES: { id: ShapeKind; label: string; icon: ReactNode }[] = [
  { id: 'line', label: 'Line', icon: <Minus size={16} /> },
  { id: 'arrow', label: 'Arrow', icon: <ArrowUpRight size={16} /> },
  { id: 'rect', label: 'Rectangle', icon: <Square size={15} /> },
  { id: 'ellipse', label: 'Ellipse', icon: <Circle size={15} /> },
  { id: 'triangle', label: 'Triangle', icon: <Triangle size={15} /> },
];

/** A sample squiggle used to preview brushes and sizes. */
function sampleStroke(brush: Brush, size: number, color: string, width = 64, height = 22): Stroke {
  const pts: number[] = [];
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = 4 + t * (width - 8);
    const y = height / 2 + Math.sin(t * Math.PI * 2) * (height / 2 - 5);
    const p = 0.35 + 0.55 * Math.sin(t * Math.PI);
    pts.push(x, y, p);
  }
  return { id: `sample-${brush}-${size}-${color}`, brush, size, color, pts, pressure: true };
}

function BrushPreview({ brush, size, color, width = 64, height = 22 }: { brush: Brush; size: number; color: string; width?: number; height?: number }) {
  const s = useMemo(() => sampleStroke(brush, size, color, width, height), [brush, size, color, width, height]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="brush-preview">
      <path d={strokePath(s)} {...strokeSvgAttrs(s)} />
    </svg>
  );
}

function Tip({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="tb-tip" role="tooltip">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  );
}

export function InkToolbar({ editor }: { editor: Editor }) {
  const t = useTools();
  const dropHint = useInkHint((s) => s.hint);
  const [pop, setPop] = useState<null | 'pen' | 'highlighter' | 'eraser' | 'slot' | 'textStyle' | 'textHl'>(null);
  const [slot, setSlot] = useState<{ tool: 'pen' | 'highlighter'; index: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const ed = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      highlight: e.isActive('highlight'),
    }),
  });

  const open = (which: typeof pop, el: HTMLElement | null) => {
    anchorRef.current = el;
    setPop((p) => (p === which ? null : which));
  };

  const pickTool = (id: Tool, el: HTMLElement) => {
    if (t.tool === id && (id === 'pen' || id === 'highlighter' || id === 'eraser')) {
      open(id, el);
      return;
    }
    setPop(null);
    t.setTool(id);
    if (id !== 'text') (editor.view.dom as HTMLElement).blur();
    else editor.commands.focus();
  };

  const quickColors = t.tool === 'highlighter' ? t.highlighterColors : t.penColors;
  const activeColor = t.tool === 'highlighter' ? t.highlighter.color : t.pen.color;
  const styleLabel = ed.h1 ? 'Heading 1' : ed.h2 ? 'Heading 2' : ed.h3 ? 'Heading 3' : 'Text';

  return (
    <div className="ink-toolbar" data-ui onPointerDown={(e) => e.stopPropagation()}>
      <div className="tb-group tb-history">
        <button className="tb-btn" disabled={!ed.canUndo} onClick={() => editor.chain().focus().undo().run()} aria-label="Undo">
          <Undo2 size={16} />
          <Tip label="Undo" kbd={`${MOD}Z`} />
        </button>
        <button className="tb-btn" disabled={!ed.canRedo} onClick={() => editor.chain().focus().redo().run()} aria-label="Redo">
          <Redo2 size={16} />
          <Tip label="Redo" kbd={`⇧${MOD}Z`} />
        </button>
      </div>
      <span className="tb-sep" />
      <div className="tb-group tb-tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={cx('tb-btn tb-tool', t.tool === tool.id && 'is-active')}
            data-tool={tool.id}
            onClick={(e) => pickTool(tool.id, e.currentTarget)}
            aria-label={tool.label}
            aria-pressed={t.tool === tool.id}
          >
            {tool.icon}
            {tool.id === 'pen' && <span className="tb-tool-ink" style={{ background: t.pen.color }} />}
            {tool.id === 'highlighter' && <span className="tb-tool-ink is-hl" style={{ background: t.highlighter.color }} />}
            <Tip label={tool.label} kbd={`${ALT}${tool.key}`} />
          </button>
        ))}
        <button
          className={cx('tb-btn tb-tool tb-ask', t.tool === 'ask' && 'is-active')}
          data-tool="ask"
          onClick={(e) => pickTool('ask', e.currentTarget)}
          aria-label="Ask AI about an area"
        >
          <MessageCircleQuestion size={16} />
          <span className="tb-ask-label">Ask</span>
          <Tip label="Drag over anything on the page to ask your AI" kbd={`${ALT}A`} />
        </button>
      </div>
      <span className="tb-sep" />

      {/* Contextual controls */}
      {(t.tool === 'pen' || t.tool === 'highlighter' || t.tool === 'shapes') && (
        <div className="tb-group">
          {(t.tool === 'shapes' ? t.penColors : quickColors).map((c, i) => (
            <button
              key={i}
              className={cx('tb-swatch', activeColor === c && 'is-active')}
              onClick={(e) => {
                if (activeColor === c) {
                  setSlot({ tool: t.tool === 'highlighter' ? 'highlighter' : 'pen', index: i });
                  open('slot', e.currentTarget);
                  return;
                }
                if (t.tool === 'highlighter') t.setHighlighter({ color: c });
                else t.setPen({ color: c });
              }}
              aria-label={`Colour ${i + 1}`}
            >
              <span style={{ background: c }} className={t.tool === 'highlighter' ? 'is-hl' : undefined} />
              <Tip label={activeColor === c ? 'Click again to change this colour' : 'Colour'} />
            </button>
          ))}
        </div>
      )}
      {(t.tool === 'pen' || t.tool === 'shapes') && (
        <div className="tb-group">
          {t.penSizes.map((s, i) => (
            <button
              key={i}
              className={cx('tb-size', Math.abs(t.pen.size - s) < 0.01 && 'is-active')}
              onClick={() => t.setPen({ size: s })}
              aria-label={`Size ${s}`}
            >
              <span style={{ width: 3 + s * 1.5, height: 3 + s * 1.5, background: t.pen.color }} />
              <Tip label={`${s.toFixed(1)} pt`} />
            </button>
          ))}
        </div>
      )}
      {t.tool === 'pen' && (
        <button className="tb-btn tb-brush" onClick={(e) => open('pen', e.currentTarget)} aria-label="Pen type">
          <BrushPreview brush={t.pen.brush} size={Math.min(t.pen.size, 3)} color={t.pen.color} width={40} height={18} />
          <ChevronDown size={13} />
          <Tip label={`${BRUSHES[t.pen.brush].label} — change pen`} />
        </button>
      )}
      {t.tool === 'highlighter' && (
        <div className="tb-group">
          {[10, 16, 24].map((s) => (
            <button
              key={s}
              className={cx('tb-size', t.highlighter.size === s && 'is-active')}
              onClick={() => t.setHighlighter({ size: s })}
              aria-label={`Size ${s}`}
            >
              <span className="is-bar" style={{ height: s / 2.4, background: t.highlighter.color }} />
            </button>
          ))}
          <button className="tb-btn" onClick={(e) => open('highlighter', e.currentTarget)} aria-label="Highlighter options">
            <ChevronDown size={14} />
          </button>
        </div>
      )}
      {t.tool === 'shapes' && (
        <div className="tb-group">
          {SHAPES.map((s) => (
            <button key={s.id} className={cx('tb-btn', t.shape.kind === s.id && 'is-active')} onClick={() => t.setShape(s.id)} aria-label={s.label}>
              {s.icon}
              <Tip label={s.label} kbd="⇧ to constrain" />
            </button>
          ))}
        </div>
      )}
      {t.tool === 'eraser' && (
        <div className="tb-group">
          <div className="tb-seg">
            <button className={cx(t.eraser.mode === 'stroke' && 'is-active')} onClick={() => t.setEraser({ mode: 'stroke' })}>
              Whole stroke
            </button>
            <button className={cx(t.eraser.mode === 'precise' && 'is-active')} onClick={() => t.setEraser({ mode: 'precise' })}>
              Precise
            </button>
          </div>
          {[8, 18, 36].map((s) => (
            <button key={s} className={cx('tb-size', t.eraser.size === s && 'is-active')} onClick={() => t.setEraser({ size: s })} aria-label={`Eraser ${s}`}>
              <span className="is-ring" style={{ width: 4 + s / 2.4, height: 4 + s / 2.4 }} />
            </button>
          ))}
          <button
            className={cx('tb-chip', t.eraser.highlighterOnly && 'is-active')}
            onClick={() => t.setEraser({ highlighterOnly: !t.eraser.highlighterOnly })}
          >
            Highlighter only
          </button>
        </div>
      )}
      {t.tool === 'lasso' && <div className={cx('tb-hint', dropHint && 'is-drop')}>{dropHint ?? 'Drag ink to move · circle to select · ⌥ skips snapping'}</div>}
      {t.tool === 'ask' && <div className="tb-hint is-ai">Drag over handwriting, text or math to ask your local AI</div>}
      {t.tool === 'text' && (
        <div className="tb-group">
          <button className="tb-btn tb-style" onClick={(e) => open('textStyle', e.currentTarget)}>
            <span>{styleLabel}</span>
            <ChevronDown size={13} />
          </button>
          <button className={cx('tb-btn', ed.bold && 'is-active')} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold">
            <Bold size={15} />
            <Tip label="Bold" kbd={`${MOD}B`} />
          </button>
          <button className={cx('tb-btn', ed.italic && 'is-active')} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic">
            <Italic size={15} />
            <Tip label="Italic" kbd={`${MOD}I`} />
          </button>
          <button className={cx('tb-btn', ed.underline && 'is-active')} onClick={() => editor.chain().focus().toggleUnderline().run()} aria-label="Underline">
            <Underline size={15} />
            <Tip label="Underline" kbd={`${MOD}U`} />
          </button>
          <button className={cx('tb-btn', ed.highlight && 'is-active')} onClick={(e) => open('textHl', e.currentTarget)} aria-label="Highlight">
            <Highlighter size={15} />
            <Tip label="Highlight text" kbd={`⇧${MOD}H`} />
          </button>
          <span className="tb-text-extra">
            <span className="tb-sep is-thin" />
            <button
              className={cx('tb-btn', ed.bullet && 'is-active')}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              aria-label="Bulleted list"
            >
              <List size={15} />
              <Tip label="Bulleted list" kbd="-" />
            </button>
            <button
              className={cx('tb-btn', ed.ordered && 'is-active')}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              aria-label="Numbered list"
            >
              <ListOrdered size={15} />
              <Tip label="Numbered list" kbd="1." />
            </button>
            <button className={cx('tb-btn', ed.task && 'is-active')} onClick={() => editor.chain().focus().toggleTaskList().run()} aria-label="Checklist">
              <ListChecks size={15} />
              <Tip label="Checklist" kbd="[]" />
            </button>
            <span className="tb-sep is-thin" />
            <button className="tb-btn" onClick={() => editor.chain().focus().insertMathInline('').run()} aria-label="Insert math">
              <Sigma size={15} />
              <Tip label="Math" kbd="$x$" />
            </button>
            <button className="tb-btn" onClick={() => editorBus.emit('inlineInk:open', { editor })} aria-label="Inline sketch">
              <Signature size={15} />
              <Tip label="Sketch a symbol inline" kbd={`${MOD}D`} />
            </button>
          </span>
        </div>
      )}

      {/* Popovers */}
      <Popover anchor={anchorRef.current} open={pop === 'pen'} onClose={() => setPop(null)} className="tool-pop">
        <div className="pop-section">
          <div className="pop-label">Pen</div>
          <div className="brush-grid">
            {PEN_BRUSHES.map((b) => (
              <button key={b} className={cx('brush-tile', t.pen.brush === b && 'is-active')} onClick={() => t.setPen({ brush: b })}>
                <BrushPreview brush={b} size={Math.max(2, Math.min(t.pen.size, 3.4))} color={t.pen.color} width={92} height={26} />
                <span className="brush-name">{BRUSHES[b].label}</span>
              </button>
            ))}
          </div>
        </div>
        <ColorSection
          colors={INK_COLORS.map((c) => c.value)}
          value={t.pen.color}
          recent={t.recentColors}
          onPick={(c) => {
            t.setPen({ color: c });
            t.pushRecentColor(c);
          }}
        />
        <SizeSection
          value={t.pen.size}
          min={0.8}
          max={12}
          step={0.1}
          onChange={(v) => t.setPen({ size: Math.round(v * 10) / 10 })}
          preview={<BrushPreview brush={t.pen.brush} size={t.pen.size} color={t.pen.color} width={200} height={34} />}
        />
        <div className="pop-section pop-toggles">
          <Toggle checked={t.holdToSnap} onChange={(v) => t.set({ holdToSnap: v })} label="Hold to snap shapes" hint="Draw a circle, line or box and pause" />
          <Toggle
            checked={t.stylusDraws}
            onChange={(v) => t.set({ stylusDraws: v })}
            label="Stylus always draws"
            hint="With a tablet or Sidecar pencil, the mouse keeps typing"
          />
        </div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'highlighter'} onClose={() => setPop(null)} className="tool-pop">
        <ColorSection
          colors={HIGHLIGHT_COLORS.map((c) => c.value)}
          value={t.highlighter.color}
          recent={[]}
          onPick={(c) => t.setHighlighter({ color: c })}
          highlighter
        />
        <SizeSection
          value={t.highlighter.size}
          min={6}
          max={40}
          step={1}
          onChange={(v) => t.setHighlighter({ size: v })}
          preview={<BrushPreview brush="highlighter" size={t.highlighter.size} color={t.highlighter.color} width={200} height={44} />}
        />
        <div className="pop-section pop-toggles">
          <Toggle
            checked={t.highlighter.straighten}
            onChange={(v) => t.setHighlighter({ straighten: v })}
            label="Straighten strokes"
            hint="Swipes become perfectly straight"
          />
        </div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'slot'} onClose={() => setPop(null)} className="tool-pop is-narrow">
        {slot && (
          <ColorSection
            title="Change this colour"
            colors={(slot.tool === 'pen' ? INK_COLORS : HIGHLIGHT_COLORS).map((c) => c.value)}
            value={slot.tool === 'pen' ? t.penColors[slot.index] : t.highlighterColors[slot.index]}
            recent={slot.tool === 'pen' ? t.recentColors : []}
            highlighter={slot.tool === 'highlighter'}
            onPick={(c) => {
              t.setQuickColor(slot.tool, slot.index, c);
              if (slot.tool === 'pen') {
                t.setPen({ color: c });
                t.pushRecentColor(c);
              } else t.setHighlighter({ color: c });
            }}
          />
        )}
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'textStyle'} onClose={() => setPop(null)} className="menu-pop">
        <div className="menu">
          {[
            { label: 'Text', icon: <Pilcrow size={15} />, run: () => editor.chain().focus().setParagraph().run(), kbd: `${MOD}${ALT}0` },
            { label: 'Heading 1', icon: <Heading1 size={15} />, run: () => editor.chain().focus().setHeading({ level: 1 }).run(), kbd: '#' },
            { label: 'Heading 2', icon: <Heading2 size={15} />, run: () => editor.chain().focus().setHeading({ level: 2 }).run(), kbd: '##' },
            { label: 'Heading 3', icon: <Heading3 size={15} />, run: () => editor.chain().focus().setHeading({ level: 3 }).run(), kbd: '###' },
          ].map((it) => (
            <button
              key={it.label}
              className="menu-item"
              onClick={() => {
                it.run();
                setPop(null);
              }}
            >
              {it.icon}
              <span className="menu-label">{it.label}</span>
              <span className="menu-hint">{it.kbd}</span>
            </button>
          ))}
        </div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'textHl'} onClose={() => setPop(null)} className="tool-pop is-narrow">
        <div className="pop-section">
          <div className="pop-label">Highlight</div>
          <div className="swatch-row">
            {TEXT_HIGHLIGHTS.map((c) => (
              <button
                key={c.value}
                className="swatch"
                title={c.name}
                onClick={() => {
                  editor.chain().focus().toggleHighlight({ color: c.value }).run();
                  setPop(null);
                }}
              >
                <span style={{ background: c.value }} />
              </button>
            ))}
            <button
              className="swatch is-none"
              title="Remove"
              onClick={() => {
                editor.chain().focus().unsetHighlight().run();
                setPop(null);
              }}
            >
              <span />
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

export function ColorSection({
  title = 'Colour',
  colors,
  value,
  recent,
  onPick,
  highlighter,
}: {
  title?: string;
  colors: string[];
  value: string;
  recent: string[];
  onPick(c: string): void;
  highlighter?: boolean;
}) {
  const extra = recent.filter((c) => !colors.includes(c));
  return (
    <div className="pop-section">
      <div className="pop-label">{title}</div>
      <div className={cx('swatch-grid', highlighter && 'is-hl')}>
        {colors.map((c) => (
          <button key={c} className={cx('swatch', value === c && 'is-active')} onClick={() => onPick(c)} aria-label={c}>
            <span style={{ background: c }} />
          </button>
        ))}
        {extra.map((c) => (
          <button key={c} className={cx('swatch', value === c && 'is-active')} onClick={() => onPick(c)} aria-label={c}>
            <span style={{ background: c }} />
          </button>
        ))}
        <label className="swatch is-custom" title="Custom colour">
          <Plus size={13} />
          <input type="color" value={value.startsWith('#') ? value : '#000000'} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function SizeSection({
  value,
  min,
  max,
  step,
  onChange,
  preview,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
  preview: ReactNode;
}) {
  return (
    <div className="pop-section">
      <div className="pop-label">
        Thickness <span className="pop-value">{value.toFixed(step < 1 ? 1 : 0)} pt</span>
      </div>
      <div className="size-preview">{preview}</div>
      <input className="slider" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <span className={cx('switch', checked && 'is-on')}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}
