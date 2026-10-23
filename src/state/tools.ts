import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Brush, EraserMode, InkTool, ShapeKind, Tool } from '../lib/ink/types';
import { migrateTools, TOOLS_VERSION } from './migrate';

export interface PenSettings {
  brush: Brush;
  color: string;
  size: number;
}

export interface ToolState {
  tool: Tool;
  /** The ink tool to return to when leaving text mode (Esc). */
  lastInkTool: InkTool;
  pen: PenSettings;
  highlighter: { color: string; size: number; straighten: boolean };
  eraser: { mode: EraserMode; size: number; highlighterOnly: boolean };
  shape: { kind: ShapeKind };
  /** Three quick-access colours / sizes per tool, editable by the user. */
  penColors: string[];
  penSizes: number[];
  highlighterColors: string[];
  recentColors: string[];
  /** With a stylus, the pen always draws and the mouse / trackpad always types. */
  stylusDraws: boolean;
  /** Hold still at the end of a stroke to snap it into a clean shape. */
  holdToSnap: boolean;
  setTool(tool: Tool): void;
  setPen(p: Partial<PenSettings>): void;
  setHighlighter(p: Partial<ToolState['highlighter']>): void;
  setEraser(p: Partial<ToolState['eraser']>): void;
  setShape(kind: ShapeKind): void;
  setQuickColor(tool: 'pen' | 'highlighter', index: number, color: string): void;
  setQuickSize(index: number, size: number): void;
  pushRecentColor(color: string): void;
  set(p: Partial<Pick<ToolState, 'stylusDraws' | 'holdToSnap'>>): void;
}

/** A line for the toolbar while ink is being dragged: what letting go will do. */
export const useInkHint = create<{ hint: string | null; setHint(hint: string | null): void }>((set) => ({
  hint: null,
  setHint: (hint) => set({ hint }),
}));

export const useTools = create<ToolState>()(
  persist(
    (set, get) => ({
      tool: 'text',
      lastInkTool: 'pen',
      pen: { brush: 'fountain', color: '#1c1c1e', size: 2.2 },
      highlighter: { color: '#ffe14d', size: 16, straighten: true },
      eraser: { mode: 'stroke', size: 18, highlighterOnly: false },
      shape: { kind: 'rect' },
      penColors: ['#1c1c1e', '#2160e8', '#dc2b2b'],
      penSizes: [1.4, 2.2, 3.6],
      highlighterColors: ['#ffe14d', '#8ef0a8', '#ffa3cf'],
      recentColors: [],
      stylusDraws: true,
      holdToSnap: true,
      setTool: (tool) => set(() => (tool === 'text' ? { tool } : { tool, lastInkTool: tool === 'ask' ? get().lastInkTool : tool })),
      setPen: (p) => set((s) => ({ pen: { ...s.pen, ...p } })),
      setHighlighter: (p) => set((s) => ({ highlighter: { ...s.highlighter, ...p } })),
      setEraser: (p) => set((s) => ({ eraser: { ...s.eraser, ...p } })),
      setShape: (kind) => set({ shape: { kind } }),
      setQuickColor: (tool, index, color) =>
        set((s) => {
          const key = tool === 'pen' ? 'penColors' : 'highlighterColors';
          const list = [...s[key]];
          list[index] = color;
          return { [key]: list } as Partial<ToolState>;
        }),
      setQuickSize: (index, size) =>
        set((s) => {
          const list = [...s.penSizes];
          list[index] = size;
          return { penSizes: list };
        }),
      pushRecentColor: (color) => set((s) => ({ recentColors: [color, ...s.recentColors.filter((c) => c !== color)].slice(0, 6) })),
      set: (p) => set(p),
    }),
    {
      name: 'nib.tools',
      version: TOOLS_VERSION,
      migrate: (s, v) => migrateTools(s, v) as unknown as ToolState,
      partialize: (s) => ({
        pen: s.pen,
        highlighter: s.highlighter,
        eraser: s.eraser,
        shape: s.shape,
        penColors: s.penColors,
        penSizes: s.penSizes,
        highlighterColors: s.highlighterColors,
        recentColors: s.recentColors,
        stylusDraws: s.stylusDraws,
        holdToSnap: s.holdToSnap,
        lastInkTool: s.lastInkTool,
      }),
    },
  ),
);
