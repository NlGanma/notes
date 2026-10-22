import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Icons from 'lucide-react';
import { useSlash } from '../extensions/slash';
import { cx } from '../../lib/util';

const GROUP_ORDER = ['Basic', 'Lists', 'Ink & math', 'Blocks', 'AI'];

export function SlashMenu() {
  const { open, items, index, rect, pick, set } = useSlash();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !rect || !ref.current) return;
    const h = ref.current.offsetHeight;
    const w = ref.current.offsetWidth;
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 6);
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, rect.left - 8));
    setPos({ left, top });
  }, [open, rect, items.length]);

  useEffect(() => {
    ref.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open || !items.length) return null;

  const grouped = GROUP_ORDER.map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter((x) => x.list.length);
  let flat = 0;

  return createPortal(
    <div ref={ref} className="slash-menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }} data-ui>
      {grouped.map(({ g, list }) => (
        <div key={g} className="slash-group">
          <div className="slash-group-label">{g}</div>
          {list.map((item) => {
            const i = items.indexOf(item);
            flat++;
            const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[item.icon] ?? Icons.Square;
            return (
              <button
                key={item.id}
                className={cx('slash-item', i === index && 'is-active', item.group === 'AI' && 'is-ai')}
                onMouseEnter={() => set({ index: i })}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick?.(item);
                }}
              >
                <span className="slash-icon">
                  <Icon size={16} />
                </span>
                <span className="slash-text">
                  <span className="slash-title">{item.title}</span>
                  <span className="slash-hint">{item.hint}</span>
                </span>
                {item.shortcut && <kbd className="slash-kbd">{item.shortcut}</kbd>}
              </button>
            );
          })}
        </div>
      ))}
      <div className="slash-foot" data-count={flat}>
        <span>↑↓ to navigate</span>
        <span>↵ to insert</span>
        <span>esc to close</span>
      </div>
    </div>,
    document.body,
  );
}
