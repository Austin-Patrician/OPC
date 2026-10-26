import { describe, expect, it } from 'vitest';
import type { WorkTask } from '@opc/shared/domain';
import { buildBurndown, summariseByPerson } from './issueBurndown';

const DAY = 86_400_000;
const now = new Date(2026, 0, 10, 12).getTime();
const task = (over: Partial<WorkTask>): WorkTask =>
  ({
    id: `t-${Math.random()}`,
    title: 't',
    brief: '',
    deliverableSpec: '',
    assigneeId: 'a',
    assigneeName: 'A',
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 0,
    acceptanceCommand: [],
    acceptanceTemplate: 'http-ok',
    status: 'running',
    workspaceRelPath: '',
    createdAt: now - 3 * DAY,
    updatedAt: now,
    artifacts: [],
    attempts: 0,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    priority: 'P2',
    labels: [],
    blockedBy: [],
    ...over,
  }) as WorkTask;

describe('burndown', () => {
  it('ends at zero remaining when everything finished', () => {
    const points = buildBurndown(
      [task({ createdAt: now - 5 * DAY, finishedAt: now - DAY, status: 'delivered' })],
      7,
      now,
    );
    expect(points).toHaveLength(7);
    expect(points[points.length - 1]!.remaining).toBe(0);
  });

  it('counts unfinished work as remaining and draws the ideal line down', () => {
    const points = buildBurndown([task({ createdAt: now - 6 * DAY })], 7, now);
    expect(points[0]!.remaining).toBe(1);
    expect(points[points.length - 1]!.remaining).toBe(1);
    expect(points[0]!.ideal).toBe(1);
    expect(points[points.length - 1]!.ideal).toBe(0);
  });

  it('stays at zero for an empty ledger', () => {
    expect(buildBurndown([], 5, now).every((point) => point.remaining === 0 && point.ideal === 0)).toBe(true);
  });
});

describe('per-person summary', () => {
  it('groups by assignee and averages lead time over finished work', () => {
    const rows = summariseByPerson([
      task({ assigneeName: '李雷', status: 'delivered', createdAt: now - 2 * DAY, finishedAt: now, costUsd: 0.2 }),
      task({ assigneeName: '李雷', status: 'running', costUsd: 0.1 }),
      task({ assigneeName: '韩梅梅', status: 'failed', costUsd: 0.05 }),
    ]);
    const li = rows.find((row) => row.assignee === '李雷')!;
    expect(li.total).toBe(2);
    expect(li.done).toBe(1);
    expect(li.doing).toBe(1);
    expect(li.avgLeadHours).toBeCloseTo(48, 1);
    expect(rows.find((row) => row.assignee === '韩梅梅')!.stuck).toBe(1);
    expect(rows[0]!.assignee).toBe('李雷');
  });
});
