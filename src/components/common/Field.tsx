import { useId } from 'react';
import { cx } from '../../lib/util';

/**
 * A Material 3 filled text field (as in Google Classroom's dialogs): a tinted
 * container with a bottom indicator and a label that floats up when the field
 * has focus or a value. Helper or error text sits under it.
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
          <textarea id={id} ref={inputRef} value={value} rows={rows} autoFocus={autoFocus} placeholder=" " onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} maxLength={maxLength} />
        ) : (
          <input id={id} ref={inputRef} value={value} autoFocus={autoFocus} placeholder=" " onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} maxLength={maxLength} />
        )}
        <label htmlFor={id}>{label}</label>
      </div>
      {(error || helper) && <div className="gfield-help">{error || helper}</div>}
    </div>
  );
}
