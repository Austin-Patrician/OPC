import React from "react"

/**
 * Custom Badge 1: Inspiration & Angles (Multi-point gem star with soft mint glow)
 */
export const InspirationBadgeIcon: React.FC<{ className?: string }> = ({
  className = "w-[38px] h-[38px]",
}) => (
  <div
    className={`relative rounded-[12px] flex items-center justify-center shrink-0 border border-[#CEEBD9] shadow-[0_2px_8px_rgba(34,181,96,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] select-none ${className}`}
    style={{
      background:
        "linear-gradient(135deg, #E6FAF0 0%, #D8F5E4 50%, #C2EED4 100%)",
    }}
  >
    <svg viewBox="0 0 32 32" className="w-[20px] h-[20px] overflow-visible">
      <defs>
        <linearGradient id="starGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#28CE6E" />
          <stop offset="100%" stopColor="#129649" />
        </linearGradient>
        <linearGradient id="sparkGold" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#8BE2AF" />
          <stop offset="100%" stopColor="#22B560" />
        </linearGradient>
      </defs>
      {/* Soft Glow Diamond Behind */}
      <path
        d="M16 4 Q16 16 28 16 Q16 16 16 28 Q16 16 4 16 Q16 16 16 4 Z"
        fill="url(#starGrad1)"
      />
      {/* Inner Highlight Core */}
      <circle cx="16" cy="16" r="3.2" fill="#FFFFFF" opacity="0.9" />
      {/* Little Orbiting Sparkle Top-Right */}
      <circle cx="24.5" cy="7.5" r="2" fill="url(#sparkGold)" />
      {/* Little Orbiting Sparkle Bottom-Left */}
      <circle cx="7.5" cy="23.5" r="1.4" fill="#1FAF57" opacity="0.8" />
    </svg>
  </div>
)

/**
 * Custom Badge 2: Digest & Synthesis (Layered notebook / clean memo lines)
 */
export const DigestBadgeIcon: React.FC<{ className?: string }> = ({
  className = "w-[38px] h-[38px]",
}) => (
  <div
    className={`relative rounded-[12px] flex items-center justify-center shrink-0 border border-[#CCE8F2] shadow-[0_2px_8px_rgba(20,130,170,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] select-none ${className}`}
    style={{
      background:
        "linear-gradient(135deg, #E2F4FA 0%, #D2EEF5 50%, #BFE5EE 100%)",
    }}
  >
    <svg viewBox="0 0 32 32" className="w-[20px] h-[20px]">
      <defs>
        <linearGradient id="memoSheet" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#EDF8FA" />
        </linearGradient>
      </defs>
      {/* Back Sheet Angle */}
      <rect
        x="10.5"
        y="5.5"
        width="14"
        height="18"
        rx="3"
        fill="#94D2E2"
        opacity="0.6"
      />
      {/* Front Sheet */}
      <rect
        x="7.5"
        y="8.5"
        width="14"
        height="18"
        rx="3"
        fill="url(#memoSheet)"
        stroke="#80C8DC"
        strokeWidth="1.2"
      />
      {/* Summary Content Lines */}
      <line
        x1="11"
        y1="13.5"
        x2="18"
        y2="13.5"
        stroke="#1E829B"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="17.5"
        x2="16.5"
        y2="17.5"
        stroke="#27A0BE"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="21.5"
        x2="15"
        y2="21.5"
        stroke="#68BDD2"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  </div>
)

/**
 * Custom Badge 3: Planning & Day-to-Day Flow (Compass/calendar flow badge)
 */
export const PlannerBadgeIcon: React.FC<{ className?: string }> = ({
  className = "w-[38px] h-[38px]",
}) => (
  <div
    className={`relative rounded-[12px] flex items-center justify-center shrink-0 border border-[#D5EAD9] shadow-[0_2px_8px_rgba(40,150,80,0.07),inset_0_1px_0_rgba(255,255,255,0.9)] select-none ${className}`}
    style={{
      background:
        "linear-gradient(135deg, #ECF8EC 0%, #E0F3E3 50%, #CDEBD2 100%)",
    }}
  >
    <svg viewBox="0 0 32 32" className="w-[20px] h-[20px]">
      {/* Outer Dial Circle */}
      <circle
        cx="16"
        cy="16"
        r="11"
        fill="#FFFFFF"
        stroke="#8AD19E"
        strokeWidth="1.3"
      />
      {/* Compass Needle - Green North Pointer */}
      <polygon points="16,8 19,15 16,16 13,15" fill="#22B560" />
      {/* Compass Needle - Soft Mint South Pointer */}
      <polygon points="16,24 19,17 16,16 13,17" fill="#A8DEC0" />
      {/* Center Pivot Pin */}
      <circle cx="16" cy="16" r="2" fill="#157F3F" />
      <circle cx="16" cy="16" r="0.8" fill="#FFFFFF" />
    </svg>
  </div>
)
