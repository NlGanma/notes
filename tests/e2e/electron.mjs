// Smoke test of the packaged desktop app (Electron) — vault on disk, the
// main-process LLM proxy, real screen capture and PDF export.
//   npm run build && node scripts/mock-llm.mjs &   then:
//   xvfb-run -a node tests/e2e/electron.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OUT } from './lib.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = path.resolve('.');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nib-home-'));
const exportDir = path.join(home, 'exports');
fs.mkdirSync(exportDir, { recursive: true });

const check = (cond, msg) => {
  console.log(cond ? 'ok  ' : 'FAIL', msg);
  if (!cond) process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', root],
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NIB_E2E_EXPORT_DIR: exportDir },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
await win.waitForSelector('.sidebar', { timeout: 20000 });
check(await win.evaluate(() => !!window.nib), 'preload bridge is available');

// Vault on disk with the seeded notebook.
await win.waitForSelector('.tree-row:has-text("Calculus I")', { timeout: 15000 });
const vault = await win.evaluate(() => localStorage.getItem('nib.vaultRoot'));
console.log('     vault:', vault);
await new Promise((r) => setTimeout(r, 1200));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(vault).map((f) => path.relative(vault, f));
console.log('     vault files:', files.filter((f) => f.endsWith('.nib')).join(', '));
check(files.includes(path.join('Calculus I', 'Lecture 4 — Limits & Continuity.nib')), 'notes are plain .nib files inside folders');
check(
  files.includes(path.join('Calculus I', 'Homework', 'Problem Set 4 — Limits & Continuity.nib')),
  'homework is filed in the class’s Homework folder on disk',
);
const folderMeta = JSON.parse(fs.readFileSync(path.join(vault, '.nib', 'folders.json'), 'utf8'));
check(
  folderMeta['Calculus I']?.kind === 'class' && folderMeta['Calculus I']?.code === 'MATH 1A',
  'class details are stored with the vault (.nib/folders.json)',
);
const hwFile = JSON.parse(fs.readFileSync(path.join(vault, 'Calculus I', 'Homework', 'Problem Set 4 — Limits & Continuity.nib'), 'utf8'));
check(hwFile.meta.homework?.sources?.length === 1, 'homework links are saved in the note file');

// Local model through the main-process proxy (no CORS involved).
await win.waitForSelector('.ai-status.is-online', { timeout: 15000 }).catch(() => undefined);
check(await win.locator('.ai-status.is-online').count(), 'connected to the local model through the main process');

// Edit a note and see it saved to disk.
await win.click('.tree-row:has-text("Welcome to Nib")');
await win.waitForTimeout(500);
await win.locator('.note-view:not(.is-hidden) .page-title').fill('Welcome to Nib (edited)');
await win.locator('.note-view:not(.is-hidden) .page-title').press('Enter');
await win.keyboard.type('Saved straight to disk. ');
await win.waitForTimeout(1500);
const renamed = path.join(vault, 'Welcome to Nib (edited).nib');
check(fs.existsSync(renamed), 'renaming a note renames its file');
check(fs.existsSync(renamed) && fs.readFileSync(renamed, 'utf8').includes('Saved straight to disk'), 'typing is saved to the file');

// Real screen capture for "ask about this area".
const b64 = await win.evaluate(() => window.nib.captureRect({ x: 300, y: 200, width: 300, height: 120 }));
check(typeof b64 === 'string' && b64.length > 1000, `screen capture returns a PNG (${b64?.length ?? 0} bytes b64)`);

// A new class is a folder on disk; renaming it renames the folder.
await win.click('.side-section-head button[title="New class"]');
await win.fill('.class-name-input', 'Statistics');
await win.click('.class-form button[type="submit"]');
await win.waitForSelector('.class-hero h1:has-text("Statistics")');
await win.click('.class-hero .btn.is-primary');
await win.locator('.note-view:not(.is-hidden) .page-title').fill('Week 1');
await win.locator('.note-view:not(.is-hidden) .page-title').press('Enter');
await win.keyboard.type('Mean, median and mode.');
await win.waitForTimeout(1200);
check(fs.existsSync(path.join(vault, 'Statistics', 'Week 1.nib')), 'a note made in a class is saved inside the class folder');
await win.click('.tree-row.is-class:has-text("Statistics")');
await win.click('.class-edit');
await win.fill('.class-name-input', 'Stats 101');
await win.click('.class-form button[type="submit"]');
await win.waitForTimeout(1200);
check(fs.existsSync(path.join(vault, 'Stats 101', 'Week 1.nib')) && !fs.existsSync(path.join(vault, 'Statistics')), 'renaming a class renames its folder');

// PDF export of the calculus note.
await win.click('.tree-row:has-text("Calculus I")');
await win.click('.note-card:has-text("Lecture 4")');
await win.waitForTimeout(1200);
await win.click('.top-btn:has-text("Export")');
await win.click('.menu-item:has-text("PDF document")');
await win.waitForTimeout(3000);
const pdfs = fs.readdirSync(exportDir).filter((f) => f.endsWith('.pdf'));
check(pdfs.length === 1, `exported a PDF (${pdfs.join(', ')})`);
if (pdfs[0]) {
  const size = fs.statSync(path.join(exportDir, pdfs[0])).size;
  check(size > 20000, `PDF has content (${Math.round(size / 1024)} KB)`);
  fs.copyFileSync(path.join(exportDir, pdfs[0]), path.join(OUT, 'export.pdf'));
}

await win.screenshot({ path: path.join(OUT, 'electron-window.png') });
console.log(errors.join('\n') || 'no page errors');
await app.close();
