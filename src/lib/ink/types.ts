/**
 * Ink data model.
 *
 * Strokes are stored inside the ProseMirror document as block attributes so
 * that typing and handwriting share a single undo history and a single file.
 * Coordinates are in CSS pixels at 100% zoom:
 *   x — relative to the left edge of the text column
 *   y — relative to the top of the block that owns the stroke
 * so a stroke drawn over a paragraph moves with that paragraph when text above
 * it is edited.
 */

export type Brush = 'fountain' | 'ballpoint' | 'brush' | 'pencil' | 'marker' | 'highlighter' | 'mono';

export interface Stroke {
  id: string;
  brush: Brush;
  /** Any CSS color, or `currentColor` to follow the surrounding text color. */
  color: string;
  /** Nominal width in px. */
  size: number;
  /** Flat [x, y, pressure, x, y, pressure, …] list. */
  pts: number[];
  /** True when pressure came from a real stylus (otherwise it is simulated). */
  pressure?: boolean;
  /** Mono strokes only: render as a closed polygon. */
  closed?: boolean;
  /** Overrides the brush's default opacity. */
  opacity?: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 'pen' is the felt marker and 'lasso' the Select rectangle; the ids are what older notes and settings saved. */
export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso';
export type Tool = 'text' | InkTool;
/** Tools that are gone (the Shapes tool, Ask about an area); setTool still takes them from older callers. */
export type LegacyTool = 'shapes' | 'ask';

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle';
export type EraserMode = 'stroke' | 'precise';

/** What a local vision model read from a handwriting area. */
export interface InkTranscript {
  kind: 'text' | 'math' | 'mixed' | 'drawing';
  /** Plain transcription; math inline as $…$. */
  text: string;
  /** Display LaTeX when the content is primarily math. */
  latex?: string;
  /** Short description for drawings/diagrams. */
  description?: string;
  model?: string;
  at: number;
  /** Set when strokes changed after transcription. */
  stale?: boolean;
}

/** Attributes of an inline sketch embedded in a line of text. */
export interface InlineInkAttrs {
  strokes: Stroke[];
  /** Box size in capture pixels. */
  w: number;
  h: number;
  /** Capture pixels per em, so the sketch scales with the surrounding font. */
  em: number;
  /** How far the box bottom sits below the text baseline, in capture pixels. */
  drop: number;
  transcript?: string | null;
  /** How much it was shrunk to fit its line of text (1: not at all), so pulling it out restores its size. */
  fit?: number;
}
