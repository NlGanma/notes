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

/** Makes sure the sidebar is showing (it hides itself on narrow windows and beside the assistant). */
export async function showSidebar(page) {
  if (await page.locator('.sidebar.is-hidden').count()) {
    await page.click('.mainbar-show');
    await page.waitForSelector('.sidebar:not(.is-hidden)');
  }
}

/** Opens a note filed in a class: the class's row in the sidebar, then the note's row on the class page. */
export async function openClassNote(page, cls, title) {
  await showSidebar(page);
  await page.click(`.sidebar .nav-class:has-text("${cls}")`);
  await page.waitForSelector('.class-view');
  let row = page.locator(`.class-view .note-row:has-text("${title}")`).first();
  await row.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  // A note filed in one of the class's folders is listed on that folder's page, not on the class page.
  if (!(await row.count())) {
    for (const name of await page.locator('.class-view .folder-row .folder-row-name').allTextContents()) {
      await page.click(`.class-view .folder-row:has-text("${name}")`);
      await page.waitForSelector('.notes-view');
      row = page.locator(`.notes-view .note-row:has-text("${title}")`).first();
      if (await row.count()) break;
      await page.click('.notes-view .list-back');
      await page.waitForSelector('.class-view');
    }
  }
  await row.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    throw new Error(`Neither the ${cls} class page nor its folders list “${title}”`);
  });
  await row.click();
  await page.waitForSelector(`.note-view:not(.is-hidden) .page-title`);
}

/** Opens the New class dialog from the Classes page (its button at the top right, or the empty page's). */
export async function createClassDialog(page) {
  await showSidebar(page);
  await page.click('.sidebar .nav-classes-label');
  await page.locator('.classes-view button:visible', { hasText: /^\s*New class\s*$/ }).first().click();
  await page.waitForSelector('.class-dialog .class-name-input input');
}

/** Makes a note from the sidebar's New note menu, on one of the three papers. */
export async function newNoteFromSidebar(page, paper = 'Lined') {
  await showSidebar(page);
  await page.click('.sidebar .side-new');
  await page.click(`.new-note-pop .paper-opt:has-text("${paper}")`);
  await page.waitForSelector('.note-view:not(.is-hidden) .page-title');
}

/** Opens the open note's ⋯ menu and picks an item (Polish…, Export…). */
export async function noteMenuItem(page, label) {
  await page.click('.note-view:not(.is-hidden) .tb-more');
  await page.click(`.more-menu .menu-item:has-text("${label}")`);
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
