/** Small inline Buddy robot mark, adapted from the supplied IM reference. */
export function BuddyMark({ size = 'md' }: { size?: 'md' | 'lg' | 'xl' }) {
  const dimension = size === 'xl' ? 'size-[78px]' : size === 'lg' ? 'size-[58px]' : 'size-10';
  return (
    <span
      className={`buddy-mark relative inline-flex shrink-0 items-center justify-center ${dimension}`}
      aria-hidden
    >
      <svg viewBox="0 0 64 64" className="size-full overflow-visible">
        <defs>
          <linearGradient id="buddy-mint-base" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#e6f7ed" />
            <stop offset="1" stopColor="#cbead8" />
          </linearGradient>
          <radialGradient id="buddy-ink-head" cx="38%" cy="30%" r="70%">
            <stop stopColor="#38424a" />
            <stop offset=".5" stopColor="#1b2025" />
            <stop offset="1" stopColor="#0e1114" />
          </radialGradient>
        </defs>
        <circle cx="31" cy="33" r="26" fill="url(#buddy-mint-base)" />
        <ellipse cx="31" cy="12" rx="4.5" ry="2" fill="#9bb5a8" />
        <rect x="29.5" y="12" width="3" height="4" rx="1.5" fill="#7fa090" />
        <path
          d="M13 28 15 15c.4-2.2 3-2.8 4.6-1.2L26 20Zm36 0-2-13c-.4-2.2-3-2.8-4.6-1.2L36 20Z"
          fill="url(#buddy-ink-head)"
        />
        <path d="m15.8 24 1.2-7.5 5.2 4.5Zm30.4 0L45 16.5 39.8 21Z" fill="#4e7a65" opacity=".55" />
        <rect x="8.5" y="29" width="5" height="11" rx="2.5" fill="#2a333a" />
        <rect x="48.5" y="29" width="5" height="11" rx="2.5" fill="#2a333a" />
        <rect x="12" y="19" width="38" height="30" rx="14" fill="url(#buddy-ink-head)" />
        <path
          d="M19 23.5q12-3 24 0"
          fill="none"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity=".28"
        />
        <rect x="16.5" y="25" width="29" height="19" rx="9" fill="#090c0f" />
        <rect x="22" y="30.5" width="4.2" height="6.8" rx="2.1" fill="#e8fff2" />
        <rect x="35.8" y="30.5" width="4.2" height="6.8" rx="2.1" fill="#e8fff2" />
        <path
          d="M29 36.8q2 2 4 0"
          fill="none"
          stroke="#88e6b0"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="48" cy="47" r="6.5" fill="#b8e9ca" stroke="white" strokeWidth="1.8" />
        <path d="M45.5 47h5m-4 2.2h3" stroke="#1fa958" strokeWidth="1.3" strokeLinecap="round" />
        <g stroke="#22b560" strokeWidth="2.2" strokeLinecap="round">
          <path d="m52 11 2.5-4.5M56.5 15.5l4-2.5" />
        </g>
      </svg>
    </span>
  );
}
