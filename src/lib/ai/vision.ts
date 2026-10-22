import { bridge } from '../platform';
import { downscaleImage } from '../ink/raster';

/**
 * Captures exactly what is on screen inside `rect` (CSS pixels of the window)
 * as a PNG — typed text, math, handwriting and images together. Only the
 * Mac app can do this; the browser build falls back to rendering the ink.
 */
export async function captureRegion(rect: DOMRect): Promise<string | null> {
  if (!bridge) return null;
  const pad = 6;
  const b64 = await bridge.captureRect({
    x: Math.max(0, rect.left - pad),
    y: Math.max(0, rect.top - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  });
  if (!b64) return null;
  return downscaleImage(b64, 1400);
}
