// Exposes a small, explicit API to the renderer. Nothing else from Node or
// Electron is reachable from the web page.

const { contextBridge, ipcRenderer } = require('electron');

const httpListeners = new Map();
ipcRenderer.on('http:event', (_e, id, type, data) => {
  const fn = httpListeners.get(id);
  if (fn) fn(type, data);
  if (type === 'end' || type === 'error' || type === 'abort') httpListeners.delete(id);
});

contextBridge.exposeInMainWorld('nib', {
  platform: process.platform,
  vault: {
    defaultRoot: () => ipcRenderer.invoke('vault:default'),
    choose: () => ipcRenderer.invoke('vault:choose'),
    scan: (root) => ipcRenderer.invoke('vault:scan', root),
    create: (root, rel, text) => ipcRenderer.invoke('vault:create', root, rel, text),
    write: (root, rel, text) => ipcRenderer.invoke('vault:write', root, rel, text),
    writeSync: (root, rel, text) => ipcRenderer.sendSync('vault:writeSync', root, rel, text),
    move: (root, from, to) => ipcRenderer.invoke('vault:move', root, from, to),
    remove: (root, rel) => ipcRenderer.invoke('vault:remove', root, rel),
    mkdir: (root, rel) => ipcRenderer.invoke('vault:mkdir', root, rel),
    renameDir: (root, from, to) => ipcRenderer.invoke('vault:renameDir', root, from, to),
    readText: (root, rel) => ipcRenderer.invoke('vault:readText', root, rel),
    writeText: (root, rel, text) => ipcRenderer.invoke('vault:writeText', root, rel, text),
    reveal: (root, rel) => ipcRenderer.invoke('vault:reveal', root, rel),
  },
  http: {
    request: (req) => ipcRenderer.invoke('http:request', req),
    stream: (id, req, onEvent) => {
      httpListeners.set(id, onEvent);
      ipcRenderer.send('http:stream', id, req);
    },
    abort: (id) => ipcRenderer.send('http:abort', id),
  },
  exportPdf: (opts) => ipcRenderer.invoke('export:pdf', opts),
  saveFile: (opts) => ipcRenderer.invoke('export:save', opts),
  openFiles: (opts) => ipcRenderer.invoke('import:open', opts),
  captureRect: (rect) => ipcRenderer.invoke('capture:rect', rect),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onMenu: (cb) => {
    const handler = (_e, cmd, arg) => cb(cmd, arg);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.removeListener('menu', handler);
  },
});
