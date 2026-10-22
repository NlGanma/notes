import { cx } from '../../lib/util';

/**
 * Primary tabs (Google Classroom / Material 3): adjacent labels in a 48px row
 * over a hairline, the active one marked by a 3px indicator with rounded top
 * corners. Left/Right arrows move between tabs.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  children,
}: {
  items: { id: T; label: string; count?: number }[];
  value: T;
  onChange(id: T): void;
  className?: string;
  /** Icon buttons at the right end of the row. */
  children?: React.ReactNode;
}) {
  return (
    <div className={cx('gtabs', className)}>
      <div
        className="gtabs-list"
        role="tablist"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          const i = items.findIndex((t) => t.id === value);
          const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
          onChange(next.id);
          (e.currentTarget.querySelectorAll('button')[items.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
        }}
      >
        {items.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === value}
            tabIndex={t.id === value ? 0 : -1}
            className={cx('gtab', t.id === value && 'is-active')}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count ? <span className="gtab-count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {children && <div className="gtabs-end">{children}</div>}
    </div>
  );
}
