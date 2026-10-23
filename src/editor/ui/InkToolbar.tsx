import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  Check,
  ChevronDown,
  Eraser,
  Highlighter,
  ListChecks,
  MoreHorizontal,
  PenLine,
  Plus,
  Redo2,
  Sigma,
  Signature,
  SquareDashedMousePointer,
  Type,
  Undo2,
} from 'lucide-react';
import { useInkHint, useTools } from '../../state/tools';
import { useSettings } from '../../state/settings';
import { BRUSHES, ERASER_SIZES, HIGHLIGHT_COLORS, HIGHLIGHTER_RANGE, INK_COLORS, MARKER_RANGE } from '../../lib/ink/brushes';
import type { Tool } from '../../lib/ink/types';
import type { NoteDoc } from '../../lib/vault/types';
import { Popover } from '../../components/common/Popover';
import { cx } from '../../lib/util';
import { ALT, MOD } from '../../lib/platform';
import { editorBus } from '../bus';
import { FormatPanel } from './FormatPanel';
import { MoreMenu } from './PagePanels';

const ICON = { size: 18, strokeWidth: 1.75 } as const;

const TOOLS: { id: Tool; label: string; icon: ReactNode; key: string }[] = [
  { id: 'text', label: 'Type', icon: <Type {...ICON} />, key: 'T' },
  { id: 'pen', label: 'Marker', icon: <PenLine {...ICON} />, key: 'P' },
  { id: 'highlighter', label: 'Highlighter', icon: <Highlighter {...ICON} />, key: 'H' },
  { id: 'eraser', label: 'Eraser', icon: <Eraser {...ICON} />, key: 'E' },
  { id: 'lasso', label: 'Select', icon: <SquareDashedMousePointer {...ICON} />, key: 'S' },
];

const SIZE_NAMES = ['Fine', 'Medium', 'Bold'];

type Pop = null | 'size' | 'slot' | 'custom' | 'format' | 'more' | 'summary';
type InkKind = 'pen' | 'highlighter';

/** A tooltip with the shortcut after the label. */
function Tip({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="tb-tip" role="tooltip">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  );
}

/** Light colours need an edge to show on white, and a dark check. */
function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}

/** How thick a size slot's sample line is drawn in the bar. */
const lineFor = (kind: InkKind, size: number) => (kind === 'highlighter' ? Math.max(3, Math.min(9, size / 3)) : Math.max(1.5, Math.min(6.5, size * 1.6)));

/**
 * The note's tool bar: a calm floating bar over the page (GoodNotes' tools, Claude's surfaces). Undo and redo,
 * the five tools, then what the current tool can be set to, then the note's ⋯ menu. The tools never move:
 * nothing before them changes width. When the bar would not fit, the tool's options fold into one button.
 */
