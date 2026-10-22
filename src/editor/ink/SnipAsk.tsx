import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpenCheck, GraduationCap, Lightbulb, ListChecks, Sparkles, X } from 'lucide-react';
import type { Bounds } from '../../lib/ink/types';

import type { AskMode } from '../../lib/ai/prompts';
export type { AskMode };

const QUICK: { mode: AskMode; label: string; icon: typeof Sparkles }[] = [
  { mode: 'explain', label: 'Explain', icon: Lightbulb },
  { mode: 'tutor', label: 'Give me a hint', icon: GraduationCap },
  { mode: 'check', label: 'Check my work', icon: ListChecks },
  { mode: 'solve', label: 'Solve it', icon: BookOpenCheck },
];

/** Popover shown under a snipped area: "what do you want to know about this?" */
export function SnipAsk({
  bounds,
  inv,
  onSubmit,
  onCancel,
}: {
  bounds: Bounds;
  inv: number;
  onSubmit(mode: AskMode, prompt?: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="snip-ask"
      data-ui
      style={{
        left: (bounds.minX + bounds.maxX) / 2,
        top: bounds.maxY + 10 * inv,
        transform: `translateX(-50%) scale(${inv})`,
        transformOrigin: '50% 0',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <form
        className="snip-ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSubmit('custom', text.trim());
        }}
      >
        <Sparkles size={15} className="snip-ask-spark" />
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about this part of the page…"
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" className="snip-send" disabled={!text.trim()} aria-label="Ask">
          <ArrowUp size={15} />
        </button>
        <button type="button" className="snip-close" onClick={onCancel} aria-label="Cancel">
          <X size={14} />
        </button>
      </form>
      <div className="snip-quick">
        {QUICK.map((q) => (
          <button key={q.mode} type="button" onClick={() => onSubmit(q.mode)}>
            <q.icon size={13} /> {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}
