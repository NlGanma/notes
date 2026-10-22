// Small helpers for driving Nib in Chromium with Playwright.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = process.env.NIB_URL || 'http://localhost:5173/';
export const OUT = process.env.NIB_SHOTS || path.resolve('tests/e2e/out');
fs.mkdirSync(OUT, { recursive: true });

export async function launch({ width = 1440, height = 900, scale = 1, storage } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, storageState: storage });
  // React can't name the component for "Maximum update depth" warnings; record where the update came from.
  await context.addInitScript(() => {
    Error.stackTraceLimit = 80;
    const orig = console.error;
    console.error = function (...args) {
      if (/Maximum update depth/.test(String(args[0]))) {
        // The frames from our own code say who dispatched; library frames only say how.
        const frames = (new Error().stack || '')
          .split('\n')
          .slice(2)
          .map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '').replace(/\?v=\w+/, '').replace(/\?t=\d+/, ''));
        const ours = frames.filter((l) => /\bsrc\//.test(l));
        // No frames of ours: the loop runs inside a library — show which part of it.
        const stack = (ours.length ? [...frames.slice(0, 4), '…', ...ours.slice(0, 12)] : frames.slice(3, 40)).join(' | ');
        return orig.call(console, `${args[0]} AT: ${stack}`);
      }
      return orig.apply(console, args);
    };
  });
  const page = await context.newPage();
  // NIB_CPU_THROTTLE=4 slows the page down like a CI runner, to shake out timing bugs.
  if (process.env.NIB_CPU_THROTTLE) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.NIB_CPU_THROTTLE) });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    let text = m.text();
    // React warnings carry the component stack as an argument.
    if (/Maximum update depth|Warning:/.test(text)) {
      const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '')));
      text += ` ${args.slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 600)}`;
    }
    errors.push(`console: ${text}`);
    // Print right away too, so the log shows which step caused it.
    if (/Maximum update depth/.test(text)) console.log(`     [react warning at this point] ${text.slice(0, 5000)}`);
  });
  return { browser, context, page, errors };
}

export async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  // Fades are finished first, so the picture shows the screen as it settles (not a card half faded in).
  await page.screenshot({ path: file, animations: 'disabled', ...opts });
  return file;
}

/** Draws a polyline with the mouse (page coordinates). */
export async function drawPath(page, points, { steps = 2 } = {}) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) await page.mouse.move(points[i][0], points[i][1], { steps });
  await page.mouse.up();
}
