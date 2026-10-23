import { BRUSHES } from '../lib/ink/brushes';
import type { Brush } from '../lib/ink/types';
import { normalizePaper } from '../lib/paper';

/*
 * What older versions saved in localStorage, brought up to date when a store loads. Each function takes
 * whatever was stored (anything, possibly hand-edited) and the version it was stored at. Pure, so the
 * unit tests can feed them old states directly.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export const UI_VERSION = 1;
export const TOOLS_VERSION = 1;
export const SETTINGS_VERSION = 1;

const VIEW_KINDS = new Set(['classes', 'home', 'note', 'folder', 'trash', 'library', 'class', 'homework', 'review']);

/** A saved page the app can still show: labels, Favorites and Recent became All notes; Classroom-only fields go. */
export function migrateView(v: unknown): Obj {
  if (!isObj(v) || typeof v.kind !== 'string') return { kind: 'classes' };
  if (v.kind === 'tag' || v.kind === 'favorites' || v.kind === 'recent') return { kind: 'home' };
  if (!VIEW_KINDS.has(v.kind)) return { kind: 'classes' };
  if (v.kind === 'classes') return { kind: 'classes' };
  if (v.kind === 'class') return typeof v.path === 'string' ? { kind: 'class', path: v.path } : { kind: 'classes' };
  if (v.kind === 'homework') return { kind: 'homework' };
  if ((v.kind === 'folder' && typeof v.path !== 'string') || (v.kind === 'note' && typeof v.id !== 'string')) return { kind: 'classes' };
  return v;
}

/** nib.ui: v0 → v1. */
export function migrateUI(persisted: unknown, version: number): Obj {
  const s: Obj = isObj(persisted) ? { ...persisted } : {};
  if (version < 1) {
    s.view = migrateView(s.view);
    // A hidden sidebar used to leave an icon rail; there is no rail now, so it would leave no navigation at all.
    s.sidebar = true;
    const scope = s.libraryScope;
    if (!isObj(scope) || scope.kind === 'tag') s.libraryScope = { kind: 'all' };
    delete s.gridMode;
  }
  return s;
}

const PEN_SLOTS = [1.1, 1.6, 2.5];

/** The marker size whose stroke looks closest to what an old pen drew (compares rendered widths). */
export function markerSizeFor(size: number, brush: string): number {
  const scale = BRUSHES[brush as Brush]?.sizeScale ?? 1;
  const width = (Number(size) || 1.6) * scale;
  const target = width / BRUSHES.marker.sizeScale;
  return PEN_SLOTS.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), PEN_SLOTS[0]);
}

/** nib.tools: v0 → v1. The felt marker is the only pen; the Shapes and Ask tools are gone. */
export function migrateTools(persisted: unknown, version: number): Obj {
  const s: Obj = isObj(persisted) ? { ...persisted } : {};
  if (version < 1) {
    if (isObj(s.pen)) {
      const pen = s.pen;
      s.pen = { ...pen, brush: 'marker', size: markerSizeFor(Number(pen.size), String(pen.brush ?? 'marker')) };
    }
    s.penSizes = [...PEN_SLOTS];
    delete s.shape;
  }
  return settleTools(s);
}

/**
 * nib.tools on every load, whatever its version: the Shapes and Ask tools are on their way out, so they never
 * come back as the tool Esc returns to. (The toolbar still offers Shapes for now, so a v1 user can save it again.)
 */
export function settleTools(persisted: unknown): Obj {
  const s: Obj = isObj(persisted) ? { ...persisted } : {};
  if (s.lastInkTool === 'shapes') s.lastInkTool = 'pen';
  if (s.lastInkTool === 'ask') s.lastInkTool = 'lasso';
  return s;
}

/** nib.settings: v0 → v1. Dotted and legal-pad paper became Squared and Lined. */
export function migrateSettings(persisted: unknown, version: number): Obj {
  const s: Obj = isObj(persisted) ? { ...persisted } : {};
  if (version < 1 && 'paper' in s) s.paper = normalizePaper(s.paper);
  return s;
}
