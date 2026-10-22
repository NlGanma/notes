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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { browser, context, page, errors };
}

export async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  return file;
}

/** Draws a polyline with the mouse (page coordinates). */
export async function drawPath(page, points, { steps = 2 } = {}) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) await page.mouse.move(points[i][0], points[i][1], { steps });
  await page.mouse.up();
}
