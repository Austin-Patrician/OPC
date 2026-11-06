import React from "react"

interface BuddyAvatarProps {
  size?: "sm" | "md" | "lg" | "xl"
  showSpark?: boolean
  className?: string
}

/**
 * Cute black cat-eared robot mascot ("Buddy") inside a soft mint circle
 * with green spark accents, matching the uploaded reference design.
 */
export const BuddyAvatar: React.FC<BuddyAvatarProps> = ({
  size = "md",
  showSpark = true,
  className = "",
}) => {
  const dims = {
    sm: "w-9 h-9",
    md: "w-11 h-11",
    lg: "w-[58px] h-[58px]",
    xl: "w-[78px] h-[78px]",
  }[size]

  return (
    <div className={`relative inline-flex items-center justify-center shrink-0 select-none ${dims} ${className}`}>
      <svg viewBox="0 0 64 64" className="w-full h-full overflow-visible">
        <defs>
          <linearGradient id="buddyMintBg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#E6F7ED" />
            <stop offset="100%" stopColor="#CBEAD8" />
          </linearGradient>
          <radialGradient id="buddyHeadGrad" cx="38%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#38424A" />
            <stop offset="45%" stopColor="#1B2025" />
            <stop offset="100%" stopColor="#0E1114" />
          </radialGradient>
          <linearGradient id="buddyScreenGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#14191E" />
            <stop offset="100%" stopColor="#090B0E" />
          </linearGradient>
        </defs>

        {/* Soft Mint Circle Base */}
        <circle cx="31" cy="33" r="26" fill="url(#buddyMintBg)" />

        {/* Subtle Top Antenna / Sensor */}
        <ellipse cx="31" cy="12" rx="4.5" ry="2" fill="#9BB5A8" />
        <rect x="29.5" y="12" width="3" height="4" rx="1.5" fill="#7FA090" />

        {/* Left & Right Cat Robot Ears */}
        <path
          d="M13 28 L15 15 C15.4 12.8 18 12.2 19.6 13.8 L26 20 Z"
          fill="url(#buddyHeadGrad)"
        />
        <path
          d="M49 28 L47 15 C46.6 12.8 44 12.2 42.4 13.8 L36 20 Z"
          fill="url(#buddyHeadGrad)"
        />
        {/* Inner Ear Mint Tint */}
        <path d="M15.8 24 L17 16.5 L22.2 21 Z" fill="#4E7A65" opacity="0.55" />
        <path d="M46.2 24 L45 16.5 L39.8 21 Z" fill="#4E7A65" opacity="0.55" />

        {/* Side Headphones / Ear Cups */}
        <rect x="8.5" y="29" width="5" height="11" rx="2.5" fill="#2A333A" />
        <rect x="48.5" y="29" width="5" height="11" rx="2.5" fill="#2A333A" />

        {/* Robot Head Body */}
        <rect
          x="12"
          y="19"
          width="38"
          height="30"
          rx="14"
          fill="url(#buddyHeadGrad)"
        />
        {/* Glossy Highlight on Forehead */}
        <path
          d="M19 23.5 Q31 20.5 43 23.5"
          stroke="#FFFFFF"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.28"
          fill="none"
        />

        {/* Visor Face Screen */}
        <rect
          x="16.5"
          y="25"
          width="29"
          height="19"
          rx="9"
          fill="url(#buddyScreenGrad)"
        />

        {/* Glowing Eyes */}
        <rect x="22" y="30.5" width="4.2" height="6.8" rx="2.1" fill="#E8FFF2" />
        <rect x="35.8" y="30.5" width="4.2" height="6.8" rx="2.1" fill="#E8FFF2" />

        {/* Happy Little Mouth */}
        <path
          d="M29 36.8 Q31 38.8 33 36.8"
          stroke="#88E6B0"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />

        {/* Small Mint Status Bubble at Bottom-Right */}
        <circle cx="48" cy="47" r="6.5" fill="#B8E9CA" stroke="#FFFFFF" strokeWidth="1.8" />
        <path
          d="M45.5 47 H50.5 M46.5 49.2 H49.5"
          stroke="#1FA958"
          strokeWidth="1.3"
          strokeLinecap="round"
        />

        {/* Top-Right Green Spark Lines */}
        {showSpark && (
          <g stroke="#22B560" strokeWidth="2.2" strokeLinecap="round">
            <line x1="52" y1="11" x2="54.5" y2="6.5" />
            <line x1="56.5" y1="15.5" x2="60.5" y2="13" />
          </g>
        )}
      </svg>
    </div>
  )
}

/**
 * User portrait avatar on the right side of user messages.
 */
export const UserAvatar: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div
    className={`w-10 h-10 rounded-full overflow-hidden shrink-0 border border-black/[0.06] bg-[#D8DEE6] shadow-[0_2px_6px_rgba(0,0,0,0.05)] select-none ${className}`}
  >
    <img
      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop&auto=format"
      alt="我"
      className="w-full h-full object-cover"
    />
  </div>
)

/**
 * Soft pastel mountain & clouds illustration card matching the second Buddy message in the attachment.
 */
export const LandscapeIllustration: React.FC<{ className?: string }> = ({
  className = "w-[132px] h-[84px]",
}) => (
  <div
    className={`rounded-[11px] overflow-hidden shrink-0 border border-[#DFECE5] bg-[#CDE4EE] relative select-none ${className}`}
  >
    <svg viewBox="0 0 160 104" className="w-full h-full block">
      <defs>
        <linearGradient id="skyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#CBE2EE" />
          <stop offset="100%" stopColor="#DEEFF5" />
        </linearGradient>
      </defs>
      <rect width="160" height="104" fill="url(#skyGrad)" />
      {/* Soft Warm Sun */}
      <circle cx="44" cy="30" r="10" fill="#EAE6D3" opacity="0.9" />
      {/* White Fluffy Cloud */}
      <path
        d="M108 36 C108 30 114 26 120 28 C123 22 133 22 137 28 C142 28 146 32 146 37 C146 41 142 43 137 43 L113 43 C109 43 108 40 108 36 Z"
        fill="#FFFFFF"
        opacity="0.92"
      />
      {/* Distant Mountain */}
      <path d="M58 104 L106 42 L156 104 Z" fill="#78BCA1" />
      {/* Foreground HillLeft */}
      <path d="M-8 104 L42 48 L98 104 Z" fill="#59A889" />
      {/* Soft Mint Valley Overlay */}
      <path
        d="M-10 104 Q40 74 92 90 Q130 98 166 82 L166 104 Z"
        fill="#8ED1B5"
        opacity="0.75"
      />
    </svg>
  </div>
)
