import type { SubtaskDraft, WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECOMPOSE_LIMITS, validateDecomposition, type DecomposeContext } from './decomposition';

/**
 * 拆解的硬约束。
 *
 * 这些规则刻意写在代码里而不是提示词里：一个把任务拆成 20 份、或拆到第 10 层的
 * 模型，需要拿到一条结构化的拒绝，而不是"再试一次"。
 *
 * v2 之后，「谁能接活」不再看汇报线——公司里除了自己都可以。所以这里剩下的是
 * 深度、扇出、预算，以及"别把活派回给自己"。
 */
function parent(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'task-parent',
    title: '整理年报',
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
    estTokens: 10_000,
    acceptanceCommand: [],
    status: 'running',
    workspaceRelPath: 'w',
    createdAt: 0,
    updatedAt: 0,
    tokensUsed: 0,
    costUsd: 0,
    artifacts: [],
    steps: [],
    ...overrides,
  } as unknown as WorkTask;
}

function sub(assigneeId: string, estTokens = 1_000): SubtaskDraft {
  return {
    title: '子任务',
    brief: 'b',
    deliverableSpec: 'd',
    assigneeId,
    estTokens,
    acceptanceTemplate: 'http-ok',
  } as SubtaskDraft;
}

function ctx(overrides: Partial<DecomposeContext> = {}): DecomposeContext {
  return {
    parent: parent(),
    requesterId: 'emp-1',
    subtasks: [sub('emp-2')],
    assignable: [{ id: 'emp-2' }, { id: 'emp-3' }],
    parentRemainingTokens: 10_000,
    ...overrides,
  };
}

describe('validateDecomposition', () => {
  it('accepts a reasonable split among peers', () => {
    expect(validateDecomposition(ctx())).toBeNull();
  });

  it('refuses an empty split', () => {
    expect(validateDecomposition(ctx({ subtasks: [] }))?.code).toBe('DECOMPOSE_EMPTY');
  });

  it('refuses to go deeper than the limit', () => {
    const deep = parent({ depth: DEFAULT_DECOMPOSE_LIMITS.maxDepth - 1 });
    expect(validateDecomposition(ctx({ parent: deep }))?.code).toBe('DECOMPOSE_DEPTH');
  });

  it('refuses more children than one task may fan out to', () => {
    const many = Array.from({ length: DEFAULT_DECOMPOSE_LIMITS.maxFanout + 1 }, () => sub('emp-2'));
    expect(validateDecomposition(ctx({ subtasks: many }))?.code).toBe('DECOMPOSE_FANOUT');
  });

  it('refuses a split that costs more than what is left', () => {
    expect(
      validateDecomposition(ctx({ subtasks: [sub('emp-2', 9_000)], parentRemainingTokens: 1_000 }))
        ?.code,
    ).toBe('DECOMPOSE_BUDGET');
  });

  it('refuses handing a subtask back to the requester', () => {
    expect(validateDecomposition(ctx({ subtasks: [sub('emp-1')] }))?.code).toBe('DECOMPOSE_SELF');
  });

  it('refuses an assignee who does not exist in the company', () => {
    expect(validateDecomposition(ctx({ subtasks: [sub('ghost')] }))?.code).toBe(
      'DECOMPOSE_NOT_ASSIGNABLE',
    );
  });

  it('lets a peer take work without a reporting line', () => {
    // v2: no managers, so a colleague is as valid an assignee as a report was.
    expect(validateDecomposition(ctx({ subtasks: [sub('emp-3')] }))).toBeNull();
  });
});
