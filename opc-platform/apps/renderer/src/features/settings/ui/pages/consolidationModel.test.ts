import { describe, expect, it } from 'vitest';
import type { MemoryReflectionRunView } from '@opc/shared/ipc';
import {
  classifyRunOutcome,
  filterRuns,
  formatRelativeAge,
  groupRunsByDay,
  summarizeRuns,
} from './consolidationModel';

function makeRun(
  overrides: Partial<MemoryReflectionRunView> & Pick<MemoryReflectionRunView, 'id' | 'startedAt'>,
): MemoryReflectionRunView {
  return {
    trigger: 'conversation',
    finishedAt: overrides.startedAt + 1200,
    status: 'done',
    summary: '已检查增量上下文',
    changedFiles: [],
    ...overrides,
  };
}

describe('consolidationModel', () => {
  const sampleRuns: MemoryReflectionRunView[] = [
    makeRun({
      id: 'r1',
      trigger: 'signal',
      startedAt: Date.UTC(2026, 10, 26, 3, 10),
      status: 'done',
      changedFiles: ['USER.md', 'PLAYBOOK.md'],
      summary: '更新了 USER.md、PLAYBOOK.md',
    }),
    makeRun({
      id: 'r2',
      trigger: 'conversation',
      startedAt: Date.UTC(2026, 10, 26, 1, 5),
      status: 'done',
      changedFiles: [],
    }),
    makeRun({
      id: 'r3',
      trigger: 'manual',
      startedAt: Date.UTC(2026, 10, 25, 14, 0),
      status: 'skipped',
      summary: '未配置默认模型',
    }),
    makeRun({
      id: 'r4',
      trigger: 'compact',
      startedAt: Date.UTC(2026, 10, 22, 9, 30),
      status: 'failed',
      summary: '记忆整理调用失败',
      error: '401 Unauthorized',
    }),
  ];

  it('classifies outcomes and summarizes stats accurately', () => {
    expect(sampleRuns.map(classifyRunOutcome)).toEqual(['updated', 'noop', 'skipped', 'failed']);
    expect(summarizeRuns(sampleRuns)).toEqual({
      total: 4,
      updated: 1,
      noop: 1,
      skipped: 1,
      failed: 1,
      touchedFilesCount: 2,
    });
  });

  it('filters runs by outcome and trigger independently', () => {
    expect(filterRuns(sampleRuns, 'updated', 'all').map((r) => r.id)).toEqual(['r1']);
    expect(filterRuns(sampleRuns, 'all', 'manual').map((r) => r.id)).toEqual(['r3']);
    expect(filterRuns(sampleRuns, 'failed', 'signal')).toEqual([]);
  });

  it('groups runs by local day with today, yesterday, and formatted older dates', () => {
    const now = Date.UTC(2026, 10, 26, 5, 0);
    const groups = groupRunsByDay(
      sampleRuns,
      now,
      {
        today: '今天',
        yesterday: '昨天',
        formatOtherDay: (ts) => new Date(ts).toISOString().slice(0, 10),
      },
      'UTC',
    );
    expect(groups.map((g) => [g.label, g.runs.map((r) => r.id)])).toEqual([
      ['今天', ['r1', 'r2']],
      ['昨天', ['r3']],
      ['2026-11-22', ['r4']],
    ]);
  });

  it('formats relative ages across seconds, minutes, hours, and days', () => {
    const now = 10_000_000;
    const labels = {
      justNow: '刚刚',
      minutesAgo: (c: number) => `${c}分钟前`,
      hoursAgo: (c: number) => `${c}小时前`,
      daysAgo: (c: number) => `${c}天前`,
    };
    expect(formatRelativeAge(now - 20_000, now, labels)).toBe('刚刚');
    expect(formatRelativeAge(now - 12 * 60_000, now, labels)).toBe('12分钟前');
    expect(formatRelativeAge(now - 3 * 3600_000, now, labels)).toBe('3小时前');
    expect(formatRelativeAge(now - 2 * 86_400_000, now, labels)).toBe('2天前');
  });
});
