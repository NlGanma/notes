/** The Nib mark: a pen nib in white on an ink tile. */
export function NibMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#141413" />
      <path d="M11 22.5c2.4-5.6 4.2-9.6 5.2-12.2.4-1 1.7-1 2 .1l.3 1.2c.3 1.2 1.1 2.4 2.3 3.1" fill="none" stroke="#faf9f5" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22.4" cy="9.6" r="1.9" fill="#d97757" />
    </svg>
  );
}
