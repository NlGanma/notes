// Typed access to the Electron preload bridge. In the browser build `nib` is
// undefined and every caller falls back to a web implementation.

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

export type HttpEventType = 'chunk' | 'end' | 'error' | 'abort';

export interface ScannedNote {
  path: string;
  text: string;
  mtime: number;
}

export interface OpenedFile {
  name: string;
  path: string;
  size: number;
  base64: string;
}

export interface NibBridge {
  platform: string;
  vault: {
    defaultRoot(): Promise<string>;
    choose(): Promise<string | null>;
    scan(root: string): Promise<{ notes: ScannedNote[]; folders: string[] }>;
    create(root: string, rel: string, text: string): Promise<string>;
    write(root: string, rel: string, text: string): Promise<string>;
    writeSync(root: string, rel: string, text: string): boolean;
    move(root: string, from: string, to: string): Promise<string>;
    remove(root: string, rel: string): Promise<boolean>;
    mkdir(root: string, rel: string): Promise<string>;
    renameDir(root: string, from: string, to: string): Promise<string>;
    readText(root: string, rel: string): Promise<string | null>;
    writeText(root: string, rel: string, text: string): Promise<boolean>;
    reveal(root: string, rel: string): Promise<boolean>;
  };
  http: {
    request(req: HttpRequest): Promise<HttpResponse>;
    stream(id: string, req: HttpRequest, onEvent: (type: HttpEventType, data: string | null) => void): void;
    abort(id: string): void;
  };
  exportPdf(opts: { name: string }): Promise<string | null>;
  saveFile(opts: { name: string; data: string; encoding?: 'utf8' | 'base64'; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  openFiles(opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<OpenedFile[]>;
  captureRect(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
  openExternal(url: string): Promise<boolean>;
  appInfo(): Promise<{ version: string; platform: string; arch: string; electron: string }>;
  onMenu(cb: (cmd: string, arg?: string) => void): () => void;
}

declare global {
  interface Window {
    nib?: NibBridge;
  }
}

export const bridge: NibBridge | undefined = typeof window !== 'undefined' ? window.nib : undefined;
export const isElectron = !!bridge;
export const isMac =
  (bridge?.platform ?? '') === 'darwin' || (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));

/** Display string for the primary modifier key. */
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';
