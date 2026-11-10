import { describe, expect, it } from 'vitest';
import { latestMissedScheduleAt, nextScheduleAt } from './scheduleRule';

describe('Router schedule calendar rules', () => {
  it('calculates the next weekday in the selected timezone', () => {
    const after = Date.parse('2026-11-06T08:00:00Z'); // Friday, 16:00 in Shanghai
    expect(nextScheduleAt({ kind: 'weekdays', time: '09:30' }, after, 'Asia/Shanghai'))
      .toBe(Date.parse('2026-11-09T01:30:00Z'));
  });

  it('clamps a monthly day to the last day of shorter months', () => {
    const after = Date.parse('2026-02-01T00:00:00Z');
    expect(nextScheduleAt({ kind: 'monthly', dayOfMonth: 31, time: '12:00' }, after, 'UTC'))
      .toBe(Date.parse('2026-02-28T12:00:00Z'));
  });

  it('coalesces long-offline recurring schedules to the latest due occurrence', () => {
    const first = Date.parse('2026-01-01T09:00:00Z');
    const now = Date.parse('2026-01-05T15:00:00Z');
    expect(latestMissedScheduleAt({ kind: 'daily', time: '09:00' }, first, now, 'UTC'))
      .toBe(Date.parse('2026-01-05T09:00:00Z'));
  });

  it('skips a nonexistent spring-forward wall time', () => {
    const after = Date.parse('2026-03-07T12:00:00Z');
    expect(nextScheduleAt({ kind: 'daily', time: '02:30' }, after, 'America/New_York'))
      .toBe(Date.parse('2026-03-09T06:30:00Z'));
  });
});
