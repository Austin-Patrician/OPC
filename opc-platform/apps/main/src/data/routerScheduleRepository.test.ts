import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from './companyDatabase';
import { ThreadRepository } from './threadRepository';
import { RouterScheduleRepository } from './routerScheduleRepository';

let dir: string;
let db: CompanyDatabase;
let now: number;
let schedules: RouterScheduleRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-schedules-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  now = Date.parse('2026-01-01T08:00:00Z');
  schedules = new RouterScheduleRepository(db, () => now, (() => { let id = 0; return () => `id-${++id}`; })());
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('RouterScheduleRepository', () => {
  it('writes one occurrence and one Router event transactionally, then advances schedule', () => {
    const schedule = schedules.create({ title: '每日简报', instruction: '查看今天的邮件', timezone: 'UTC',
      rule: { kind: 'daily', time: '09:00' } });
    now = Date.parse('2026-01-04T10:00:00Z');
    const result = schedules.enqueueDue();
    expect(result.due).toHaveLength(1);
    expect(result.skipped).toBe(3);
    expect(schedules.get(schedule.id)?.nextRunAt).toBe(Date.parse('2026-01-05T09:00:00Z'));
    const event = new ThreadRepository(db).eventByDedupeKey(`schedule:${schedule.id}:${Date.parse('2026-01-04T09:00:00Z')}`);
    expect(event?.kind).toBe('schedule.due');
    expect(event?.payload.instruction).toBe('查看今天的邮件');
    expect(schedules.occurrences(schedule.id)).toHaveLength(1);
    expect(schedules.enqueueDue().due).toHaveLength(0);
  });

  it('marks one-time schedules completed and does not duplicate after another tick', () => {
    const runAt = now + 60_000;
    const schedule = schedules.create({ title: '提醒', instruction: '检查发布状态', timezone: 'UTC', rule: { kind: 'once', at: runAt } });
    now = runAt + 1;
    expect(schedules.enqueueDue().due).toHaveLength(1);
    expect(schedules.get(schedule.id)?.status).toBe('completed');
    expect(schedules.enqueueDue().due).toHaveLength(0);
  });

  it('pauses and resumes, rejects invalid timezone, and does not reactivate cancelled plans', () => {
    const schedule = schedules.create({ title: '检查', instruction: '检查', rule: { kind: 'daily', time: '09:00' } });
    expect(() => schedules.update(schedule.id, { timezone: 'not/a-zone' })).toThrow('无效的时区');
    expect(schedules.update(schedule.id, { status: 'paused' }).nextRunAt).toBeNull();
    expect(schedules.update(schedule.id, { status: 'active' }).nextRunAt).not.toBeNull();
    schedules.cancel(schedule.id);
    expect(() => schedules.update(schedule.id, { status: 'active' })).toThrow('已结束的计划');
  });
});
