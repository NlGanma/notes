import { useState } from 'react';
import type { SourceRef } from '../../state/assistant';
import { useUI } from '../../state/ui';
import { citedInAnswer, renderMarkdown } from '../../lib/ai/markdown';
import { Popover } from '../common/Popover';

/** Opens the cited note and flashes the cited passage. */
export function openSource(src: SourceRef) {
  useUI.getState().openNote(src.noteId, { newTab: true, blockId: src.blockId ?? undefined });
}

/** First ~420 characters of a passage, without its heading line, ending on a word. */
export function trimExcerpt(text: string): string {
  const body = text.replace(/^#{1,6} .*\n?/, '').trim();
  if (body.length <= 420) return body;
  return body.slice(0, 420).replace(/\s+\S*$/, '') + ' …';
}

/** Click a [n] chip → a preview of exactly what the note says, with a jump to it. */
export function useCitePreview() {
  const [preview, setPreview] = useState<{ el: HTMLElement; src: SourceRef } | null>(null);
  const show = (n: number, el: HTMLElement, sources: SourceRef[] | undefined) => {
    const src = sources?.find((s) => s.n === n);
    if (src) setPreview({ el, src });
  };
  const popover = (
    <Popover anchor={preview?.el ?? null} open={!!preview} onClose={() => setPreview(null)} placement="top" className="cite-pop">
      {preview && (
        <div className="cite-preview">
          <div className="cite-preview-head">
            <span className="cite-n">{preview.src.n}</span>
            <span className="cite-preview-title">{preview.src.title}</span>
            {preview.src.section && <span className="cite-preview-sec">› {preview.src.section}</span>}
          </div>
          <div className="cite-preview-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(trimExcerpt(preview.src.text)) }} />
          <button
            className="btn is-small is-secondary"
            onClick={() => {
              setPreview(null);
              openSource(preview.src);
            }}
          >
            Open in note
          </button>
        </div>
      )}
    </Popover>
  );
  return { show, popover };
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
