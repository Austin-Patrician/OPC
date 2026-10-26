import { describe, expect, it } from 'vitest';
import type { WorkTask } from '@opc/shared/domain';
import { isOverdue, sortIssues } from './issueSort';

const task = (over: Partial<WorkTask>): WorkTask =>
  ({
    id: over.id ?? 't',
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
    status: 'open',
    workspaceRelPath: '',
    createdAt: 0,
    updatedAt: 0,
    artifacts: [],
    attempts: 0,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...over,
  }) as WorkTask;

describe('issue sorting', () => {
  it('orders by priority, then newest', () => {
    const rows = sortIssues(
      [
        task({ id: 'p3', priority: 'P3', createdAt: 3 }),
        task({ id: 'p0', priority: 'P0', createdAt: 1 }),
        task({ id: 'p1', priority: 'P1', createdAt: 2 }),
      ],
      'priority',
    );
    expect(rows.map((row) => row.id)).toEqual(['p0', 'p1', 'p3']);
  });

  it('puts tasks without a due date last', () => {
    const rows = sortIssues(
      [
        task({ id: 'none', priority: 'P2' }),
        task({ id: 'late', priority: 'P2', dueAt: 2_000 }),
        task({ id: 'soon', priority: 'P2', dueAt: 1_000 }),
      ],
      'due',
    );
    expect(rows.map((row) => row.id)).toEqual(['soon', 'late', 'none']);
  });

  it('sorts by spend when asked', () => {
    const rows = sortIssues(
      [task({ id: 'cheap', costUsd: 0.01 }), task({ id: 'dear', costUsd: 1.2 })],
      'cost',
    );
    expect(rows[0]?.id).toBe('dear');
  });
});

describe('overdue', () => {
  const now = Date.UTC(2026, 0, 10);
  it('flags past-due unfinished work', () => {
    expect(isOverdue(task({ dueAt: now - 1 }), now)).toBe(true);
    expect(isOverdue(task({ dueAt: now + 1 }), now)).toBe(false);
  });

  it('never flags delivered or accepted work', () => {
    expect(isOverdue(task({ dueAt: now - 1, status: 'delivered' }), now)).toBe(false);
    expect(isOverdue(task({ dueAt: now - 1, status: 'accepted' }), now)).toBe(false);
  });
});
