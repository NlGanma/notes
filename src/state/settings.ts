import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Paper } from '../lib/paper';
import { migrateSettings, SETTINGS_VERSION } from './migrate';

export type { Paper };
export type FontChoice = 'sans' | 'serif' | 'mono';
export type PageSize = 'letter' | 'a4';
export type LineSpacing = 'compact' | 'comfortable' | 'roomy';

export const LINE_PX: Record<LineSpacing, number> = { compact: 28, comfortable: 32, roomy: 40 };
export const PAGE_WIDTH: Record<PageSize, number> = { letter: 816, a4: 794 };

export interface WritingSettings {
  /** The paper last picked when making a note: the next one starts on it. There is no separate default. */
  paper: Paper;
  font: FontChoice;
  pageSize: PageSize;
  lineSpacing: LineSpacing;
  /** Fit the page to narrow windows. */
  fitWidth: boolean;
  smartSuggestions: boolean;
  spellcheck: boolean;
  set(p: Partial<Omit<WritingSettings, 'set'>>): void;
}

export const useSettings = create<WritingSettings>()(
  persist(
    (set) => ({
      paper: 'ruled',
      font: 'sans',
      pageSize: 'letter',
      lineSpacing: 'comfortable',
      fitWidth: true,
      smartSuggestions: true,
      spellcheck: true,
      set: (p) => set(p),
    }),
    { name: 'nib.settings', version: SETTINGS_VERSION, migrate: (s, v) => migrateSettings(s, v) as unknown as WritingSettings },
  ),
);
