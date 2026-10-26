import { describe, expect, it } from 'vitest';
import type { WorkTask } from '@opc/shared/domain';
import { buildTimeline, spendByDay } from './issueTimeline';

const base = (over: Partial<WorkTask>): WorkTask =>
  ({
    id: 't',
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
    createdAt: 0,
    updatedAt: 0,
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

describe('timeline geometry', () => {
  const now = Date.UTC(2026, 0, 10, 12);
  it('spans from the earliest start to the latest finish', () => {
    const { from, to } = buildTimeline(
      [base({ id: 'a', createdAt: now - 3_600_000, finishedAt: now - 1_800_000 })],
      now,
    );
    expect(from).toBe(now - 3_600_000);
    expect(to).toBe(now);
  });

  it('leaves unfinished work open-ended at now', () => {
    const { bars } = buildTimeline([base({ createdAt: now - 7_200_000, status: 'running' })], now);
    expect(bars[0]!.open).toBe(true);
    expect(bars[0]!.end).toBeCloseTo(1, 5);
  });

  it('nests a finished bar inside the window', () => {
    const { bars } = buildTimeline(
      [
        base({ id: 'outer', createdAt: now - 10_000, finishedAt: now }),
        base({ id: 'inner', createdAt: now - 5_000, finishedAt: now - 2_000 }),
      ],
      now,
    );
    const inner = bars.find((bar) => bar.task.id === 'inner')!;
    expect(inner.start).toBeGreaterThan(0);
    expect(inner.end).toBeLessThan(1);
  });
});

describe('spend per day', () => {
  const now = Date.UTC(2026, 0, 10, 12);
  it('sums real cost into day buckets', () => {
    const rows = spendByDay(
      [
        base({ id: 'a', costUsd: 0.5, finishedAt: now }),
        base({ id: 'b', costUsd: 0.25, finishedAt: now }),
      ],
      2,
      now,
    );
    expect(rows).toHaveLength(2);
    expect(rows[rows.length - 1]!.usd).toBeCloseTo(0.75, 5);
  });
});
