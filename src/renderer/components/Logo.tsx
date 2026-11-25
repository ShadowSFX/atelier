/** Atelier's mark: a prompt chevron and cursor on an accent tile. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <rect width="18" height="18" rx="4.5" fill="var(--accent)" />
      <path
        d="M4.6 5.4 8.2 9l-3.6 3.6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="9.6" y="11.4" width="4.2" height="1.7" rx="0.85" fill="#fff" />
    </svg>
  );
}
