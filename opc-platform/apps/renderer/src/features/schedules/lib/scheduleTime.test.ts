import { describe, expect, it } from 'vitest';
import {
  buildTimezoneOptions,
  computePreviewNextRun,
  defaultOnceDateAndTime,
  formatRelativeCountdown,
  formatScheduleDateTime,
  wallTimeToEpoch,
} from './scheduleTime';

describe('scheduleTime helpers', () => {
  it('converts wall clock time cleanly across timezones', () => {
    const epoch = wallTimeToEpoch('2026-12-01', '09:30', 'Asia/Shanghai');
    expect(new Date(epoch).toISOString()).toBe('2026-12-01T01:30:00.000Z');
  });

  it('computes preview next run for once, daily, weekdays, weekly, and monthly clamping', () => {
    // 2026-01-31 10:00 UTC (Saturday)
    const now = Date.UTC(2026, 0, 31, 10, 0);

    expect(computePreviewNextRun({ kind: 'once', at: now - 1000 }, 'UTC', now)).toBeNull();
    expect(computePreviewNextRun({ kind: 'once', at: now + 60_000 }, 'UTC', now)).toBe(
      now + 60_000,
    );

    expect(computePreviewNextRun({ kind: 'daily', time: '09:00' }, 'UTC', now)).toBe(
      Date.UTC(2026, 1, 1, 9, 0),
    );
    expect(computePreviewNextRun({ kind: 'weekdays', time: '09:00' }, 'UTC', now)).toBe(
      Date.UTC(2026, 1, 2, 9, 0),
    );
    expect(
      computePreviewNextRun({ kind: 'weekly', time: '17:00', daysOfWeek: [5] }, 'UTC', now),
    ).toBe(Date.UTC(2026, 1, 6, 17, 0));

    // Feb 2026 has 28 days, so dayOfMonth=31 clamps cleanly to Feb 28.
    expect(
      computePreviewNextRun({ kind: 'monthly', time: '08:00', dayOfMonth: 31 }, 'UTC', now),
    ).toBe(Date.UTC(2026, 1, 28, 8, 0));
  });

  it('formats relative countdowns and today/tomorrow timestamps concisely', () => {
    const base = Date.UTC(2026, 5, 10, 8, 0);
    expect(formatRelativeCountdown(base + 30_000, base, 'zh-CN')).toBe('即将执行');
    expect(formatRelativeCountdown(base + 30_000, base, 'en-US')).toBe('Due soon');
    expect(formatRelativeCountdown(base + 15 * 60_000, base, 'zh-CN')).toBe('15 分钟后');
    expect(formatRelativeCountdown(base + 95 * 60_000, base, 'en-US')).toBe('in 1h 35m');
    expect(formatRelativeCountdown(base + 27 * 3_600_000, base, 'zh-CN')).toBe('1 天 3 小时后');

    expect(formatScheduleDateTime(base + 2 * 3_600_000, 'UTC', 'zh-CN', base)).toBe('今天 10:00');
    expect(formatScheduleDateTime(base + 24 * 3_600_000, 'UTC', 'en-US', base)).toBe(
      'Tomorrow 08:00',
    );
  });

  it('builds deduplicated timezone options including custom zone and yields future default once time', () => {
    const options = buildTimezoneOptions(['Pacific/Auckland', 'Asia/Shanghai', 'invalid-zone']);
    expect(options.some((opt) => opt.value === 'Pacific/Auckland')).toBe(true);
    expect(options.filter((opt) => opt.value === 'Asia/Shanghai')).toHaveLength(1);
    expect(options.some((opt) => opt.value === 'invalid-zone')).toBe(false);

    const now = Date.UTC(2026, 5, 10, 10, 10);
    const once = defaultOnceDateAndTime('UTC', now);
    expect(wallTimeToEpoch(once.date, once.time, 'UTC')).toBeGreaterThan(now);
  });
});
