import { useId } from 'react';
import { cn } from '@/shared/lib/cn';

type SkillKind =
  | 'pdf'
  | 'excel'
  | 'word'
  | 'convert'
  | 'slides'
  | 'code'
  | 'json'
  | 'design'
  | 'default';

interface GradientSpec {
  stops: readonly [string, string, string];
  shadow: string;
}

const KIND_GRADIENT: Record<SkillKind, GradientSpec> = {
  pdf: {
    stops: ['#FF6B81', '#E11D48', '#BE123C'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(225,29,72,0.42)]',
  },
  excel: {
    stops: ['#34D399', '#10B981', '#047857'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(16,185,129,0.42)]',
  },
  word: {
    stops: ['#60A5FA', '#2563EB', '#1D4ED8'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(37,99,235,0.42)]',
  },
  convert: {
    stops: ['#A78BFA', '#7C3AED', '#5B21B6'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(124,58,237,0.42)]',
  },
  slides: {
    stops: ['#FBBF24', '#F97316', '#C2410C'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(249,115,22,0.42)]',
  },
  code: {
    stops: ['#64748B', '#334155', '#0F172A'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(51,65,85,0.4)]',
  },
  json: {
    stops: ['#22D3EE', '#0891B2', '#0E7490'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(8,145,178,0.42)]',
  },
  design: {
    stops: ['#F472B6', '#DB2777', '#9D174D'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(219,39,119,0.42)]',
  },
  default: {
    stops: ['#818CF8', '#4F46E5', '#3730A3'],
    shadow: 'shadow-[0_4px_12px_-3px_rgba(79,70,229,0.42)]',
  },
};

function detectSkillKind(nameOrId: string): SkillKind {
  const key = nameOrId.toLowerCase();
  if (key.includes('pdf')) return 'pdf';
  if (key.includes('excel') || key.includes('xlsx') || key.includes('csv') || key.includes('sheet')) {
    return 'excel';
  }
  if (key.includes('word') || key.includes('docx')) return 'word';
  if (key.includes('convert') || key.includes('markdown')) return 'convert';
  if (key.includes('ppt') || key.includes('slide')) return 'slides';
  if (key.includes('code') || key.includes('dev')) return 'code';
  if (key.includes('json') || key.includes('schema')) return 'json';
  if (key.includes('design') || key.includes('creative')) return 'design';
  return 'default';
}

/** Layered gradient squircle icon tile for built-in office skills and local skills. */
export function SkillIconTile({
  name,
  active = true,
  size = 'md',
}: {
  name: string;
  active?: boolean;
  size?: 'sm' | 'md';
}) {
  const rawId = useId().replace(/:/g, '');
  const bgId = `skill-bg-${rawId}`;
  const glossId = `skill-gloss-${rawId}`;
  const kind = detectSkillKind(name);
  const spec = KIND_GRADIENT[kind];

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 overflow-hidden ring-1 ring-inset ring-black/8 select-none',
        size === 'sm' ? 'size-8 rounded-[9px]' : 'size-11 rounded-[12px]',
        spec.shadow,
        !active && 'brightness-[0.98]',
      )}
    >
      <svg viewBox="0 0 44 44" fill="none" className="size-full" aria-hidden="true">
        <defs>
          <linearGradient id={bgId} x1="0" y1="0" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={spec.stops[0]} />
            <stop offset="52%" stopColor={spec.stops[1]} />
            <stop offset="100%" stopColor={spec.stops[2]} />
          </linearGradient>
          <linearGradient id={glossId} x1="22" y1="0" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>

        <rect width="44" height="44" fill={`url(#${bgId})`} />
        <rect width="44" height="22" fill={`url(#${glossId})`} />
        <path d="M0 0.5H44" stroke="#FFFFFF" strokeOpacity="0.32" />

        {renderArtwork(kind)}
      </svg>
    </span>
  );
}

