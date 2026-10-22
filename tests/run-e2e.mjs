#!/usr/bin/env node
// Runs every end-to-end suite against a mock local model and the dev server,
// starting either one if it isn't already running, then prints a summary.
//
//   node tests/run-e2e.mjs                 # ink, ai, homework (browser)
//   node tests/run-e2e.mjs --electron      # + the desktop app (needs `npm run build`; xvfb on Linux)
//   node tests/run-e2e.mjs homework        # just some suites
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const withElectron = args.includes('--electron');
const only = args.filter((a) => !a.startsWith('--'));
const BROWSER_SUITES = ['ink', 'ai', 'homework'];
const suites = (only.length ? only : [...BROWSER_SUITES, ...(withElectron ? ['electron'] : [])]).filter((s) =>
  fs.existsSync(path.join(root, 'tests/e2e', `${s}.mjs`)),
);

const APP = process.env.NIB_URL || 'http://localhost:5173/';
const MODEL = 'http://127.0.0.1:11434';
const children = [];

const up = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
};

async function ensure(name, url, cmd, argv, env = {}) {
  if (await up(url)) {
    console.log(`· ${name} already running`);
    return;
  }
  const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: false });
  children.push(child);
  for (let i = 0; i < 120; i++) {
    if (await up(url)) {
      console.log(`· started ${name}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not start`);
}

function cleanup() {
  for (const c of children) c.kill();
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const needsDisplay = suite === 'electron' && process.platform === 'linux' && !process.env.DISPLAY;
    const [cmd, argv] = needsDisplay ? ['xvfb-run', ['-a', 'node', `tests/e2e/${suite}.mjs`]] : ['node', [`tests/e2e/${suite}.mjs`]];
    const child = spawn(cmd, argv, { cwd: root, env: process.env });
    let out = '';
    const onData = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s.replace(/^/gm, '  '));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      const ok = (out.match(/^ok {2}/gm) ?? []).length;
      const failed = (out.match(/^FAIL/gm) ?? []).length;
      resolve({ suite, code, ok, failed, secs: ((Date.now() - started) / 1000).toFixed(0) });
    });
  });
}

try {
  await ensure('mock model server', `${MODEL}/api/tags`, 'node', ['scripts/mock-llm.mjs'], { MOCK_QUIET: '1' });
  if (suites.some((s) => s !== 'electron')) await ensure('app (vite)', APP, 'npx', ['vite', '--port', '5173', '--strictPort']);
  if (suites.includes('electron') && !fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('Run `npm run build` before the electron suite.');

  const results = [];
  for (const s of suites) {
    console.log(`\n▶ ${s}`);
    // Each suite starts from a clean model server state.
    await fetch(`${MODEL}/__mock`, { method: 'POST', body: JSON.stringify({ fail: 0, truncate: 0, firstTokenMs: 0 }) }).catch(() => undefined);
    results.push(await run(s));
  }

  console.log('\nSummary');
  let bad = 0;
  for (const r of results) {
    const pass = r.code === 0 && r.failed === 0;
    if (!pass) bad++;
    console.log(
      `  ${pass ? '✓' : '✗'} ${r.suite.padEnd(10)} ${String(r.ok).padStart(3)} passed${r.failed ? `, ${r.failed} failed` : ''}${r.code && !r.failed ? ` (exit ${r.code})` : ''}  ${r.secs}s`,
    );
  }
  console.log(bad ? `\n${bad} suite(s) failed — screenshots in tests/e2e/out` : '\nAll suites passed.');
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
} finally {
  cleanup();
}
