#!/usr/bin/env node
// Renders the app icon (build/icon.png, 1024²; electron-builder makes the
// .icns from it) and the favicon from one SVG.  node scripts/build-icon.mjs
import fs from 'node:fs';
import { chromium } from '@playwright/test';

// macOS Big Sur grid: an 824² rounded square centred on a 1024² canvas.
const mark = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eef0f4"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7a55f0"/>
      <stop offset="1" stop-color="#2f6bf0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0b0d14" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#0b0d14" stroke-opacity="0.08"/>
  <!-- ruled lines -->
  <g stroke="#dfe7f1" stroke-width="10" stroke-linecap="round">
    <line x1="230" y1="640" x2="794" y2="640"/>
    <line x1="230" y1="740" x2="794" y2="740"/>
  </g>
  <!-- a handwritten stroke flowing into a typed line -->
  <g transform="translate(0 32)">
  <path d="M262 600 C 320 470, 372 350, 410 300 C 432 272, 470 280, 470 318 C 470 380, 430 470, 452 540 C 468 590, 520 584, 556 548"
        fill="none" stroke="#1c1c1e" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="600" y="568" width="194" height="40" rx="20" fill="#1c1c1e"/>
  <circle cx="702" cy="330" r="74" fill="url(#ink)"/>
  <path d="M676 330 l 18 18 l 34 -38" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

fs.mkdirSync('build', { recursive: true });
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/favicon.svg', mark(64));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${mark(1024)}</body></html>`);
await page.locator('svg').screenshot({ path: 'build/icon.png', omitBackground: true });
await browser.close();
console.log('wrote build/icon.png and public/favicon.svg');
