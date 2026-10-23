import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EraserMode, InkTool, LegacyTool, Tool } from '../lib/ink/types';
import { HIGHLIGHTER_SIZES, MARKER_SIZES } from '../lib/ink/brushes';
import { migrateTools, settleTools, TOOLS_VERSION } from './migrate';

/** The felt marker (the one pen): every stroke it draws is brush 'marker'. */
export interface PenSettings {
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
  /** Three quick colours and sizes per tool. Clicking the active one retunes that slot. */
  penColors: string[];
  penSizes: number[];
  highlighterColors: string[];
  highlighterSizes: number[];
  recentColors: string[];
  /** With a stylus, the pen always draws and the mouse / trackpad always types. */
  stylusDraws: boolean;
  /** Hold still at the end of a stroke to snap it into a clean shape. */
  holdToSnap: boolean;
  setTool(tool: Tool | LegacyTool): void;
  setPen(p: Partial<PenSettings>): void;
  setHighlighter(p: Partial<ToolState['highlighter']>): void;
  setEraser(p: Partial<ToolState['eraser']>): void;
  setQuickColor(tool: 'pen' | 'highlighter', index: number, color: string): void;
  setQuickSize(tool: 'pen' | 'highlighter', index: number, size: number): void;
  pushRecentColor(color: string): void;
  set(p: Partial<Pick<ToolState, 'stylusDraws' | 'holdToSnap'>>): void;
}

/** A line for the toolbar while ink is being dragged: what letting go will do. */
export const useInkHint = create<{ hint: string | null; setHint(hint: string | null): void }>((set) => ({
  hint: null,
  setHint: (hint) => set({ hint }),
}));

/** Ask about an area became the Select box; the Shapes tool became hold-to-snap with the marker. */
function current(tool: Tool | LegacyTool): Tool {
  if (tool === 'ask') return 'lasso';
  if (tool === 'shapes') return 'pen';
  return tool;
}

export const useTools = create<ToolState>()(
  persist(
    (set) => ({
      tool: 'text',
      lastInkTool: 'pen',
      pen: { color: '#1c1c1e', size: MARKER_SIZES[1] },
      highlighter: { color: '#ffe14d', size: HIGHLIGHTER_SIZES[1], straighten: true },
      eraser: { mode: 'stroke', size: 18, highlighterOnly: false },
      penColors: ['#1c1c1e', '#2160e8', '#dc2b2b'],
      penSizes: [...MARKER_SIZES],
      highlighterColors: ['#ffe14d', '#8ef0a8', '#ffa3cf'],
      highlighterSizes: [...HIGHLIGHTER_SIZES],
      recentColors: [],
      stylusDraws: true,
      holdToSnap: true,
      setTool: (next) =>
        set(() => {
          const tool = current(next);
          return tool === 'text' ? { tool } : { tool, lastInkTool: tool };
        }),
      setPen: (p) => set((s) => ({ pen: { ...s.pen, ...p } })),
      setHighlighter: (p) => set((s) => ({ highlighter: { ...s.highlighter, ...p } })),
      setEraser: (p) => set((s) => ({ eraser: { ...s.eraser, ...p } })),
      setQuickColor: (tool, index, color) =>
        set((s) => {
          const key = tool === 'pen' ? 'penColors' : 'highlighterColors';
          const list = [...s[key]];
          list[index] = color;
          return { [key]: list } as Partial<ToolState>;
        }),
      setQuickSize: (tool, index, size) =>
        set((s) => {
          const key = tool === 'pen' ? 'penSizes' : 'highlighterSizes';
          const list = [...s[key]];
          list[index] = size;
          return { [key]: list } as Partial<ToolState>;
        }),
      pushRecentColor: (color) => set((s) => ({ recentColors: [color, ...s.recentColors.filter((c) => c !== color)].slice(0, 6) })),
      set: (p) => set(p),
    }),
    {
      name: 'nib.tools',
      version: TOOLS_VERSION,
      migrate: (s, v) => migrateTools(s, v) as unknown as ToolState,
      merge: (saved, current) => ({ ...current, ...settleTools(saved) }),
      partialize: (s) => ({
        pen: s.pen,
        highlighter: s.highlighter,
        eraser: s.eraser,
        penColors: s.penColors,
        penSizes: s.penSizes,
        highlighterColors: s.highlighterColors,
        highlighterSizes: s.highlighterSizes,
        recentColors: s.recentColors,
        stylusDraws: s.stylusDraws,
        holdToSnap: s.holdToSnap,
        lastInkTool: s.lastInkTool,
      }),
    },
  ),
);
