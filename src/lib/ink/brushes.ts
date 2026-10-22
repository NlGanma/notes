import type { Brush } from './types';

export interface BrushDef {
  id: Brush;
  label: string;
  description: string;
  thinning: number;
  smoothing: number;
  streamline: number;
  taperStart: number;
  taperEnd: number;
  opacity: number;
  /** Multiplier applied to the nominal size when building the outline. */
  sizeScale: number;
  blend?: 'multiply';
  texture?: 'grain';
}

export const BRUSHES: Record<Brush, BrushDef> = {
  fountain: {
    id: 'fountain',
    label: 'Fountain pen',
    description: 'Pressure-sensitive, elegant line variation',
    thinning: 0.62,
    smoothing: 0.62,
    streamline: 0.42,
    taperStart: 0,
    taperEnd: 6,
    opacity: 1,
    sizeScale: 1.25,
  },
  ballpoint: {
    id: 'ballpoint',
    label: 'Ballpoint',
    description: 'Even, precise line for neat writing',
    thinning: 0.16,
    smoothing: 0.6,
    streamline: 0.48,
    taperStart: 0,
    taperEnd: 0,
    opacity: 1,
    sizeScale: 1,
  },
  brush: {
    id: 'brush',
    label: 'Brush pen',
    description: 'Expressive strokes with tapered ends',
    thinning: 0.82,
    smoothing: 0.66,
    streamline: 0.5,
    taperStart: 14,
    taperEnd: 22,
    opacity: 1,
    sizeScale: 1.7,
  },
  pencil: {
    id: 'pencil',
    label: 'Pencil',
    description: 'Soft graphite with a light paper grain',
    thinning: 0.3,
    smoothing: 0.5,
    streamline: 0.38,
    taperStart: 2,
    taperEnd: 6,
    opacity: 0.86,
    sizeScale: 1.05,
    texture: 'grain',
  },
  marker: {
    id: 'marker',
    label: 'Felt marker',
    description: 'Bold, uniform strokes for diagrams',
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.5,
    taperStart: 0,
    taperEnd: 0,
    opacity: 0.94,
    sizeScale: 1.6,
  },
  highlighter: {
    id: 'highlighter',
    label: 'Highlighter',
    description: 'Translucent, never covers text',
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.62,
    taperStart: 0,
    taperEnd: 0,
    opacity: 0.42,
    sizeScale: 1,
    blend: 'multiply',
  },
  mono: {
    id: 'mono',
    label: 'Shape',
    description: 'Clean geometric line',
    thinning: 0,
    smoothing: 0,
    streamline: 0,
    taperStart: 0,
    taperEnd: 0,
    opacity: 1,
    sizeScale: 1,
  },
};

export const PEN_BRUSHES: Brush[] = ['fountain', 'ballpoint', 'brush', 'pencil', 'marker'];

export interface Swatch {
  name: string;
  value: string;
}

export const INK_COLORS: Swatch[] = [
  { name: 'Ink', value: '#1c1c1e' },
  { name: 'Graphite', value: '#6b7079' },
  { name: 'Blue', value: '#2160e8' },
  { name: 'Navy', value: '#1f3a8a' },
  { name: 'Teal', value: '#0f8073' },
  { name: 'Green', value: '#1f9d4c' },
  { name: 'Amber', value: '#c98a04' },
  { name: 'Orange', value: '#e35d14' },
  { name: 'Red', value: '#dc2b2b' },
  { name: 'Rose', value: '#d62f7a' },
  { name: 'Violet', value: '#7346e6' },
  { name: 'Brown', value: '#8a4b1f' },
];

export const HIGHLIGHT_COLORS: Swatch[] = [
  { name: 'Yellow', value: '#ffe14d' },
  { name: 'Green', value: '#8ef0a8' },
  { name: 'Blue', value: '#8cc6ff' },
  { name: 'Pink', value: '#ffa3cf' },
  { name: 'Orange', value: '#ffbf73' },
  { name: 'Purple', value: '#cbb6ff' },
];

/** Colours offered for typed text and text highlights. */
export const TEXT_COLORS: Swatch[] = [
  { name: 'Default', value: '' },
  { name: 'Gray', value: '#787774' },
  { name: 'Blue', value: '#2160e8' },
  { name: 'Teal', value: '#0f8073' },
  { name: 'Green', value: '#1f9d4c' },
  { name: 'Orange', value: '#e35d14' },
  { name: 'Red', value: '#dc2b2b' },
  { name: 'Violet', value: '#7346e6' },
];

export const TEXT_HIGHLIGHTS: Swatch[] = [
  { name: 'Yellow', value: '#fff3a3' },
  { name: 'Green', value: '#d3f8dc' },
  { name: 'Blue', value: '#d8ebff' },
  { name: 'Pink', value: '#ffe0ef' },
  { name: 'Orange', value: '#ffe8cc' },
  { name: 'Purple', value: '#ece4ff' },
];

export const PEN_SIZES = [1.4, 2.2, 3.2, 4.6, 6.4];
export const HIGHLIGHTER_SIZES = [10, 16, 24];
export const ERASER_SIZES = [8, 18, 36];
