import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { SourceRef } from '../../state/assistant';
import { useUI } from '../../state/ui';
import { citedInAnswer, renderMarkdown } from '../../lib/ai/markdown';
import { Popover } from '../common/Popover';

/** Opens the cited note and flashes the cited passage. */
export function openSource(src: SourceRef) {
  useUI.getState().openNote(src.noteId, { blockId: src.blockId ?? undefined });
}

/** First ~420 characters of a passage, without its heading line, ending on a word. */
export function trimExcerpt(text: string): string {
  // A highlight in the notes reads "==like this==" as text: the preview shows just the words.
  const body = text
    .replace(/^#{1,6} .*\n?/, '')
    .replace(/==(?=\S)([^\n]*?\S)==/g, '$1')
    .trim();
  if (body.length <= 420) return body;
  return body.slice(0, 420).replace(/\s+\S*$/, '') + ' …';
}

/**
 * A [n] chip → a card with exactly what the note says (NotebookLM's citation
 * popover: the section, the passage, then the note it's from, which opens it).
 * Clicking a chip pins the card; `hover` also shows it while the pointer rests
 * on a chip or the card.
 */
export function useCitePreview(opts: { placement?: 'top' | 'right' | 'left' } = {}) {
  const [preview, setPreview] = useState<{ el: HTMLElement; src: SourceRef; pinned: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The open chip looks pressed.
  useEffect(() => {
    const el = preview?.el;
    el?.classList.add('is-active');
    return () => el?.classList.remove('is-active');
  }, [preview?.el]);

  const show = (n: number, el: HTMLElement, sources: SourceRef[] | undefined) => {
    const src = sources?.find((s) => s.n === n);
    window.clearTimeout(timer.current);
    if (src) setPreview({ el, src, pinned: true });
  };
  /** Pointer handlers for an element holding chips (one answer, whose sources they cite). */
  const hover = (sources: SourceRef[] | undefined) => ({
    onPointerOver: (e: React.PointerEvent) => {
      const el = (e.target as HTMLElement).closest('.cite') as HTMLElement | null;
      if (!el || e.pointerType === 'touch') return;
      const src = sources?.find((s) => s.n === Number(el.dataset.cite));
      if (!src) return;
      later(() => setPreview((p) => (p?.el === el ? p : { el, src, pinned: false })), 150);
    },
    onPointerOut: (e: React.PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.cite')) return;
      later(() => setPreview((p) => (p && !p.pinned ? null : p)), 200);
    },
  });
  const side = opts.placement === 'right' || opts.placement === 'left';
  const src = preview?.src;
  const heading = src ? src.section.split(' › ').pop() || src.title : '';
  const where = src?.folder.split('/')[0];
  const popover = (
    <Popover
      anchor={preview?.el ?? null}
      open={!!preview}
      onClose={() => setPreview(null)}
      placement={opts.placement ?? 'top'}
      align={side ? 'start' : 'center'}
      className="cite-pop"
    >
      {src && (
        <div
          className="cite-preview"
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onPointerLeave={() => later(() => setPreview((p) => (p && !p.pinned ? null : p)), 200)}
        >
          <div className="cite-preview-body">
            <div className="cite-preview-head">{heading}</div>
            <div className="cite-preview-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(trimExcerpt(src.text)) }} />
          </div>
          <button
            className="btn cite-preview-foot"
            title="Open in note"
            onClick={() => {
              setPreview(null);
              openSource(src);
            }}
          >
            <FileText size={16} />
            <span className="cite-preview-title">{src.title}</span>
            {where && <span className="cite-preview-sec">· {where}</span>}
          </button>
        </div>
      )}
    </Popover>
  );
  return { show, hover, popover };
}

/** The notes an answer used (only the ones it actually cited, when it cited any). */
export function SourcesList({ content, sources, label = 'Sources from your notes' }: { content: string; sources: SourceRef[]; label?: string }) {
  const used = citedInAnswer(content, sources.length);
  const cited = sources.filter((s) => used.has(s.n));
  const list = cited.length ? cited : sources.length <= 3 ? sources : [];
  if (!list.length) return null;
  return (
    <div className="sources">
      <div className="sources-label">{label}</div>
      <div className="sources-list">
        {list.map((s) => (
          <button key={s.n} className="source" onClick={() => openSource(s)}>
            <span className="cite-n">{s.n}</span>
            <span className="source-text">
              <span className="source-title">{s.title}</span>
              <span className="source-sec">{[s.folder, s.section].filter(Boolean).join(' › ') || 'Note'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
