import type { JSONContent } from '@tiptap/core';
import { complete } from './ai/actions';
import type { Priority } from './ai/engine';
import { PAGE_OCR_PROMPT } from './ai/prompts';
import { downscaleImage } from './ink/raster';
import { useVault } from '../state/vault';
import { visionModel } from '../state/ai';
import { editors } from '../editor/registry';
import { findBlock } from '../editor/ink/ops';

/**
 * Reading scanned pages. A scanned worksheet is just pictures, so the
 * assistant can't see its questions until they are read. Pages whose PDF had
 * no text layer are read with the local vision model, and the text is kept as
 * the image's description (searchable, and part of the homework context).
 */

const NO_TEXT = /^Page \d+:?\s*$/;

export function needsReading(attrs: Record<string, unknown> | undefined): boolean {
  const alt = String(attrs?.alt ?? '').trim();
  return !alt || NO_TEXT.test(alt) || alt.length < 24;
}

function liveContent(noteId: string): JSONContent | undefined {
  const ed = editors.get(noteId);
  return ed && !ed.isDestroyed ? ed.getJSON() : useVault.getState().notes[noteId]?.content;
}

function setAlt(noteId: string, blockId: string, alt: string) {
  const ed = editors.get(noteId);
  if (ed && !ed.isDestroyed) {
    const f = findBlock(ed.state.doc, blockId);
    if (f) ed.view.dispatch(ed.state.tr.setNodeAttribute(f.pos, 'alt', alt).setMeta('addToHistory', false));
    return;
  }
  const note = useVault.getState().notes[noteId];
  if (!note) return;
  const content = structuredClone(note.content);
  for (const b of content.content ?? []) if (b.type === 'image' && b.attrs?.id === blockId) b.attrs = { ...b.attrs, alt };
  useVault.getState().updateContent(noteId, content);
}

/** Reads one page image and stores its text. */
export async function readPage(noteId: string, blockId: string, opts: { priority?: Priority; signal?: AbortSignal } = {}): Promise<string> {
  const block = (liveContent(noteId)?.content ?? []).find((b) => b.type === 'image' && b.attrs?.id === blockId);
  const src = String(block?.attrs?.src ?? '');
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(src);
  if (!m) throw new Error('This image can’t be read (it isn’t stored in the note).');
  const image = await downscaleImage(m[2], 1600, m[1]);
  const res = await complete([{ role: 'user', content: PAGE_OCR_PROMPT, images: [image] }], {
    vision: true,
    temperature: 0,
    label: opts.priority === 'background' ? 'Read scanned page (background)' : 'Read scanned page',
    priority: opts.priority,
    signal: opts.signal,
  });
  const label = String(block?.attrs?.title ?? '').match(/Page \d+/)?.[0] ?? String(block?.attrs?.alt ?? '').match(/^Page \d+/)?.[0] ?? 'Page';
  const text = res.text.replace(/```[a-z]*\n?|```/g, '').trim();
  setAlt(noteId, blockId, `${label}: ${text}`);
  return text;
}

/** Reads every page of a note that has no text yet. Returns how many were read. */
export async function readScannedPages(noteId: string, opts: { priority?: Priority; onProgress?(done: number, total: number): void } = {}): Promise<number> {
  if (!visionModel()) return 0;
  const pages = (liveContent(noteId)?.content ?? []).filter((b) => b.type === 'image' && b.attrs?.id && needsReading(b.attrs));
  let done = 0;
  for (const p of pages) {
    await readPage(noteId, String(p.attrs!.id), { priority: opts.priority });
    opts.onProgress?.(++done, pages.length);
  }
  return done;
}