export function InkToolbar({ editor, note }: { editor: Editor; note: NoteDoc }) {
  const t = useTools();
  const font = useSettings((s) => s.font);
  const dropHint = useInkHint((s) => s.hint);
  const [pop, setPop] = useState<Pop>(null);
  const [slot, setSlot] = useState<{ kind: InkKind; index: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  /** Which tools' settings are folded into one button, and the width their bar needed when they folded. */
  const [foldedFor, setFoldedFor] = useState<Record<string, boolean>>({});
  const needed = useRef<Record<string, number>>({});

  const ed = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      task: e.isActive('taskList'),
    }),
  });

  const open = (which: Pop, el: HTMLElement | null) => {
    // Opened from inside the folded settings, which close: hang it from the folded button instead.
    anchorRef.current = el?.closest('.tool-pop.is-summary') ? summaryRef.current : el;
    setPop((p) => (p === which ? null : which));
  };
  const close = () => setPop(null);

  const pickTool = (id: Tool) => {
    setPop(null);
    t.setTool(id);
    if (id !== 'text') (editor.view.dom as HTMLElement).blur();
    else editor.commands.focus();
  };

  // Fold the options when the bar doesn't fit beside the page; unfold when the room comes back. (What is on
  // screen decides, not React state: a measure can run while a fold is still on its way.)
  const foldKey = dropHint ? 'hint' : t.tool;
  useLayoutEffect(() => {
    const bar = barRef.current;
    const dock = bar?.closest('.toolbar-dock') as HTMLElement | null;
    if (!bar || !dock) return;
    const measure = () => {
      if (!bar.offsetParent) return;
      const room = dock.getBoundingClientRect().right - bar.getBoundingClientRect().left - 12;
      // (a hint, which can't fold, shortens to fit instead)
      bar.style.maxWidth = `${Math.max(0, Math.floor(room))}px`;
      const shown = bar.classList.contains('is-folded');
      let next = shown;
      if (!shown && bar.scrollWidth > room + 0.5) {
        needed.current[foldKey] = bar.scrollWidth;
        next = true;
      } else if (shown && room >= (needed.current[foldKey] ?? Infinity)) next = false;
      if (next !== shown) setFoldedFor((f) => ({ ...f, [foldKey]: next }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [foldKey]);

  const inkKind: InkKind = t.tool === 'highlighter' ? 'highlighter' : 'pen';
  const current = (kind: InkKind) => (kind === 'highlighter' ? t.highlighter : t.pen);
  const setCurrent = (kind: InkKind, p: { color?: string; size?: number }) => (kind === 'highlighter' ? t.setHighlighter(p) : t.setPen(p));

  const sizes = (kind: InkKind) => {
    const list = kind === 'highlighter' ? t.highlighterSizes : t.penSizes;
    const now = current(kind).size;
    return (
      <div className="tb-group tb-sizes" role="group" aria-label="Size">
        {list.map((s, i) => {
          const on = Math.abs(now - s) < 0.01;
          return (
            <button
              key={i}
              className={cx('tb-size', on && 'is-active', pop === 'size' && slot?.index === i && slot.kind === kind && 'is-open')}
              onClick={(e) => {
                // The active size, clicked again, opens its slider: it retunes that slot.
                if (on) {
                  setSlot({ kind, index: i });
                  open('size', e.currentTarget);
                } else setCurrent(kind, { size: s });
              }}
              aria-label={SIZE_NAMES[i]}
              aria-pressed={on}
            >
              <span className={cx('tb-line', kind === 'highlighter' && 'is-hl')} style={{ height: lineFor(kind, s) }} />
              <Tip label={on ? `${SIZE_NAMES[i]} · click to adjust` : SIZE_NAMES[i]} />
            </button>
          );
        })}
      </div>
    );
  };

  const swatches = (kind: InkKind) => {
    const list = kind === 'highlighter' ? t.highlighterColors : t.penColors;
    const now = current(kind).color;
    return (
      <div className="tb-group tb-swatches" role="group" aria-label="Color">
        {list.map((c, i) => {
          const on = now === c;
          return (
            <button
              key={i}
              className={cx('tb-swatch', on && 'is-active', isLight(c) && 'is-light', kind === 'highlighter' && 'is-hl')}
              onClick={(e) => {
                // The active colour, clicked again, can be changed.
                if (on) {
                  setSlot({ kind, index: i });
                  open('slot', e.currentTarget);
                } else setCurrent(kind, { color: c });
              }}
              aria-label={`Color ${i + 1}`}
              aria-pressed={on}
            >
              <span style={{ background: c }} />
              <Tip label={on ? 'Click to change this color' : 'Color'} />
            </button>
          );
        })}
        <button className="tb-swatch is-more" onClick={(e) => open('custom', e.currentTarget)} aria-label="More colors">
          <span>
            <Plus size={11} strokeWidth={2.25} />
          </span>
          <Tip label="More colors" />
        </button>
      </div>
    );
  };

  /** The current tool's settings: in the bar, or in the folded button's popover. */
  const options = (): ReactNode => {
    switch (t.tool) {
      case 'pen':
      case 'highlighter':
        return (
          <>
            {sizes(inkKind)}
            <span className="tb-sep is-inner" />
            {swatches(inkKind)}
          </>
        );
      case 'eraser':
        return (
          <>
            <div className="tb-group tb-sizes" role="group" aria-label="Size">
              {ERASER_SIZES.map((s, i) => (
                <button
                  key={s}
                  className={cx('tb-size', t.eraser.size === s && 'is-active')}
                  onClick={() => t.setEraser({ size: s })}
                  aria-label={SIZE_NAMES[i]}
                  aria-pressed={t.eraser.size === s}
                >
                  <span className="tb-ring" style={{ width: 5 + s / 3.4, height: 5 + s / 3.4 }} />
                  <Tip label={SIZE_NAMES[i]} />
                </button>
              ))}
            </div>
            <div className="tb-seg seg" role="radiogroup" aria-label="Erase">
              <button
                role="radio"
                aria-checked={t.eraser.mode === 'stroke'}
                className={cx(t.eraser.mode === 'stroke' && 'is-active')}
                onClick={() => t.setEraser({ mode: 'stroke' })}
              >
                Whole stroke
              </button>
              <button
                role="radio"
                aria-checked={t.eraser.mode === 'precise'}
                className={cx(t.eraser.mode === 'precise' && 'is-active')}
                onClick={() => t.setEraser({ mode: 'precise' })}
              >
                Part
              </button>
            </div>
            <button
              className={cx('tb-chip', t.eraser.highlighterOnly && 'is-on')}
              onClick={() => t.setEraser({ highlighterOnly: !t.eraser.highlighterOnly })}
              aria-pressed={t.eraser.highlighterOnly}
            >
              Highlighter only
            </button>
          </>
        );
      case 'text':
        return (
          <>
            {aa}
            {textTools}
          </>
        );
      default:
        return null;
    }
  };

  const aa = (
    <button className={cx('tb-btn tb-aa', pop === 'format' && 'is-open')} onClick={(e) => open('format', e.currentTarget)} aria-label="Text style">
      <span className="tb-aa-label">Aa</span>
      <ChevronDown size={13} strokeWidth={2} />
      <Tip label="Text style" />
    </button>
  );
  const textTools = (
    <>
      <button
        className={cx('tb-btn', ed.task && 'is-on')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        aria-label="Checklist"
        aria-pressed={ed.task}
      >
        <ListChecks {...ICON} />
        <Tip label="Checklist" kbd="[]" />
      </button>
      <button className="tb-btn" onClick={() => editor.chain().focus().insertMathInline('').run()} aria-label="Insert math">
        <Sigma {...ICON} />
        <Tip label="Math" kbd="$x$" />
      </button>
      <button className="tb-btn" onClick={() => editorBus.emit('inlineInk:open', { editor })} aria-label="Sketch inline">
        <Signature {...ICON} />
        <Tip label="Sketch inline" kbd={`${MOD}D`} />
      </button>
    </>
  );

  // (Select has no options: its tooltip says what it does.)
  const context: ReactNode = dropHint ? <div className="tb-hint is-drop">{dropHint}</div> : t.tool === 'lasso' ? null : options();
  const foldable = !dropHint && t.tool !== 'lasso';
  const fold = !!foldedFor[foldKey] && foldable;

  // (Type folds into its own Aa button: checklist, math and sketch join the style panel.)
  const summary =
    t.tool === 'text' ? (
      aa
    ) : (
      <button
        ref={summaryRef}
        className={cx('tb-btn tb-summary', pop === 'summary' && 'is-open')}
        onClick={(e) => open('summary', e.currentTarget)}
        aria-label="Tool options"
      >
        {t.tool === 'eraser' ? (
          <span className="tb-ring" style={{ width: 5 + t.eraser.size / 3.4, height: 5 + t.eraser.size / 3.4 }} />
        ) : (
          <>
            <span className={cx('tb-summary-dot', isLight(current(inkKind).color) && 'is-light')} style={{ background: current(inkKind).color }} />
            <span className={cx('tb-line', inkKind === 'highlighter' && 'is-hl')} style={{ height: lineFor(inkKind, current(inkKind).size) }} />
          </>
        )}
        <ChevronDown size={13} strokeWidth={2} />
        <Tip label="Tool options" />
      </button>
    );

  const slotValue = slot ? (slot.kind === 'highlighter' ? t.highlighterSizes : t.penSizes)[slot.index] : 0;
  const range = slot?.kind === 'highlighter' ? HIGHLIGHTER_RANGE : MARKER_RANGE;

  return (
    <div ref={barRef} className={cx('ink-toolbar', fold && 'is-folded')} data-ui data-tool={t.tool} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tb-group">
        <button className="tb-btn" disabled={!ed.canUndo} onClick={() => editor.chain().focus().undo().run()} aria-label="Undo">
          <Undo2 {...ICON} />
          <Tip label="Undo" kbd={`${MOD}Z`} />
        </button>
        <button className="tb-btn" disabled={!ed.canRedo} onClick={() => editor.chain().focus().redo().run()} aria-label="Redo">
          <Redo2 {...ICON} />
          <Tip label="Redo" kbd={`⇧${MOD}Z`} />
        </button>
      </div>
      <span className="tb-sep" />
      <div className="tb-group tb-tools" role="toolbar" aria-label="Tools">
        {TOOLS.map((tool) => {
          const on = t.tool === tool.id;
          const ink = tool.id === 'pen' ? t.pen.color : tool.id === 'highlighter' ? t.highlighter.color : null;
          return (
            <button
              key={tool.id}
              className={cx('tb-btn tb-tool', on && 'is-active')}
              data-tool={tool.id}
              onClick={() => pickTool(tool.id)}
              aria-label={tool.label}
              aria-pressed={on}
            >
              {tool.icon}
              {ink && <span className={cx('tb-tool-ink', tool.id === 'highlighter' && 'is-hl')} style={{ background: ink }} />}
              <Tip label={tool.label} kbd={`${ALT}${tool.key}`} />
            </button>
          );
        })}
      </div>
      {context && <span className="tb-sep" />}
      {context && <div className="tb-context">{fold ? summary : context}</div>}
      <span className="tb-sep" />
      <button className={cx('tb-btn tb-more', pop === 'more' && 'is-open')} onClick={(e) => open('more', e.currentTarget)} aria-label="More">
        <MoreHorizontal {...ICON} />
        <Tip label="More" />
      </button>

      {/* Popovers */}
      <Popover anchor={anchorRef.current} open={pop === 'summary'} onClose={close} align="start" className="tool-pop is-summary">
        <div className="tb-summary-body">{options()}</div>
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'size'} onClose={close} className="tool-pop is-size">
        {slot && (
          <div className="pop-section">
            <div className="pop-label">{SIZE_NAMES[slot.index]}</div>
            <div className="size-preview">
              <span
                className={cx('tb-line', slot.kind === 'highlighter' && 'is-hl')}
                style={{ height: slot.kind === 'highlighter' ? slotValue / 2 : slotValue * BRUSHES.marker.sizeScale, background: current(slot.kind).color }}
              />
            </div>
            <input
              className="slider"
              type="range"
              aria-label={`${SIZE_NAMES[slot.index]} size`}
              min={range.min}
              max={range.max}
              step={slot.kind === 'highlighter' ? 1 : 0.1}
              value={slotValue}
              style={{ '--pct': `${((slotValue - range.min) / (range.max - range.min)) * 100}%` } as React.CSSProperties}
              onChange={(e) => {
                const v = slot.kind === 'highlighter' ? Number(e.target.value) : Math.round(Number(e.target.value) * 10) / 10;
                t.setQuickSize(slot.kind, slot.index, v);
                setCurrent(slot.kind, { size: v });
              }}
            />
          </div>
        )}
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'slot'} onClose={close} className="tool-pop is-narrow">
        {slot && (
          <ColorSection
            colors={(slot.kind === 'pen' ? INK_COLORS : HIGHLIGHT_COLORS).map((c) => c.value)}
            value={(slot.kind === 'pen' ? t.penColors : t.highlighterColors)[slot.index]}
            recent={slot.kind === 'pen' ? t.recentColors : []}
            highlighter={slot.kind === 'highlighter'}
            onPick={(c) => {
              t.setQuickColor(slot.kind, slot.index, c);
              setCurrent(slot.kind, { color: c });
              if (slot.kind === 'pen') t.pushRecentColor(c);
            }}
          />
        )}
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'custom'} onClose={close} className="tool-pop is-narrow">
        <ColorSection
          colors={(inkKind === 'pen' ? INK_COLORS : HIGHLIGHT_COLORS).map((c) => c.value)}
          value={current(inkKind).color}
          recent={inkKind === 'pen' ? t.recentColors : []}
          highlighter={inkKind === 'highlighter'}
          onPick={(c) => {
            setCurrent(inkKind, { color: c });
            if (inkKind === 'pen') t.pushRecentColor(c);
          }}
        />
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'format'} onClose={close} align="start" className={`tool-pop is-format font-${font}`}>
        <FormatPanel editor={editor} onDone={close} more={fold && t.tool === 'text' ? <div className="fmt-more">{textTools}</div> : undefined} />
      </Popover>

      <Popover anchor={anchorRef.current} open={pop === 'more'} onClose={close} align="end" className="menu-pop">
        <MoreMenu note={note} onDone={close} />
      </Popover>
    </div>
  );
}

export function ColorSection({
  colors,
  value,
  recent,
  onPick,
  highlighter,
}: {
  colors: string[];
  value: string;
  recent: string[];
  onPick(c: string): void;
  highlighter?: boolean;
}) {
  const extra = recent.filter((c) => !colors.includes(c));
  return (
    <div className="pop-section">
      <div className={cx('swatch-grid', highlighter && 'is-hl')}>
        {[...colors, ...extra].map((c) => (
          <button key={c} className={cx('swatch', value === c && 'is-active', isLight(c) && 'is-light')} onClick={() => onPick(c)} aria-label={c}>
            <span style={{ background: c }} />
            {value === c && <Check size={12} strokeWidth={3} />}
          </button>
        ))}
        <label className="swatch is-custom" title="Custom color">
          <Plus size={14} />
          <input type="color" value={value.startsWith('#') ? value : '#000000'} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}
