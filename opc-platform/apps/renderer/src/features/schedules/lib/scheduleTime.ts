import type { RouterScheduleRule } from '@opc/shared/domain';
import { appTimeZone } from '@/shared/lib/appTime';
import type { SelectOption } from '@/shared/ui/Select';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const COMMON_TIMEZONES: readonly string[] = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

export interface ScheduleTemplatePreset {
  id: 'morningBrief' | 'weekdayWrap' | 'weeklyDigest' | 'oneTimeReminder';
  titleKey: string;
  instructionKey: string;
  kind: RouterScheduleRule['kind'];
  time?: string;
  dayOfMonth?: number;
  days?: number[];
}

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplatePreset[] = [
  {
    id: 'morningBrief',
    titleKey: 'schedules.templates.morningBrief.title',
    instructionKey: 'schedules.templates.morningBrief.instruction',
    kind: 'daily',
    time: '08:30',
  },
  {
    id: 'weekdayWrap',
    titleKey: 'schedules.templates.weekdayWrap.title',
    instructionKey: 'schedules.templates.weekdayWrap.instruction',
    kind: 'weekdays',
    time: '18:00',
  },
  {
    id: 'weeklyDigest',
    titleKey: 'schedules.templates.weeklyDigest.title',
    instructionKey: 'schedules.templates.weeklyDigest.instruction',
    kind: 'weekly',
    time: '17:00',
    days: [5],
  },
  {
    id: 'oneTimeReminder',
    titleKey: 'schedules.templates.oneTimeReminder.title',
    instructionKey: 'schedules.templates.oneTimeReminder.instruction',
    kind: 'once',
  },
];

export function defaultScheduleTimeZone(): string {
  return appTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatOffsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(Date.now());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function buildTimezoneOptions(extraZones: readonly (string | undefined)[] = []): SelectOption[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of [...extraZones, ...COMMON_TIMEZONES]) {
    const zone = candidate?.trim();
    if (!zone || seen.has(zone)) continue;
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
      seen.add(zone);
      ordered.push(zone);
    } catch {
      // Ignore invalid timezone candidates.
    }
  }
  return ordered.map((zone) => {
    const offset = formatOffsetLabel(zone);
    return {
      value: zone,
      label: offset && offset !== zone ? `${zone} (${offset})` : zone,
    };
  });
}

export interface ZonedDateParts {
  year: string;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function datePartsInZone(at: number, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: values.year!,
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function wallTimeToEpoch(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = datePartsInZone(candidate, timeZone);
    const localAsUtc = Date.UTC(
      Number(parts.year),
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    const delta = target - localAsUtc;
    candidate += delta;
    if (delta === 0) return candidate;
  }
  const resolved = datePartsInZone(candidate, timeZone);
  if (
    Number(resolved.year) !== year ||
    resolved.month !== month ||
    resolved.day !== day ||
    resolved.hour !== hour ||
    resolved.minute !== minute
  ) {
    throw new Error('所选时区中的这个本地时间不存在（可能处于夏令时切换时段）');
  }
  return candidate;
}

function fromZonedParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): number | null {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = target + delta * 60 * MINUTE_MS;
    const local = datePartsInZone(sample, timezone);
    offsets.add(
      Date.UTC(Number(local.year), local.month - 1, local.day, local.hour, local.minute) - sample,
    );
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((epoch) => {
      const check = datePartsInZone(epoch, timezone);
      return (
        Number(check.year) === parts.year &&
        check.month === parts.month &&
        check.day === parts.day &&
        check.hour === parts.hour &&
        check.minute === parts.minute
      );
    })
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Client-side mirror of `nextScheduleAt` for live form preview. */
export function computePreviewNextRun(
  rule: RouterScheduleRule,
  timezone: string,
  after = Date.now(),
): number | null {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  } catch {
    return null;
  }

  if (rule.kind === 'once') {
    return Number.isSafeInteger(rule.at) && rule.at > after ? rule.at : null;
  }
  if (!TIME_PATTERN.test(rule.time)) return null;
  if (rule.kind === 'weekly' && rule.daysOfWeek.length === 0) return null;
  if (rule.kind === 'monthly' && (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31)) {
    return null;
  }

  const current = datePartsInZone(after, timezone);
  const startDay = Date.UTC(Number(current.year), current.month - 1, current.day);
  const [hour = 0, minute = 0] = rule.time.split(':').map(Number);

  for (let offset = 0; offset <= 400; offset += 1) {
    const date = new Date(startDay + offset * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay() || 7;
    if (rule.kind === 'weekdays' && weekday > 5) continue;
    if (rule.kind === 'weekly' && !rule.daysOfWeek.includes(weekday)) continue;
    if (rule.kind === 'monthly' && day !== Math.min(rule.dayOfMonth, daysInMonth(year, month))) continue;

    const candidate = fromZonedParts({ year, month, day, hour, minute }, timezone);
    if (candidate !== null && candidate > after) return candidate;
  }
  return null;
}

export function defaultOnceDateAndTime(
  timeZone: string,
  nowMs = Date.now(),
): { date: string; time: string } {
  const future = datePartsInZone(nowMs + 60 * MINUTE_MS, timeZone);
  const minute = future.minute >= 30 ? 30 : 0;
  return {
    date: `${future.year}-${String(future.month).padStart(2, '0')}-${String(future.day).padStart(2, '0')}`,
    time: `${String(future.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export function offsetDateInput(
  timeZone: string,
  dayOffset: number,
  nowMs = Date.now(),
): string {
  const today = datePartsInZone(nowMs, timeZone);
  const target = new Date(Date.UTC(Number(today.year), today.month - 1, today.day) + dayOffset * DAY_MS);
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatRelativeCountdown(
  targetMs: number,
  nowMs: number,
  locale: string,
): string {
  const isZh = locale.startsWith('zh');
  const diff = Math.max(0, targetMs - nowMs);
  if (diff < MINUTE_MS) return isZh ? '即将执行' : 'Due soon';

  const totalMinutes = Math.floor(diff / MINUTE_MS);
  if (totalMinutes < 60) {
    return isZh ? `${totalMinutes} 分钟后` : `in ${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    if (isZh) {
      return remMinutes > 0
        ? `${totalHours} 小时 ${remMinutes} 分钟后`
        : `${totalHours} 小时后`;
    }
    return remMinutes > 0 ? `in ${totalHours}h ${remMinutes}m` : `in ${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (isZh) {
    return remHours > 0 ? `${days} 天 ${remHours} 小时后` : `${days} 天后`;
  }
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

export function formatScheduleDateTime(
  at: number,
  timeZone: string,
  locale: string,
  nowMs = Date.now(),
): string {
  const isZh = locale.startsWith('zh');
  const target = datePartsInZone(at, timeZone);
  const today = datePartsInZone(nowMs, timeZone);
  const todayKey = `${today.year}-${today.month}-${today.day}`;
  const targetKey = `${target.year}-${target.month}-${target.day}`;

  const tomorrowDate = new Date(
    Date.UTC(Number(today.year), today.month - 1, today.day) + DAY_MS,
  );
  const tomorrowKey = `${tomorrowDate.getUTCFullYear()}-${tomorrowDate.getUTCMonth() + 1}-${tomorrowDate.getUTCDate()}`;
  const hhmm = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`;

  if (targetKey === todayKey) return `${isZh ? '今天' : 'Today'} ${hhmm}`;
  if (targetKey === tomorrowKey) return `${isZh ? '明天' : 'Tomorrow'} ${hhmm}`;

  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}
