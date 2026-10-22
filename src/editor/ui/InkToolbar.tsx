import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  ArrowUpRight,
  Bold,
  Check,
  ChevronDown,
  Circle,
  Eraser,
  Highlighter,
  Italic,
  Lasso,
  ListChecks,
  MessageCircleQuestion,
  Minus,
  MoreHorizontal,
  NotebookText,
  PenLine,
  Plus,
  Redo2,
  Shapes,
  Sigma,
  Signature,
  Square,
  Strikethrough,
  Triangle,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { useInkHint, useTools } from '../../state/tools';
import { BRUSHES, HIGHLIGHT_COLORS, INK_COLORS, PEN_BRUSHES } from '../../lib/ink/brushes';
import type { Brush, ShapeKind, Stroke, Tool } from '../../lib/ink/types';
import type { NoteDoc } from '../../lib/vault/types';
import { strokePath, strokeSvgAttrs } from '../../lib/ink/render';
import { Popover } from '../../components/common/Popover';
import { cx } from '../../lib/util';
import { ALT, MOD } from '../../lib/platform';
import { editorBus } from '../bus';
import { FormatPanel } from './FormatPanel';
import { MoreMenu, PaperPanel } from './PagePanels';
import { BG_COLORS } from './palette';

const TOOLS: { id: Tool; label: string; icon: (color?: string) => ReactNode; key: string }[] = [
  { id: 'text', label: 'Type', icon: () => <Type size={20} />, key: 'T' },
  // The active pen is painted in its ink (GoodNotes), so the colour reads without looking at the dots.
  { id: 'pen', label: 'Pen', icon: (c) => <PenLine size={20} fill={c ?? 'none'} />, key: 'P' },
  { id: 'highlighter', label: 'Highlighter', icon: () => <Highlighter size={20} />, key: 'H' },
  { id: 'eraser', label: 'Eraser', icon: () => <Eraser size={20} />, key: 'E' },
  { id: 'lasso', label: 'Lasso', icon: () => <Lasso size={20} />, key: 'L' },
  { id: 'shapes', label: 'Shapes', icon: () => <Shapes size={20} />, key: 'S' },
  { id: 'ask', label: 'Ask about an area', icon: () => <MessageCircleQuestion size={20} />, key: 'A' },
];

const SHAPES: { id: ShapeKind; label: string; icon: ReactNode }[] = [
  { id: 'line', label: 'Line', icon: <Minus size={20} /> },
  { id: 'arrow', label: 'Arrow', icon: <ArrowUpRight size={20} /> },
  { id: 'rect', label: 'Rectangle', icon: <Square size={18} /> },
  { id: 'ellipse', label: 'Ellipse', icon: <Circle size={18} /> },
  { id: 'triangle', label: 'Triangle', icon: <Triangle size={18} /> },
];

const HL_SIZES = [10, 16, 24];
const ERASER_SIZES = [8, 18, 36];

type Pop = null | 'pen' | 'highlighter' | 'eraser' | 'slot' | 'custom' | 'format' | 'textHl' | 'paper' | 'more' | 'summary';

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

/** M3 plain tooltip with the shortcut after the label. */
function Tip({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="tb-tip" role="tooltip">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  );
}

/** Light colours need an edge to show on the bar, and a dark check. */
function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}

/**
 * The tool row: GoodNotes 6's contents (undo/redo at the left, the tools centred, presets hanging off them,
 * page controls at the right) in Google Docs' GM3 toolbar shape.
 */
