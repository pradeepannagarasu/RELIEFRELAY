export function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={inverse ? 'rr-logo rr-logo--inverse' : 'rr-logo'}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="7" fill={inverse ? '#ffffff' : '#123B3A'} />
        <path
          d="M22.5 11.5A7.5 7.5 0 1 0 23.5 17"
          fill="none"
          stroke={inverse ? '#123B3A' : '#ffffff'}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M23.5 7.5v4.5H19"
          fill="none"
          stroke={inverse ? '#123B3A' : '#ffffff'}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="16" r="2.6" fill="#2E8B68" />
      </svg>
      <span className="rr-logo__word">ReliefRelay</span>
    </span>
  );
}
