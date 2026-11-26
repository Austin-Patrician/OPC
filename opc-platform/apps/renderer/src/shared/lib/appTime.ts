const TIMEZONE_KEY = 'opc.assistant.timezone';

/** Shared display zone for timestamps; absent or invalid values follow the OS. */
export function appTimeZone(): string | undefined {
  const value = typeof localStorage === 'undefined' ? '' : localStorage.getItem(TIMEZONE_KEY)?.trim() ?? '';
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

export function setAppTimeZone(value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value) localStorage.setItem(TIMEZONE_KEY, value);
  else localStorage.removeItem(TIMEZONE_KEY);
}

export function formatAppDate(date: Date | number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: appTimeZone(), year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}

export function formatAppTime(date: Date | number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: appTimeZone(), hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * Formats elapsed duration concisely without internal spaces (`3m12s`, `1h05m`, `1d4h`)
 * so telemetry rows and consolidation timelines stay compact across drawers and settings.
 */
export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (totalMin < 60) {
    return secs === 0 ? `${totalMin}m` : `${totalMin}m${String(secs).padStart(2, '0')}s`;
  }
  const totalHrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHrs < 24) {
    return mins === 0 ? `${totalHrs}h` : `${totalHrs}h${String(mins).padStart(2, '0')}m`;
  }
  const days = Math.floor(totalHrs / 24);
  const remHrs = totalHrs % 24;
  return remHrs === 0 ? `${days}d` : `${days}d${remHrs}h`;
}

export interface RelativeAgeLabels {
  justNow: string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  daysAgo: (count: number) => string;
}

/** Formats concise human-readable relative age (`Just now`, `12m ago`, `2h ago`, `3d ago`). */
export function formatRelativeAge(
  timestamp: number,
  now: number,
  labels: RelativeAgeLabels,
): string {
  const diffMs = Math.max(0, now - timestamp);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return labels.justNow;
  if (mins < 60) return labels.minutesAgo(mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return labels.hoursAgo(hrs);
  const days = Math.floor(hrs / 24);
  return labels.daysAgo(days);
}
