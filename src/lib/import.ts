import { generateJSON, type JSONContent } from '@tiptap/core';
import { buildExtensions } from '../editor/extensions';
import { normalizeDocJSON } from '../editor/extensions/blockAttrs';
import { markdownToEditorHTML } from './ai/markdown';
import { parseNoteFile } from './vault/types';
import { useVault } from '../state/vault';
import { useUI } from '../state/ui';
import { bridge } from './platform';
import { base64ToBytes } from './util';
import { toast } from '../components/common/toast';
import { currentFolder } from './commands';

/**
 * Import: Markdown / text, images, .nib notes and PDFs. PDF pages become
 * images you can write on, and their text is kept (as the image description)
 * so the assistant and search can use it.
 */

interface InFile {
  name: string;
  bytes: Uint8Array;
}

const ACCEPT = ['md', 'markdown', 'txt', 'nib', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'];

function htmlToDoc(html: string): JSONContent {
  return normalizeDocJSON(generateJSON(html, buildExtensions()) as never) as JSONContent;
}

function stripExt(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

async function pdfToDoc(bytes: Uint8Array, onProgress?: (p: number, n: number) => void): Promise<JSONContent> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const content: JSONContent[] = [];
  const pages = Math.min(pdf.numPages, 120);
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1600 / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const text = await page.getTextContent();
    const pageText = text.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    content.push({
      type: 'image',
      attrs: { src: canvas.toDataURL('image/jpeg', 0.86), alt: `Page ${i}${pageText ? `: ${pageText}` : ''}`, title: `Page ${i}` },
    });
    content.push({ type: 'paragraph' });
    onProgress?.(i, pages);
  }
  return normalizeDocJSON({ type: 'doc', content } as never) as JSONContent;
}

async function importOne(file: InFile, folder: string): Promise<string | null> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const vault = useVault.getState();
  if (ext === 'nib') {
    const doc = parseNoteFile(new TextDecoder().decode(file.bytes));
    if (!doc) throw new Error('Not a valid .nib file');
    return vault.createNote({ folder, title: doc.meta.title, content: doc.content, tags: doc.meta.tags }).meta.id;
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
    let text = new TextDecoder().decode(file.bytes);
    let title = stripExt(file.name);
    const h1 = /^#\s+(.+)\n+/.exec(text);
    if (ext !== 'txt' && h1) {
      title = h1[1].trim();
      text = text.slice(h1[0].length);
    }
    const html =
      ext === 'txt'
        ? text
            .split(/\n{2,}/)
            .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
            .join('')
        : markdownToEditorHTML(text);
    return vault.createNote({ folder, title, content: htmlToDoc(html) }).meta.id;
  }
  if (ext === 'pdf') {
    const t = toast.info(`Importing ${file.name}…`, 'Rendering pages so you can write on them');
    const content = await pdfToDoc(file.bytes);
    void t;
    return vault.createNote({ folder, title: stripExt(file.name), content }).meta.id;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    let bin = '';
    for (let i = 0; i < file.bytes.length; i += 0x8000) bin += String.fromCharCode(...file.bytes.subarray(i, i + 0x8000));
    const src = `data:${mime};base64,${btoa(bin)}`;
    return vault.createNote({
      folder,
      title: stripExt(file.name),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src, alt: file.name } }, { type: 'paragraph' }] },
    }).meta.id;
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

async function pickFiles(): Promise<InFile[]> {
  if (bridge) {
    const files = await bridge.openFiles({
      title: 'Import into Nib',
      filters: [{ name: 'Notes, PDFs and images', extensions: ACCEPT }],
    });
    return files.map((f) => ({ name: f.name, bytes: base64ToBytes(f.base64) }));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const out: InFile[] = [];
      for (const f of Array.from(input.files ?? [])) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      resolve(out);
    };
    input.click();
  });
}

export async function importFiles(files?: InFile[]) {
  const list = files ?? (await pickFiles());
  if (!list.length) return;
  const folder = currentFolder();
  let last: string | null = null;
  let ok = 0;
  for (const f of list) {
    try {
      last = await importOne(f, folder);
      ok++;
    } catch (e) {
      toast.error(`Couldn’t import ${f.name}`, String((e as Error).message ?? e));
    }
  }
  if (last) useUI.getState().openNote(last, { newTab: true });
  if (ok) toast.success(`Imported ${ok} file${ok === 1 ? '' : 's'}`);
}

/** Drag files from Finder onto the window. */
export async function importDropped(fileList: FileList) {
  const files: InFile[] = [];
  for (const f of Array.from(fileList)) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (ACCEPT.includes(ext)) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  if (files.length) await importFiles(files);
}
