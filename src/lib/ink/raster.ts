import type { Bounds, Stroke } from './types';
import { drawStrokes } from './render';
import { strokeBounds, unionBounds } from './geometry';

export interface RasterOptions {
  /** Target size of the longest side in device pixels. */
  maxSide?: number;
  minScale?: number;
  padding?: number;
  background?: string;
}

/**
 * Renders strokes to a PNG (base64, no data: prefix) on a white background —
 * the format local vision models (llava, qwen2.5-vl, gemma3, llama3.2-vision…)
 * read best.
 */
export function rasterizeStrokes(strokes: Stroke[], bounds?: Bounds | null, opts: RasterOptions = {}): string | null {
  if (!strokes.length) return null;
  const b = bounds ?? unionBounds(strokes.map(strokeBounds));
  if (!b) return null;
  const pad = opts.padding ?? 18;
  const w = b.maxX - b.minX + pad * 2;
  const h = b.maxY - b.minY + pad * 2;
  const maxSide = opts.maxSide ?? 1024;
  const scale = Math.max(opts.minScale ?? 1, Math.min(3, maxSide / Math.max(w, h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = opts.background ?? '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - b.minX, pad - b.minY);
  drawStrokes(ctx, strokes);
  return canvas.toDataURL('image/png').split(',')[1] ?? null;
}

/** Downscales a base64 PNG so its longest side is at most `maxSide`. */
export async function downscaleImage(base64: string, maxSide = 1280, mime = 'image/png'): Promise<string> {
  const img = new Image();
  img.src = `data:${mime};base64,${base64}`;
  await img.decode();
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1 && mime === 'image/png') return base64;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}
