import { useVault } from '../../state/vault';
import { useSettings, LINE_PX } from '../../state/settings';
import { editors } from '../../editor/registry';
import { rhythmKey } from '../../editor/extensions/rhythm';
import { bridge } from '../platform';
import { docToHTML } from '../doc/toHTML';
import { docToMarkdown } from '../doc/toMarkdown';
import { serializeNote } from '../vault/types';
import { escapeHtml, nextFrame, sanitizeFileName } from '../util';
import { toast } from '../../components/common/toast';
import docCss from '../../styles/doc.css?raw';

const exportCss = `${docCss}
body { margin: 0; background: #f4f4f2; }
.nib-doc.nib-print { max-width: 816px; margin: 40px auto; padding: 72px 80px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 12px 40px rgba(0,0,0,.06); border-radius: 4px; }
@media print { body { background: #fff; } .nib-doc.nib-print { margin: 0; box-shadow: none; padding: 0; } }
`;

export type ExportKind = 'pdf' | 'md' | 'html' | 'nib';

function liveContent(id: string) {
  const ed = editors.get(id);
  const note = useVault.getState().notes[id];
  const live = ed && !ed.isDestroyed;
  // The live editor knows each block's baseline-grid padding; with it, paper
  // lines in the export line up with the text exactly.
  const pads = live ? rhythmKey.getState(ed.state)?.pads : undefined;
  const content = live ? ed.getJSON() : note?.content;
  return { note, content, pads: pads && pads.length === (content?.content?.length ?? -1) ? pads : undefined };
}

function download(name: string, data: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveText(name: string, data: string, mime: string, ext: string, label: string) {
  if (bridge) {
    const path = await bridge.saveFile({ name, data, encoding: 'utf8', filters: [{ name: label, extensions: [ext] }] });
    if (path) toast.success('Exported', path);
    return path;
  }
  download(name, data, mime);
  return name;
}

function pageHTML(title: string, bodyHTML: string, paper: string, line: number) {
  return `<article class="nib-doc nib-print paper-${paper}" style="--line:${line}px">
  <h1 class="doc-title">${escapeHtml(title || 'Untitled')}</h1>
  <div class="doc-body">${bodyHTML}</div>
</article>`;
}

export async function exportNote(id: string, kind: ExportKind) {
  const { note, content, pads } = liveContent(id);
  if (!note) return;
  const title = note.meta.title || 'Untitled';
  const name = sanitizeFileName(title);
  const settings = useSettings.getState();
  // Without measured padding the lines could drift from the text, so fall back to blank paper.
  const paper = pads ? (note.meta.paper ?? settings.paper) : 'blank';
  const line = LINE_PX[settings.lineSpacing];
  try {
    if (kind === 'md') return await saveText(`${name}.md`, docToMarkdown(title, content), 'text/markdown', 'md', 'Markdown');
    if (kind === 'nib') return await saveText(`${name}.nib`, serializeNote({ ...note, content: content! }), 'application/json', 'nib', 'Nib note');
    if (kind === 'html') {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
        title,
      )}</title><style>${exportCss}</style></head><body>${pageHTML(title, docToHTML(content, { mathml: true, pads }), paper, line)}</body></html>`;
      return await saveText(`${name}.html`, html, 'text/html', 'html', 'Web page');
    }
    // PDF: render a print-only copy of the note, then print it.
    const root = document.getElementById('print-root')!;
    root.innerHTML = pageHTML(title, docToHTML(content, { pads }), paper, line);
    const pageSize = settings.pageSize === 'a4' ? 'A4' : 'letter';
    const style = document.createElement('style');
    style.textContent = `@page { size: ${pageSize}; margin: 0.6in 80px; }`;
    root.appendChild(style);
    document.body.classList.add('is-printing');
    await document.fonts.ready;
    await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => (img.complete ? null : img.decode().catch(() => null))));
    await nextFrame();
    await nextFrame();
    try {
      if (bridge) {
        const path = await bridge.exportPdf({ name });
        if (path) toast.success('Exported PDF', path);
        return path;
      }
      window.print();
      return name;
    } finally {
      document.body.classList.remove('is-printing');
      root.innerHTML = '';
    }
  } catch (e) {
    toast.error('Export failed', String((e as Error).message ?? e));
    return null;
  }
}
