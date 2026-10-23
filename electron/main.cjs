// Nib — Electron main process.
//
// Responsibilities:
//  * a macOS-native window (inset traffic lights, native menus)
//  * vault file access (plain .nib JSON files in ordinary folders, like Obsidian)
//  * a streaming HTTP proxy so the renderer can talk to a local LLM server
//    (Ollama, LM Studio, llama.cpp, …) without any CORS configuration
//  * PDF export, file import/export dialogs and screen-region capture for
//    "ask about what's on screen".

const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const isMac = process.platform === 'darwin';
const DEV_URL = process.env.NIB_DEV_URL || '';
const E2E_EXPORT_DIR = process.env.NIB_E2E_EXPORT_DIR || '';
const E2E_HOME = process.env.NIB_E2E_HOME || '';

app.setName('Nib');
// Tests run against a throwaway home. On macOS, Documents and app data come from the system, not
// $HOME, so without this a test run would write into the real ~/Documents/Nib Vault.
if (E2E_HOME) {
  app.setPath('userData', path.join(E2E_HOME, 'userData'));
  app.setPath('documents', path.join(E2E_HOME, 'Documents'));
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---------------------------------------------------------------------------
// Window state

const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { width: 1440, height: 920 };
  }
}

function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* ignore */
  }
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1440,
    height: state.height || 920,
    minWidth: 960,
    minHeight: 620,
    title: 'Nib',
    show: false,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          // Centred in the sidebar's 44px header row.
          trafficLightPosition: { x: 16, y: 15 },
          backgroundColor: '#f5f4ed',
        }
      : { backgroundColor: '#f5f4ed', autoHideMenuBar: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  // The traffic lights hide in full screen; the page takes back the room they kept free.
  win.on('enter-full-screen', () => win.webContents.send('menu', 'fullscreen', 'on'));
  win.on('leave-full-screen', () => win.webContents.send('menu', 'fullscreen', 'off'));
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Never navigate away from the app; open web links in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  return win;
}

// ---------------------------------------------------------------------------
// Menus. Most items forward a command string to the renderer, which owns the
// actual behaviour (so the same commands also work in the browser build).

function send(cmd, arg) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) win.webContents.send('menu', cmd, arg);
}

function buildMenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: 'Nib',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => send('new-note') },
        { label: 'New Homework…', accelerator: 'CmdOrCtrl+Shift+Y', click: () => send('new-homework') },
        { label: 'New Class…', click: () => send('new-class') },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('new-folder') },
        { type: 'separator' },
        { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => send('palette') },
        { label: 'Ask your notes', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('library') },
        { label: 'Review…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('review') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: () => send('import') },
        {
          label: 'Export',
          submenu: [
            { label: 'PDF…', accelerator: 'CmdOrCtrl+P', click: () => send('export', 'pdf') },
            { label: 'Markdown…', click: () => send('export', 'md') },
            { label: 'HTML…', click: () => send('export', 'html') },
            { label: 'Nib Note…', click: () => send('export', 'nib') },
          ],
        },
        { type: 'separator' },
        { label: 'Open Vault Folder…', click: () => send('open-vault') },
        { label: 'Reveal Note in Finder', click: () => send('reveal') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo are routed to the renderer so ink strokes and text share
        // one history.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Notes…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        ...(isMac ? [{ type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }] : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => send('toggle-sidebar') },
        { label: 'Toggle Assistant', accelerator: 'CmdOrCtrl+J', click: () => send('toggle-assistant') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom', 'in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom', 'out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('zoom', 'reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('shortcuts') },
        { label: 'Setting Up a Local Model', click: () => send('help-llm') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Vault filesystem. Every path from the renderer is relative to the vault root
// and is checked so it can never escape it.

// Folders the user picked (or the default one). A renderer can only touch a
// folder it was given, or one that already is a Nib vault — never e.g. $HOME.
let approvedRoots = null;
const rootsPath = () => path.join(app.getPath('userData'), 'vault-roots.json');
function loadRoots() {
  if (!approvedRoots) {
    try {
      approvedRoots = new Set(JSON.parse(fs.readFileSync(rootsPath(), 'utf8')));
    } catch {
      approvedRoots = new Set();
    }
  }
  return approvedRoots;
}
function approveRoot(dir) {
  const r = path.resolve(dir);
  const set = loadRoots();
  if (set.has(r)) return;
  set.add(r);
  try {
    fs.writeFileSync(rootsPath(), JSON.stringify([...set]));
  } catch {
    /* still approved for this session */
  }
}
function isApprovedRoot(root) {
  const r = path.resolve(root);
  const set = loadRoots();
  if (set.has(r)) return true;
  // Upgrading from a version that didn't keep this list: the first vault the app opens is the
  // user's own (it is opened before any note content is shown), so it is approved once.
  if (!fs.existsSync(rootsPath()) && set.size === 0) return true;
  // A folder Nib already keeps its data in.
  try {
    return fs.statSync(path.join(r, '.nib')).isDirectory();
  } catch {
    return false;
  }
}

function resolveInVault(root, rel = '') {
  if (typeof root !== 'string' || !root) throw new Error('No vault selected');
  if (!isApprovedRoot(root)) throw new Error('That folder is not a Nib vault. Choose it with File → Open Vault…');
  approveRoot(root);
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || '.');
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('Path escapes the vault');
  return abs;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Returns a vault-relative path that does not exist yet ("Name 2.nib", …). */
function uniqueRel(root, rel, ignoreAbs) {
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let candidate = rel;
  for (let i = 2; ; i++) {
    const abs = resolveInVault(root, candidate);
    if (!exists(abs) || abs === ignoreAbs) return candidate;
    candidate = `${stem} ${i}${ext}`;
  }
}

async function atomicWrite(abs, text) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // A unique temp file per write, so two writes to the same file can never interleave.
  // Short, so a long note title plus the suffix still fits the 255-byte file-name limit.
  const tmp = path.join(path.dirname(abs), `.nib-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function toRel(...parts) {
  return parts.filter(Boolean).join('/');
}

ipcMain.handle('vault:default', async () => {
  const dir = path.join(app.getPath('documents'), 'Nib Vault');
  await fsp.mkdir(dir, { recursive: true });
  approveRoot(dir);
  return dir;
});

ipcMain.handle('vault:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for your Nib vault',
    buttonLabel: 'Use as Vault',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled) return null;
  approveRoot(res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle('vault:scan', async (_e, root) => {
  const base = resolveInVault(root);
  await fsp.mkdir(base, { recursive: true });
  const notes = [];
  const folders = [];
  async function readNote(abs, rel) {
    try {
      const [text, stat] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
      notes.push({ path: rel, text, mtime: stat.mtimeMs });
    } catch {
      /* unreadable file: skip */
    }
  }
  async function walk(dir, rel) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const childRel = toRel(rel, ent.name);
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        folders.push(childRel);
        await walk(abs, childRel);
      } else if (ent.isFile() && ent.name.endsWith('.nib')) {
        await readNote(abs, childRel);
      }
    }
  }
  await walk(base, '');
  const trash = path.join(base, '.trash');
  if (exists(trash)) {
    for (const name of await fsp.readdir(trash)) {
      if (name.endsWith('.nib')) await readNote(path.join(trash, name), toRel('.trash', name));
    }
  }
  return { notes, folders };
});

ipcMain.handle('vault:create', async (_e, root, rel, text) => {
  const finalRel = uniqueRel(root, rel);
  await atomicWrite(resolveInVault(root, finalRel), text);
  return finalRel;
});

ipcMain.handle('vault:write', async (_e, root, rel, text) => {
  await atomicWrite(resolveInVault(root, rel), text);
  return rel;
});

// Synchronous variant used while the window is closing so nothing is lost.
ipcMain.on('vault:writeSync', (event, root, rel, text) => {
  try {
    const abs = resolveInVault(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    event.returnValue = true;
  } catch {
    event.returnValue = false;
  }
});

ipcMain.handle('vault:move', async (_e, root, fromRel, toRelPath) => {
  const fromAbs = resolveInVault(root, fromRel);
  const finalRel = uniqueRel(root, toRelPath, fromAbs);
  const toAbs = resolveInVault(root, finalRel);
  if (fromAbs === toAbs) return finalRel;
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return finalRel;
});

ipcMain.handle('vault:remove', async (_e, root, rel) => {
  const abs = resolveInVault(root, rel);
  if (abs === path.resolve(root)) throw new Error('Refusing to remove the vault root');
  if (!exists(abs)) return true;
  try {
    await shell.trashItem(abs); // goes to the macOS Trash, recoverable
  } catch {
    await fsp.rm(abs, { recursive: true, force: true });
  }
  return true;
});

ipcMain.handle('vault:mkdir', async (_e, root, rel) => {
  await fsp.mkdir(resolveInVault(root, rel), { recursive: true });
  return rel;
});

ipcMain.handle('vault:renameDir', async (_e, root, fromRel, toRelPath) => {
  const fromAbs = resolveInVault(root, fromRel);
  const toAbs = resolveInVault(root, toRelPath);
  if (exists(toAbs)) {
    // On case-insensitive disks (macOS) "biology" → "Biology" finds the folder itself; that rename is fine.
    const a = fs.statSync(fromAbs);
    const b = fs.statSync(toAbs);
    if (a.ino !== b.ino || a.dev !== b.dev) throw new Error('A folder with that name already exists');
  }
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return toRelPath;
});

ipcMain.handle('vault:readText', async (_e, root, rel) => {
  try {
    return await fsp.readFile(resolveInVault(root, rel), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('vault:writeText', async (_e, root, rel, text) => {
  await atomicWrite(resolveInVault(root, rel), text);
  return true;
});

ipcMain.handle('vault:reveal', async (_e, root, rel) => {
  shell.showItemInFolder(resolveInVault(root, rel));
  return true;
});

// ---------------------------------------------------------------------------
// HTTP proxy for local LLM servers (no CORS, supports streaming + abort).

const streams = new Map();

function checkUrl(url) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http(s) URLs are allowed');
}

ipcMain.handle('http:request', async (_e, req) => {
  checkUrl(req.url);
  try {
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: req.body,
      signal: AbortSignal.timeout(req.timeout || 60000),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String((err && err.message) || err) };
  }
});

ipcMain.on('http:stream', async (event, id, req) => {
  const sender = event.sender;
  const emit = (type, data) => {
    if (!sender.isDestroyed()) sender.send('http:event', id, type, data);
  };
  const ctrl = new AbortController();
  streams.set(id, ctrl);
  try {
    checkUrl(req.url);
    const res = await fetch(req.url, {
      method: req.method || 'POST',
      headers: req.headers || {},
      body: req.body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      emit('error', `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit('chunk', decoder.decode(value, { stream: true }));
    }
    emit('end', null);
  } catch (err) {
    emit(ctrl.signal.aborted ? 'abort' : 'error', String((err && err.message) || err));
  } finally {
    streams.delete(id);
  }
});

ipcMain.on('http:abort', (_e, id) => {
  const ctrl = streams.get(id);
  if (ctrl) ctrl.abort();
});

// ---------------------------------------------------------------------------
// Export / import / capture

async function askSavePath(win, suggestedName, filters) {
  if (E2E_EXPORT_DIR) return path.join(E2E_EXPORT_DIR, suggestedName);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    filters,
  });
  return res.canceled ? null : res.filePath;
}

