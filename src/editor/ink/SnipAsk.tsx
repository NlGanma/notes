import { useEffect, useRef, useState } from 'react';
import { ArrowUp, X } from 'lucide-react';
import type { Bounds } from '../../lib/ink/types';
import { useSideShift } from './inView';
import { ComposerStatus, useAvailability } from '../../components/ai/ComposerStatus';

import type { AskMode } from '../../lib/ai/prompts';
export type { AskMode };

const QUICK: { mode: AskMode; label: string }[] = [
  { mode: 'explain', label: 'Explain' },
  { mode: 'tutor', label: 'Hint' },
  { mode: 'check', label: 'Check my work' },
  { mode: 'solve', label: 'Solve it' },
];

/**
 * The small composer that opens under a Select box, a selection's Ask or a handwriting area's "Ask about
 * this…": a question of your own, or one of the four things students ask most.
 */
export function SnipAsk({
  bounds,
  inv,
  placeholder = 'Ask about this part of the page…',
  onSubmit,
  onCancel,
}: {
  bounds: Bounds;
  inv: number;
  placeholder?: string;
  onSubmit(mode: AskMode, prompt?: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const availability = useAvailability();
  // While the model is only starting, a question waits for it; with none running, it couldn't be answered.
  const answerable = availability !== 'offline' && availability !== 'nomodel';
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const shift = useSideShift(boxRef, inv, [bounds.minX, bounds.maxX, inv]);
  useEffect(() => {
    const input = ref.current;
    input?.focus({ preventScroll: true });
    // Under writing near the bottom of the window it would open out of sight.
    input?.closest('.snip-ask')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      ref={boxRef}
      className="snip-ask"
      data-ui
      style={{
        left: (bounds.minX + bounds.maxX) / 2 + shift,
        top: bounds.maxY + 10 * inv,
        transform: `translateX(-50%) scale(${inv})`,
        transformOrigin: '50% 0',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ComposerStatus availability={availability} />
      <form
        className="snip-ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && answerable) onSubmit('custom', text.trim());
        }}
      >
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            // Typing stays in here (the page would take letters as typing, ⌥-letters as tools).
            e.stopPropagation();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <button type="submit" className="snip-send" disabled={!text.trim() || !answerable} aria-label="Ask">
          <ArrowUp size={16} strokeWidth={2.25} />
        </button>
      </form>
      <div className="snip-quick">
        {QUICK.map((q) => (
          <button key={q.mode} type="button" disabled={!answerable} onClick={() => onSubmit(q.mode)}>
            {q.label}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="snip-close" onClick={onCancel} aria-label="Close" title="Close  Esc">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
