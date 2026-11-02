import type { WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { threadOutcomeFor } from './threadOutcome';

/**
 * The mapping that decides whether the boss hears about a finished task.
 *
 * This is the product promise in one function: finishing quietly is the default,
 * and everything that interrupts has a reason written next to it.
 */
function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 't1',
    title: '整理 Q3 财报',
    brief: 'b',
    deliverableSpec: 'd',
    assigneeId: 'emp-1',
    assigneeName: '李雷',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 1000,
    acceptanceCommand: [],
    status: 'accepted',
    workspaceRelPath: 'w',
    threadId: 'th-1',
    createdAt: 0,
    updatedAt: 0,
    artifacts: [],
    steps: [],
    tokensUsed: 0,
    costUsd: 0,
    ...overrides,
  } as unknown as WorkTask;
}

describe('threadOutcomeFor', () => {
  it('closes the line of work quietly when the task passed acceptance', () => {
    const outcome = threadOutcomeFor(task({ status: 'accepted' }));
    expect(outcome?.state).toBe('done');
    expect(outcome?.report?.level).toBe('silent');
  });

  it('asks the boss when the work only needs a look', () => {
    const outcome = threadOutcomeFor(task({ status: 'delivered' }));
    expect(outcome?.state).toBe('waiting');
    expect(outcome?.report?.level).toBe('decide');
  });

  it('carries the acceptance reason instead of a vague failure', () => {
    const outcome = threadOutcomeFor(
      task({
        status: 'rejected',
        acceptance: { verdict: 'fail', reason: '退出码 1（90ms）' } as never,
      }),
    );
    expect(outcome?.report?.body).toContain('退出码 1');
  });

  it('says nothing while a manager is still signing off', () => {
    const outcome = threadOutcomeFor(task({ status: 'review' }));
    // The line waits, but the boss is not interrupted once per review round.
    expect(outcome?.state).toBe('waiting');
    expect(outcome?.report).toBeNull();
  });

  it('reports artifacts by name when it does speak', () => {
    const outcome = threadOutcomeFor(
      task({ status: 'accepted', artifacts: [{ relPath: 'summary.md' } as never] }),
    );
    expect(outcome?.report?.body).toContain('summary.md');
  });

  it('ignores tasks that belong to no line of work', () => {
    expect(threadOutcomeFor(task({ threadId: undefined }))).toBeNull();
  });

  it('ignores a task that has not finished', () => {
    expect(threadOutcomeFor(task({ status: 'running' }))).toBeNull();
  });

  it('archives a cancelled task without interrupting anyone', () => {
    const outcome = threadOutcomeFor(task({ status: 'cancelled' }));
    expect(outcome?.state).toBe('archived');
    expect(outcome?.report).toBeNull();
  });
});
