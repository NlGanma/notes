import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Icons from 'lucide-react';
import { SLASH_GROUPS, useSlash, type SlashItem } from '../extensions/slash';
import { renderMath } from '../../lib/katex';
import { cx } from '../../lib/util';

/** Bars standing in for text in the preview cards. */
const Bars = ({ widths }: { widths: number[] }) => (
  <>
    {widths.map((w, i) => (
      <span key={i} className="sp-bar" style={{ width: `${w}%` }} />
    ))}
  </>
);

function Preview({ item }: { item: SlashItem }): ReactNode {
  switch (item.id) {
    case 'h1':
    case 'h2':
    case 'h3':
      return (
        <div className="sp-doc">
          <div className={cx('sp-heading', `is-${item.id}`)}>{item.title}</div>
          <Bars widths={[92, 70]} />
        </div>
      );
    case 'bullets':
    case 'numbers':
    case 'todo':
      return (
        <div className="sp-doc">
          {[78, 60, 70].map((w, i) => (
            <span key={i} className="sp-row">
              {item.id === 'bullets' && <span className="sp-dot" />}
              {item.id === 'numbers' && <span className="sp-num">{i + 1}.</span>}
              {item.id === 'todo' && <span className={cx('sp-check', i === 0 && 'is-done')}>{i === 0 && <Icons.Check size={9} strokeWidth={3.5} />}</span>}
              <span className="sp-bar" style={{ width: `${w}%` }} />
            </span>
          ))}
        </div>
      );
    case 'quote':
      return (
        <div className="sp-doc">
          <div className="sp-quote">
            <Bars widths={[88, 64]} />
          </div>
        </div>
      );
    case 'callout':
      return (
        <div className="sp-doc">
          <div className="sp-callout">
            <Icons.Info size={14} />
            <span className="sp-callout-body">
              <Bars widths={[90, 55]} />
            </span>
          </div>
        </div>
      );
    case 'divider':
      return (
        <div className="sp-doc">
          <Bars widths={[80]} />
          <span className="sp-rule" />
          <Bars widths={[66]} />
        </div>
      );
    case 'code':
      return (
        <div className="sp-doc">
          <pre className="sp-code">{'def area(r):\n    return pi * r ** 2'}</pre>
        </div>
      );
    case 'ink':
    case 'sketch':
      return (
        <div className="sp-doc">
          {item.id === 'sketch' && (
            <span className="sp-row">
              <span className="sp-bar" style={{ width: '38%' }} />
              <svg width="34" height="16" viewBox="0 0 34 16" className="sp-ink">
                <path d="M2 12 C8 2, 12 2, 14 10 S22 15, 24 6 M24 6 L31 6 M28 3 L31 6 L28 9" />
              </svg>
              <span className="sp-bar" style={{ width: '30%' }} />
            </span>
          )}
          {item.id === 'ink' && (
            <svg width="190" height="64" viewBox="0 0 190 64" className="sp-ink">
              <path d="M8 40 C14 18, 22 18, 24 38 C26 52, 32 30, 38 36 C44 44, 48 22, 54 26 C60 30, 58 44, 66 40" />
              <path d="M78 22 L78 44 M72 32 L84 32" />
              <path d="M96 40 C102 20, 110 20, 112 38 C114 50, 122 26, 128 34" />
              <path d="M140 33 L160 33 M140 40 L160 40" />
              <path d="M172 24 C180 20, 182 30, 174 34 C182 36, 184 46, 172 44" />
            </svg>
          )}
          {item.id === 'ink' && <Bars widths={[74]} />}
        </div>
      );
    case 'math':
    case 'imath':
      return (
        <div className="sp-doc">
          {item.id === 'imath' ? (
            <span className="sp-row">
              <span className="sp-bar" style={{ width: '24%' }} />
              <span className="sp-math" dangerouslySetInnerHTML={{ __html: renderMath('x^2+y^2=r^2', false) }} />
              <span className="sp-bar" style={{ width: '22%' }} />
            </span>
          ) : (
            <span className="sp-math is-display" dangerouslySetInnerHTML={{ __html: renderMath('\\int_0^1 x^2\\,dx = \\tfrac{1}{3}', true) }} />
          )}
        </div>
      );
    case 'image':
      return (
        <div className="sp-doc">
          <span className="sp-image">
            <Icons.Image size={22} />
          </span>
        </div>
      );
    default:
      return (
        <div className="sp-doc">
          <Bars widths={[90, 84, 60]} />
        </div>
      );
  }
}

/** The "/" menu, in Notion's compact form: grouped rows, markdown hints on the right, a preview on hover. */
export function SlashMenu() {
  const { open, items, index, rect, pick, set, query, matched } = useSlash();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [preview, setPreview] = useState<{ id: string; top: number; left: number } | null>(null);
  // Notion gives up once a few characters in a row match nothing.
  const gaveUp = !items.length && query.length - matched >= 4;
  const shown = open && !gaveUp;

  useLayoutEffect(() => {
    if (!shown || !rect || !ref.current) return;
    const h = ref.current.offsetHeight;
    const w = ref.current.offsetWidth;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, rect.left - 4));
    setPos({ left, top });
  }, [shown, rect, items.length]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  // The preview card follows the active row after a short pause.
  const active = items[index];
  useEffect(() => {
    setPreview(null);
    if (!shown || !active || !pos) return;
    const timer = setTimeout(() => {
      const menu = ref.current;
      const row = listRef.current?.querySelector<HTMLElement>('.slash-item.is-active');
      if (!menu || !row) return;
      const m = menu.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const W = 224;
      const left = m.right + 8 + W < window.innerWidth - 8 ? m.right + 8 : m.left - 8 - W;
      setPreview({ id: active.id, top: Math.min(r.top - 4, window.innerHeight - 190), left });
    }, 300);
    return () => clearTimeout(timer);
  }, [shown, active, pos]);

  const grouped = useMemo(() => SLASH_GROUPS.map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter((x) => x.list.length), [items]);

  if (!shown) return null;

  return createPortal(
    <>
      <div ref={ref} className="slash-menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }} data-ui onMouseDown={(e) => e.preventDefault()}>
        <div className="slash-list" ref={listRef}>
          {!items.length && <div className="slash-empty">No results</div>}
          {grouped.map(({ g, list }) => (
            <div key={g} className="slash-group" role="group" aria-label={g}>
              <div className="slash-group-label">{g}</div>
              {list.map((item) => {
                const i = items.indexOf(item);
                const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[item.icon] ?? Icons.Square;
                return (
                  <button
                    key={item.id}
                    className={cx('slash-item', i === index && 'is-active')}
                    onMouseEnter={() => set({ index: i })}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick?.(item);
                    }}
                  >
                    <span className="slash-icon">
                      <Icon size={18} />
                    </span>
                    <span className="slash-title">{item.title}</span>
                    {item.shortcut && <span className="slash-kbd">{item.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <button className="slash-foot" onMouseDown={(e) => e.preventDefault()} onClick={() => set({ open: false })}>
          <span>Close menu</span>
          <kbd>esc</kbd>
        </button>
      </div>
      {preview && active?.id === preview.id && (
        <div className="slash-preview" style={{ left: preview.left, top: preview.top }} data-ui>
          <div className="slash-preview-art">
            <Preview item={active} />
          </div>
          <div className="slash-preview-text">{active.hint}</div>
        </div>
      )}
    </>,
    document.body,
  );
}
