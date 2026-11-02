import type { CreateTaskResult, WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import type { DispatchInput } from './router';
import { createWorkDispatch } from './workDispatch';

/**
 * The seam between the router and the task pipeline.
 *
 * The mapping back to the boss is the product decision under test: work that is
 * verified closes quietly, work that cannot be verified asks instead of pretending.
 */
const thread = { id: 'th-1', title: '整理这份财报', goal: '输出一页摘要' } as never;
const event = { id: 'ev-1', kind: 'folder.added', payload: { file: 'a.pdf' } } as never;

function input(): DispatchInput {
  return { thread, event };
}

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'task-1',
    title: '整理这份财报',
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
    acceptanceCommand: ['node', '{checks}/verify.mjs'],
    status: 'accepted',
    workspaceRelPath: 'w',
    createdAt: 0,
    updatedAt: 0,
    artifacts: [],
    steps: [],
    tokensUsed: 0,
    costUsd: 0,
    ...overrides,
  } as unknown as WorkTask;
}

function dispatch(overrides: {
  assignee?: string | null;
  create?: () => CreateTaskResult;
  run?: () => Promise<WorkTask>;
}) {
  const calls: unknown[] = [];
  const fn = createWorkDispatch({
    resolveAssignee: () => (overrides.assignee === undefined ? 'emp-1' : overrides.assignee),
    createTask: (input) => {
      calls.push(input);
      return overrides.create?.() ?? { ok: true, task: task() };
    },
    runTaskAndWait: overrides.run ?? (async () => task()),
  });
  return { fn, calls };
}

describe('createWorkDispatch', () => {
  it('closes quietly when the work passed its own acceptance', async () => {
    const gated = {
      id: 'ev-0',
      kind: 'folder.added',
      payload: { acceptanceCommand: ['node', 'check.js'] },
    } as never;
    const { fn } = dispatch({
      run: async () =>
        task({ status: 'accepted', artifacts: [{ id: 'a', relPath: 'summary.md' } as never] }),
    });
    const outcome = await fn({ thread, event: gated });
    expect(outcome).toEqual({ status: 'delivered', summary: '产出：summary.md' });
  });

  it('treats a boss-approved task as delivered, not as a question', async () => {
    const { fn } = dispatch({ run: async () => task({ status: 'delivered' }) });
    const outcome = await fn(input());
    expect(outcome.status).toBe('delivered');
  });

  it('reports the acceptance reason instead of a fake pass', async () => {
    const { fn } = dispatch({
      run: async () =>
        task({
          status: 'rejected',
          acceptance: {
            verdict: 'fail',
            reason: '退出码 1（120ms）',
            evidence: { command: ['node'], exitCode: 1, stdoutTail: '', stderrTail: '', durationMs: 120 },
            createdAt: 0,
          } as never,
        }),
    });
    const outcome = await fn(input());
    expect(outcome).toEqual({ status: 'needs-decision', question: '自动验收没过：退出码 1（120ms）' });
  });

  it('carries a hard failure through with its reason', async () => {
    const { fn } = dispatch({ run: async () => task({ status: 'failed', error: '模型超时' }) });
    const outcome = await fn(input());
    expect(outcome).toEqual({ status: 'failed', reason: '模型超时' });
  });

  it('turns a budget refusal into a decision, not a crash', async () => {
    const { fn } = dispatch({
      create: () =>
        ({
          ok: false,
          error: { code: 'BUDGET_BLOCKED', message: '本月额度已用完' },
        }) as unknown as CreateTaskResult,
    });
    const outcome = await fn(input());
    expect(outcome).toEqual({ status: 'needs-decision', question: '本月额度已用完' });
  });

  it('fails loudly when there is nobody to do the work', async () => {
    const { fn } = dispatch({ assignee: null });
    const outcome = await fn(input());
    expect(outcome.status).toBe('failed');
  });

  it('puts the task on the thread, so the work line owns it', async () => {
    const { fn, calls } = dispatch({});
    await fn(input());
    expect(calls[0]).toMatchObject({ threadId: 'th-1', assigneeId: 'emp-1' });
  });

  it('lets the event carry its own acceptance instead of guessing', async () => {
    const custom = {
      id: 'ev-2',
      kind: 'folder.added',
      payload: {
        acceptanceCommand: ['node', 'check.js'],
        acceptanceTemplate: 'node-test',
        estTokens: 5000,
      },
    } as never;
    const { fn, calls } = dispatch({});
    await fn({ thread, event: custom });
    expect(calls[0]).toMatchObject({
      acceptanceCommand: ['node', 'check.js'],
      acceptanceTemplate: 'node-test',
      estTokens: 5000,
    });
  });

  it('does not invent an acceptance gate for an open-ended goal', async () => {
    const { fn, calls } = dispatch({});
    await fn(input());
    // The pipeline's "did anything land" check still runs; that is all it claims.
    expect(calls[0]).toMatchObject({ acceptanceCommand: ['node', '-e', 'process.exit(0)'] });
  });

  it('asks the boss instead of claiming a pass it cannot prove', async () => {
    // No acceptance command in the event → "accepted" only means files landed.
    const { fn } = dispatch({ run: async () => task({ status: 'accepted' }) });
    const outcome = await fn(input());
    expect(outcome.status).toBe('needs-decision');
    expect(outcome.status === 'needs-decision' && outcome.question).toContain('判定不了对错');
  });

  it('closes quietly only when the event brought a real gate and it passed', async () => {
    const gated = {
      id: 'ev-3',
      kind: 'folder.added',
      payload: { acceptanceCommand: ['node', 'check.js'] },
    } as never;
    const { fn } = dispatch({ run: async () => task({ status: 'accepted' }) });
    const outcome = await fn({ thread, event: gated });
    expect(outcome.status).toBe('delivered');
  });
});
