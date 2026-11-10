import type { RouterScheduleRule } from '@opc/shared/domain';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateScheduleRule(rule: RouterScheduleRule): void {
  if (!rule || typeof rule !== 'object') throw new Error('计划规则无效');
  if (rule.kind === 'once') {
    if (!Number.isSafeInteger(rule.at) || rule.at <= 0) throw new Error('单次计划时间无效');
    return;
  }
  if (!TIME_PATTERN.test(rule.time)) throw new Error('计划时间必须使用 HH:mm 格式');
  if (rule.kind === 'weekly') {
    if (!Array.isArray(rule.daysOfWeek) || rule.daysOfWeek.length === 0 ||
        rule.daysOfWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error('每周计划必须选择星期一到星期日中的至少一天');
    }
  }
  if (rule.kind === 'monthly' && (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31)) {
    throw new Error('每月计划日期必须在 1 到 31 之间');
  }
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(rule.kind)) throw new Error('暂不支持此重复规则');
}

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`无效的时区：${timezone}`);
  }
}

export function nextScheduleAt(
  rule: RouterScheduleRule,
  after: number,
  timezone: string,
): number | null {
  validateScheduleRule(rule);
  validateTimezone(timezone);
  if (rule.kind === 'once') return rule.at > after ? rule.at : null;

  const current = zonedParts(after, timezone);
  const startDay = Date.UTC(current.year, current.month - 1, current.day);
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

/** Returns the latest due calendar occurrence, coalescing older missed runs. */
export function latestMissedScheduleAt(
  rule: RouterScheduleRule,
  firstDueAt: number,
  now: number,
  timezone: string,
): number | null {
  if (firstDueAt > now) return null;
  if (rule.kind === 'once') return rule.at >= firstDueAt && rule.at <= now ? rule.at : null;
  validateScheduleRule(rule);
  validateTimezone(timezone);

  const current = zonedParts(now, timezone);
  const endDay = Date.UTC(current.year, current.month - 1, current.day);
  const [hour = 0, minute = 0] = rule.time.split(':').map(Number);
  for (let offset = 0; offset <= 40; offset += 1) {
    const date = new Date(endDay - offset * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay() || 7;
    if (rule.kind === 'weekdays' && weekday > 5) continue;
    if (rule.kind === 'weekly' && !rule.daysOfWeek.includes(weekday)) continue;
    if (rule.kind === 'monthly' && day !== Math.min(rule.dayOfMonth, daysInMonth(year, month))) continue;
    const candidate = fromZonedParts({ year, month, day, hour, minute }, timezone);
    if (candidate !== null && candidate >= firstDueAt && candidate <= now) return candidate;
  }
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number }

function zonedParts(at: number, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(value.year), month: Number(value.month), day: Number(value.day),
    hour: Number(value.hour), minute: Number(value.minute),
  };
}

/** Resolves a wall-clock time; nonexistent DST times are skipped, repeated times run once. */
function fromZonedParts(parts: ZonedParts, timezone: string): number | null {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = target + delta * 60 * MINUTE_MS;
    const local = zonedParts(sample, timezone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => sameParts(zonedParts(candidate, timezone), parts))
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function sameParts(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute;
}
