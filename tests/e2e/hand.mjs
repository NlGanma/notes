// Turns text into handwriting pen paths (Hershey "Felix" single-line font) so
// tests can drive the real pointer pipeline the way a person writes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hershey = require('hersheytext');

const CAP_UNITS = 665;

function parse(d) {
  const t = d.trim().split(/[\s,]+/);
  const out = [];
  let cur = null;
  let cmd = 'M';
  for (let i = 0; i < t.length; ) {
    if (/^[ML]$/.test(t[i])) {
      cmd = t[i++];
      continue;
    }
    const x = parseFloat(t[i]);
    const y = parseFloat(t[i + 1]);
    i += 2;
    if (cmd === 'M') {
      cur = [[x, y]];
      out.push(cur);
      cmd = 'L';
    } else cur.push([x, y]);
  }
  return out;
}

/** Polylines (screen coordinates) for `text` with its baseline at (x, y). */
export function handPaths(text, x, y, cap = 18) {
  const s = cap / CAP_UNITS;
  const paths = [];
  let cursor = x;
  for (const g of hershey.renderTextArray(text, { font: 'ems_felix' })) {
    if (g.d) for (const sub of parse(g.d)) paths.push(sub.map(([gx, gy]) => [cursor + gx * s, y - gy * s]));
    cursor += g.width * s * (g.type === ' ' ? 0.85 : 1);
  }
  return { paths, width: cursor - x };
}

export async function writeText(page, text, x, y, cap = 18) {
  const { paths, width } = handPaths(text, x, y, cap);
  for (const p of paths) {
    await page.mouse.move(p[0][0], p[0][1]);
    await page.mouse.down();
    for (let i = 1; i < p.length; i++) await page.mouse.move(p[i][0], p[i][1], { steps: 2 });
    await page.mouse.up();
  }
  return width;
}
