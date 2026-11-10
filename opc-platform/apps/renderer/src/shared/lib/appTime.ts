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