ipcMain.handle('export:pdf', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const file = await askSavePath(win, `${opts.name || 'Note'}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
  if (!file) return null;
  const data = await event.sender.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  });
  await fsp.writeFile(file, data);
  return file;
});

ipcMain.handle('export:save', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const file = await askSavePath(win, opts.name, opts.filters || []);
  if (!file) return null;
  const buf = opts.encoding === 'base64' ? Buffer.from(opts.data, 'base64') : Buffer.from(opts.data, 'utf8');
  await fsp.writeFile(file, buf);
  return file;
});

ipcMain.handle('import:open', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: opts?.title || 'Import',
    properties: ['openFile', 'multiSelections'],
    filters: opts?.filters || [],
  });
  if (res.canceled) return [];
  const out = [];
  for (const file of res.filePaths.slice(0, 50)) {
    const stat = await fsp.stat(file);
    if (stat.size > 80 * 1024 * 1024) continue;
    const buf = await fsp.readFile(file);
    out.push({ name: path.basename(file), path: file, size: stat.size, base64: buf.toString('base64') });
  }
  return out;
});

ipcMain.handle('capture:rect', async (event, rect) => {
  const r = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const image = await event.sender.capturePage(r);
  return image.toPNG().toString('base64');
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
}));

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'Nib',
    applicationVersion: app.getVersion(),
    credits: 'A local-first notebook with an on-device AI study assistant.',
  });
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