function renderArtwork(kind: SkillKind) {
  switch (kind) {
    case 'pdf':
      return (
        <g>
          {/* Subtle back sheet for depth */}
          <rect x="13" y="8" width="18" height="24" rx="2.5" fill="#FFFFFF" fillOpacity="0.28" />
          {/* Main folded-corner page */}
          <path
            d="M11 11.5A2.5 2.5 0 0 1 13.5 9h12.2l7.3 7.3V32.5A2.5 2.5 0 0 1 30.5 35h-17A2.5 2.5 0 0 1 11 32.5v-21Z"
            fill="#FFFFFF"
            fillOpacity="0.96"
          />
          {/* Dog-ear fold */}
          <path d="M25.7 9v4.8a2.5 2.5 0 0 0 2.5 2.5H33L25.7 9Z" fill="#BE123C" fillOpacity="0.22" />
          {/* Subtle header lines */}
          <rect x="14.5" y="13.5" width="7.5" height="1.8" rx="0.9" fill="#E11D48" fillOpacity="0.35" />
          <rect x="14.5" y="17" width="10.5" height="1.8" rx="0.9" fill="#E11D48" fillOpacity="0.24" />
          {/* Lower ribbon accent band */}
          <rect x="13" y="21.5" width="18" height="10" rx="2" fill="#BE123C" fillOpacity="0.14" />
          {/* Editorial trefoil / ribbon bezier mark */}
          <path
            d="M22.2 23.2c-.9 2.3-2.5 4.8-4.5 6.4-.8.6-.3 1.4.6 1.1 2.2-.8 5.2-1.8 7.5-1.5.9.1 1.1-1 .2-1.4-1.8-.8-3-2.6-3.4-4.5-.1-.4-.3-.4-.4-.1Z"
            stroke="#E11D48"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );

    case 'excel':
      return (
        <g>
          {/* Frosted back layer */}
          <rect x="12" y="8.5" width="22" height="22" rx="3" fill="#FFFFFF" fillOpacity="0.28" />
          {/* Main spreadsheet card */}
          <rect x="10" y="12" width="24" height="23" rx="3" fill="#FFFFFF" fillOpacity="0.96" />
          {/* Top header bar */}
          <path
            d="M10 15a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v3.5H10V15Z"
            fill="#059669"
            fillOpacity="0.22"
          />
          {/* Inner grid cells */}
          <rect x="12.5" y="20.5" width="8.5" height="5" rx="1.2" fill="#059669" fillOpacity="0.16" />
          <rect x="23" y="20.5" width="8.5" height="5" rx="1.2" fill="#059669" fillOpacity="0.16" />
          <rect x="12.5" y="27.5" width="8.5" height="5" rx="1.2" fill="#059669" fillOpacity="0.85" />
          <rect x="23" y="27.5" width="8.5" height="5" rx="1.2" fill="#059669" fillOpacity="0.16" />
        </g>
      );

    case 'word':
      return (
        <g>
          {/* Main folded-corner page */}
          <path
            d="M11 11.5A2.5 2.5 0 0 1 13.5 9h12.2l7.3 7.3V32.5A2.5 2.5 0 0 1 30.5 35h-17A2.5 2.5 0 0 1 11 32.5v-21Z"
            fill="#FFFFFF"
            fillOpacity="0.96"
          />
          {/* Dog-ear corner */}
          <path d="M25.7 9v4.8a2.5 2.5 0 0 0 2.5 2.5H33L25.7 9Z" fill="#BFDBFE" />
          {/* Cobalt title bar */}
          <rect x="14.5" y="14" width="9" height="2.6" rx="1.3" fill="#2563EB" fillOpacity="0.85" />
          {/* Editorial text bars */}
          <rect x="14.5" y="19.5" width="15" height="2.2" rx="1.1" fill="#2563EB" fillOpacity="0.32" />
          <rect x="14.5" y="24" width="15" height="2.2" rx="1.1" fill="#2563EB" fillOpacity="0.28" />
          <rect x="14.5" y="28.5" width="10.5" height="2.2" rx="1.1" fill="#2563EB" fillOpacity="0.24" />
        </g>
      );

    case 'convert':
      return (
        <g>
          {/* Upper-left frosted card */}
          <rect x="9.5" y="10" width="13.5" height="16.5" rx="2.5" fill="#FFFFFF" fillOpacity="0.42" />
          {/* Lower-right crisp card */}
          <rect x="21" y="17.5" width="13.5" height="16.5" rx="2.5" fill="#FFFFFF" fillOpacity="0.96" />
          <rect x="23.5" y="21.5" width="8.5" height="2" rx="1" fill="#7C3AED" fillOpacity="0.45" />
          <rect x="23.5" y="25.5" width="6.5" height="2" rx="1" fill="#7C3AED" fillOpacity="0.28" />
          <rect x="23.5" y="29.5" width="7.5" height="2" rx="1" fill="#7C3AED" fillOpacity="0.28" />
          {/* Curved swap arrows */}
          <path
            d="M26 11.5h3.8a2.7 2.7 0 0 1 2.7 2.7v1.1m0 0-2-1.8m2 1.8 1.8-2"
            stroke="#FFFFFF"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M18 32.5h-3.8a2.7 2.7 0 0 1-2.7-2.7v-1.1m0 0 2 1.8m-2-1.8-1.8 2"
            stroke="#FFFFFF"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );

    case 'slides':
      return (
        <g>
          {/* Widescreen presentation slide */}
          <rect x="9" y="11" width="26" height="18" rx="3" fill="#FFFFFF" fillOpacity="0.96" />
          {/* Stand base */}
          <path
            d="M22 29v3.5M17 33h10"
            stroke="#FFFFFF"
            strokeOpacity="0.88"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          {/* Rising 3-bar chart */}
          <rect x="13.5" y="21.5" width="3.5" height="4.5" rx="1" fill="#EA580C" fillOpacity="0.45" />
          <rect x="18.8" y="18.5" width="3.5" height="7.5" rx="1" fill="#EA580C" fillOpacity="0.7" />
          <rect x="24.1" y="15.5" width="3.5" height="10.5" rx="1" fill="#EA580C" />
          {/* Trend accent dot */}
          <circle cx="29.5" cy="14.8" r="1.5" fill="#F97316" />
        </g>
      );

    case 'code':
      return (
        <g>
          <path
            d="m16.5 16.5-5.5 5.5 5.5 5.5M27.5 16.5l5.5 5.5-5.5 5.5"
            stroke="#FFFFFF"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="m24 14.5-4 15"
            stroke="#FFFFFF"
            strokeOpacity="0.65"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
        </g>
      );

    case 'json':
      return (
        <g>
          <path
            d="M17.5 13.5c-1.7 0-2.5.9-2.5 2.5v3.3c0 1.2-.6 2.1-1.8 2.7 1.2.6 1.8 1.5 1.8 2.7V28c0 1.6.8 2.5 2.5 2.5"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M26.5 13.5c1.7 0 2.5.9 2.5 2.5v3.3c0 1.2.6 2.1 1.8 2.7-1.2.6-1.8 1.5-1.8 2.7V28c0 1.6-.8 2.5-2.5 2.5"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20.2" cy="22" r="1.6" fill="#FFFFFF" fillOpacity="0.85" />
          <circle cx="24" cy="22" r="1.6" fill="#FFFFFF" fillOpacity="0.55" />
        </g>
      );

    case 'design':
      return (
        <g>
          <path
            d="M16 13h12l5.5 7L22 33 10.5 20 16 13Z"
            fill="#FFFFFF"
            fillOpacity="0.94"
          />
          <path
            d="M16 13h6l-2.5 7H10.5L16 13Z"
            fill="#FFFFFF"
            fillOpacity="0.45"
          />
          <path
            d="M19.5 20H24.5L22 33l-2.5-13Z"
            fill="#DB2777"
            fillOpacity="0.2"
          />
        </g>
      );

    default:
      return (
        <g>
          {/* Open book pages */}
          <path
            d="M11 16.5c0-1.1.9-2 2-2h7c1.1 0 2 .9 2 2v14.5c-.8-.6-1.8-1-3-1h-6a2 2 0 0 1-2-2V16.5Z"
            fill="#FFFFFF"
            fillOpacity="0.95"
          />
          <path
            d="M33 16.5c0-1.1-.9-2-2-2h-7c-1.1 0-2 .9-2 2v14.5c.8-.6 1.8-1 3-1h6a2 2 0 0 0 2-2V16.5Z"
            fill="#FFFFFF"
            fillOpacity="0.72"
          />
          {/* Four-point spark accent */}
          <path
            d="M22 8.5 23 11l2.5 1L23 13l-1 2.5L21 13l-2.5-1L21 11l1-2.5Z"
            fill="#FFFFFF"
            fillOpacity="0.92"
          />
        </g>
      );
  }
}