export function InkToolbar({ editor, note }: { editor: Editor; note: NoteDoc }) {
  const t = useTools();
  const dropHint = useInkHint((s) => s.hint);
  const [pop, setPop] = useState<Pop>(null);
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
      strike: e.isActive('strike'),
      task: e.isActive('taskList'),
      highlight: e.isActive('highlight'),
      hlColor: (e.getAttributes('highlight').color as string | undefined) ?? '',
    }),
  });

  const open = (which: Pop, el: HTMLElement | null) => {
    anchorRef.current = el;
    setPop((p) => (p === which ? null : which));
  };
  const close = () => setPop(null);

  const pickTool = (id: Tool, el: HTMLElement) => {
    // Tapping the active pen, highlighter or eraser again opens its settings (GoodNotes).
    if (t.tool === id && (id === 'pen' || id === 'highlighter' || id === 'eraser')) {
      open(id, el);
      return;
    }
    setPop(null);
    t.setTool(id);
    if (id !== 'text') (editor.view.dom as HTMLElement).blur();
    else editor.commands.focus();
  };

  const inkTool = t.tool === 'highlighter' ? 'highlighter' : 'pen';
  const activeColor = inkTool === 'highlighter' ? t.highlighter.color : t.pen.color;

  const swatches = (tool: 'pen' | 'highlighter') => {
    const list = tool === 'highlighter' ? t.highlighterColors : t.penColors;
    const current = tool === 'highlighter' ? t.highlighter.color : t.pen.color;
    return (
      <div className="tb-group tb-swatches">
        {list.map((c, i) => {
          const on = current === c;
          return (
            <button
              key={i}
              className={cx('tb-swatch', on && 'is-active', isLight(c) && 'is-light')}
              onClick={(e) => {
                if (on) {
                  setSlot({ tool, index: i });
                  open('slot', e.currentTarget);
                  return;
                }
                if (tool === 'highlighter') t.setHighlighter({ color: c });
                else t.setPen({ color: c });
              }}
              aria-label={`Colour ${i + 1}`}
              aria-pressed={on}
            >
              <span style={{ background: c }} />
              {on && <Check size={11} strokeWidth={3} />}
              <Tip label={on ? 'Click again to change this colour' : 'Colour'} />
            </button>
          );
        })}
        <button className="tb-swatch is-custom" onClick={(e) => open('custom', e.currentTarget)} aria-label="More colours">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
            <circle cx="10" cy="10" r="8.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
          </svg>
          <span className="tb-swatch-plus">
            <Plus size={8} strokeWidth={3} />
          </span>
          <Tip label="More colours" />
        </button>
      </div>
    );
  };

  const lineSizes = () => (
    <div className="tb-group tb-sizes">
      {t.penSizes.map((s, i) => {
        const on = Math.abs(t.pen.size - s) < 0.01;
        return (
          <button
            key={i}
            className={cx('tb-size', on && 'is-active')}
            onClick={(e) => (on && t.tool === 'pen' ? open('pen', e.currentTarget) : t.setPen({ size: s }))}
            aria-label={`Size ${s}`}
            aria-pressed={on}
          >
            <span className="tb-line" style={{ height: Math.max(1.5, Math.min(6, s * 1.3)) }} />
            <Tip label={on && t.tool === 'pen' ? 'Pen settings' : `${s.toFixed(1)} pt`} />
          </button>
        );
      })}
    </div>
  );

  /** The presets for the current tool: inline on wide windows, in the summary popover on narrow ones. */
  const options = (): ReactNode => {
    switch (t.tool) {
      case 'pen':
        return (
          <>
            {lineSizes()}
            {swatches('pen')}
          </>
        );
      case 'highlighter':
        return (
          <>
            <div className="tb-group tb-sizes">
              {HL_SIZES.map((s) => (
                <button
                  key={s}
                  className={cx('tb-size', t.highlighter.size === s && 'is-active')}
                  onClick={(e) => (t.highlighter.size === s ? open('highlighter', e.currentTarget) : t.setHighlighter({ size: s }))}
                  aria-label={`Size ${s}`}
                  aria-pressed={t.highlighter.size === s}
                >
                  <span className="tb-line" style={{ height: s / 2.6 }} />
                  <Tip label={`${s} pt`} />
                </button>
              ))}
            </div>
            {swatches('highlighter')}
          </>
        );
      case 'eraser':
        return (
          <>
            <div className="tb-group tb-sizes">
              {ERASER_SIZES.map((s) => (
                <button
                  key={s}
                  className={cx('tb-size', t.eraser.size === s && 'is-active')}
                  onClick={() => t.setEraser({ size: s })}
                  aria-label={`Eraser ${s}`}
                  aria-pressed={t.eraser.size === s}
                >
                  <span className="tb-ring" style={{ width: 4 + s / 3.2, height: 4 + s / 3.2 }} />
                  <Tip label={`${s} pt`} />
                </button>
              ))}
            </div>
            <div className="tb-seg seg">
              <button className={cx(t.eraser.mode === 'stroke' && 'is-active')} onClick={() => t.setEraser({ mode: 'stroke' })}>
                Stroke
              </button>
              <button className={cx(t.eraser.mode === 'precise' && 'is-active')} onClick={() => t.setEraser({ mode: 'precise' })}>
                Precise
              </button>
            </div>
            <button
              className={cx('tb-chip', 'tb-x1', t.eraser.highlighterOnly && 'is-active')}
              onClick={() => t.setEraser({ highlighterOnly: !t.eraser.highlighterOnly })}
              aria-pressed={t.eraser.highlighterOnly}
            >
              {t.eraser.highlighterOnly && <Check size={16} />}
              Highlighter only
            </button>
          </>
        );
      case 'shapes':
        return (
          <>
            <div className="tb-group">
              {SHAPES.map((s) => (
                <button
                  key={s.id}
                  className={cx('tb-btn is-mark', t.shape.kind === s.id && 'is-active')}
                  onClick={() => t.setShape(s.id)}
                  aria-label={s.label}
                  aria-pressed={t.shape.kind === s.id}
                >
                  {s.icon}
                  <Tip label={s.label} kbd="⇧ constrains" />
                </button>
              ))}
            </div>
            <span className="tb-sep is-inner tb-x1" />
            <div className="tb-x1">{lineSizes()}</div>
            {swatches('pen')}
          </>
        );
      default:
        return null;
    }
  };

  const textOptions = (
    <div className="tb-group tb-format">
      <button className={cx('tb-btn tb-aa', pop === 'format' && 'is-open')} onClick={(e) => open('format', e.currentTarget)} aria-label="Text style">
        <span className="tb-aa-label">Aa</span>
        <ChevronDown size={14} />
        <Tip label="Format" />
      </button>
      <button className={cx('tb-btn is-mark tb-x2', ed.bold && 'is-active')} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold">
        <Bold size={20} />
        <Tip label="Bold" kbd={`${MOD}B`} />
      </button>
      <button className={cx('tb-btn is-mark tb-x2', ed.italic && 'is-active')} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic">
        <Italic size={20} />
        <Tip label="Italic" kbd={`${MOD}I`} />
      </button>
      <button className={cx('tb-btn is-mark tb-x2', ed.underline && 'is-active')} onClick={() => editor.chain().focus().toggleUnderline().run()} aria-label="Underline">
        <Underline size={20} />
        <Tip label="Underline" kbd={`${MOD}U`} />
      </button>
      <button className={cx('tb-btn is-mark tb-x2', ed.strike && 'is-active')} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="Strikethrough">
        <Strikethrough size={20} />
        <Tip label="Strikethrough" kbd={`⇧${MOD}X`} />
      </button>
      <span className="tb-sep is-inner tb-x2" />
      <button className={cx('tb-btn tb-hl tb-x2', pop === 'textHl' && 'is-open')} onClick={(e) => open('textHl', e.currentTarget)} aria-label="Highlight colour">
        <span className="tb-hl-glyph">
          <Highlighter size={20} />
          <span style={{ background: ed.hlColor || BG_COLORS[1].value }} />
        </span>
        <ChevronDown size={14} />
        <Tip label="Highlight" kbd={`⇧${MOD}H`} />
      </button>
      <button className={cx('tb-btn is-mark tb-x1', ed.task && 'is-active')} onClick={() => editor.chain().focus().toggleTaskList().run()} aria-label="Checklist">
        <ListChecks size={20} />
        <Tip label="Checklist" kbd="[]" />
      </button>
      <button className="tb-btn is-mark tb-x1" onClick={() => editor.chain().focus().insertMathInline('').run()} aria-label="Insert math">
        <Sigma size={20} />
        <Tip label="Math" kbd="$x$" />
      </button>
      <button className="tb-btn is-mark tb-x1" onClick={() => editorBus.emit('inlineInk:open', { editor })} aria-label="Inline sketch">
        <Signature size={20} />
        <Tip label="Sketch inline" kbd={`${MOD}D`} />
      </button>
    </div>
  );

  let context: ReactNode;
  if (dropHint) context = <div className="tb-hint is-drop">{dropHint}</div>;
  else if (t.tool === 'text') context = textOptions;
  else if (t.tool === 'lasso') context = <div className="tb-hint">Drag ink to move · circle to select · ⌥ skips snapping</div>;
  else if (t.tool === 'ask') context = <div className="tb-hint">Drag over anything on the page to ask about it · Esc to cancel</div>;
  else context = options();
  const hasSummary = !dropHint && (t.tool === 'pen' || t.tool === 'highlighter' || t.tool === 'eraser' || t.tool === 'shapes');

  return (
    <div className="ink-toolbar" data-ui data-tool={t.tool} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tb-start">
        <button className="tb-btn" disabled={!ed.canUndo} onClick={() => editor.chain().focus().undo().run()} aria-label="Undo">
          <Undo2 size={20} />
          <Tip label="Undo" kbd={`${MOD}Z`} />
        </button>
        <button className="tb-btn" disabled={!ed.canRedo} onClick={() => editor.chain().focus().redo().run()} aria-label="Redo">
          <Redo2 size={20} />
          <Tip label="Redo" kbd={`⇧${MOD}Z`} />
        </button>
        <span className="tb-sep" />
      </div>

      <div className="tb-group tb-tools">
        {TOOLS.map((tool) => {
          const on = t.tool === tool.id;
          const ink = tool.id === 'pen' ? t.pen.color : tool.id === 'highlighter' ? t.highlighter.color : null;
          const reopen = on && (tool.id === 'pen' || tool.id === 'highlighter' || tool.id === 'eraser');
          return (
            <button
              key={tool.id}
              className={cx('tb-btn tb-tool', on && 'is-active')}
              data-tool={tool.id}
              onClick={(e) => pickTool(tool.id, e.currentTarget)}
              aria-label={tool.label}
              aria-pressed={on}
            >
              {tool.icon(on && tool.id === 'pen' ? t.pen.color : undefined)}
              {ink && <span className={cx('tb-tool-ink', tool.id === 'highlighter' && 'is-hl')} style={{ background: ink }} />}
              <Tip label={reopen ? `${tool.label} settings` : tool.label} kbd={reopen ? undefined : `${ALT}${tool.key}`} />
            </button>
          );
        })}
      </div>

      <div className="tb-end">
        <span className="tb-sep" />
        <div className={cx('tb-context', hasSummary && 'has-summary')}>{context}</div>
        {hasSummary && (
          <button className={cx('tb-btn tb-summary', pop === 'summary' && 'is-open')} onClick={(e) => open('summary', e.currentTarget)} aria-label="Tool options">
            {t.tool === 'eraser' ? (
              <span className="tb-ring" style={{ width: 4 + t.eraser.size / 3.2, height: 4 + t.eraser.size / 3.2 }} />
            ) : (
              <span className="tb-summary-dot" style={{ background: activeColor }} />
            )}
            <ChevronDown size={14} />
            <Tip label="Tool options" />
          </button>
        )}
        <span className="grow" />
        <button className={cx('tb-btn tb-paper', pop === 'paper' && 'is-open')} onClick={(e) => open('paper', e.currentTarget)} aria-label="Paper">
          <NotebookText size={20} />
          <Tip label="Paper" />
        </button>
        <button className={cx('tb-btn tb-more', pop === 'more' && 'is-open')} onClick={(e) => open('more', e.currentTarget)} aria-label="More">
          <MoreHorizontal size={20} />
          <Tip label="More" />
        </button>
      </div>

      {/* Popovers */}
      <Popover anchor={anchorRef.current} open={pop === 'summary'} onClose={close} align="start" className="tool-pop is-summary">
        <div className="tb-summary-body">{options()}</div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'pen'} onClose={close} className="tool-pop">
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
          preview={<BrushPreview brush={t.pen.brush} size={t.pen.size} color={t.pen.color} width={232} height={34} />}
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

      <Popover anchor={anchorRef.current} open={pop === 'highlighter'} onClose={close} className="tool-pop">
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
          preview={<BrushPreview brush="highlighter" size={t.highlighter.size} color={t.highlighter.color} width={232} height={44} />}
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

      <Popover anchor={anchorRef.current} open={pop === 'eraser'} onClose={close} className="tool-pop is-narrow">
        <div className="pop-section pop-toggles">
          <Toggle
            checked={t.eraser.mode === 'stroke'}
            onChange={(v) => t.setEraser({ mode: v ? 'stroke' : 'precise' })}
            label="Erase entire stroke"
            hint="Off: erase only what you rub over"
          />
          <Toggle checked={t.eraser.highlighterOnly} onChange={(v) => t.setEraser({ highlighterOnly: v })} label="Erase highlighter only" />
        </div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'slot'} onClose={close} className="tool-pop is-narrow">
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

      <Popover anchor={anchorRef.current} open={pop === 'custom'} onClose={close} className="tool-pop is-narrow">
        <ColorSection
          colors={(inkTool === 'pen' ? INK_COLORS : HIGHLIGHT_COLORS).map((c) => c.value)}
          value={activeColor}
          recent={inkTool === 'pen' ? t.recentColors : []}
          highlighter={inkTool === 'highlighter'}
          onPick={(c) => {
            if (inkTool === 'pen') {
              t.setPen({ color: c });
              t.pushRecentColor(c);
            } else t.setHighlighter({ color: c });
          }}
        />
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'format'} onClose={close} align="start" className="tool-pop is-format">
        <FormatPanel editor={editor} onDone={close} />
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'textHl'} onClose={close} align="start" className="tool-pop is-narrow">
        <div className="pop-section">
          <div className="pop-label">Highlight</div>
          <div className="swatch-row">
            {BG_COLORS.map((c) => (
              <button
                key={c.name}
                className={cx('swatch', !c.value && 'is-none', (c.value ? ed.hlColor === c.value : !ed.highlight) && 'is-active')}
                title={c.name === 'Default' ? 'No highlight' : c.name}
                onClick={() => {
                  if (c.value) editor.chain().focus().setHighlight({ color: c.value }).run();
                  else editor.chain().focus().unsetHighlight().run();
                  close();
                }}
              >
                <span style={{ background: c.value || undefined }} />
              </button>
            ))}
          </div>
        </div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'paper'} onClose={close} align="end" className="tool-pop is-paper">
        <PaperPanel note={note} />
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'more'} onClose={close} align="end" className="menu-pop">
        <MoreMenu note={note} onDone={close} />
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
        {[...colors, ...extra].map((c) => (
          <button key={c} className={cx('swatch', value === c && 'is-active', isLight(c) && 'is-light')} onClick={() => onPick(c)} aria-label={c}>
            <span style={{ background: c }} />
            {value === c && <Check size={12} strokeWidth={3} />}
          </button>
        ))}
        <label className="swatch is-custom" title="Custom colour">
          <Plus size={14} />
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
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
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
