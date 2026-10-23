import { useId } from 'react';
import { cx } from '../../lib/util';

/**
 * A text field with its name above it and a line of help under it (no floating label). The input
 * comes first in the markup so the name can follow it for the label's `for`; CSS puts the name on top.
 */
export function Field({
  label,
  value,
  onChange,
  helper,
  error,
  autoFocus,
  multiline,
  rows = 4,
  className,
  onKeyDown,
  inputRef,
  maxLength,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  helper?: string;
  error?: string;
  autoFocus?: boolean;
  multiline?: boolean;
  rows?: number;
  className?: string;
  onKeyDown?(e: React.KeyboardEvent): void;
  inputRef?: React.Ref<HTMLInputElement & HTMLTextAreaElement>;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className={cx('gfield', !!value && 'has-value', !!error && 'is-error', multiline && 'is-multiline', className)}>
      <div className="gfield-box">
        {multiline ? (
          <textarea id={id} ref={inputRef} value={value} rows={rows} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} maxLength={maxLength} />
        ) : (
          <input id={id} ref={inputRef} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} maxLength={maxLength} />
        )}
        <label htmlFor={id}>{label}</label>
      </div>
      {(error || helper) && <div className="gfield-help">{error || helper}</div>}
    </div>
  );
}
