import type { WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, inspectTask, Watchdog } from './watchdog';

/**
 * 进展监督。
 *
 * 它判的是「还在不在往前走」，不是「做得对不对」——所以这里的每个用例都在
 * 描述一种「看着在干活、其实没动」的形状。
 */
const NOW = 1_800_000_000_000;

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 't1',
    title: '整理财报',
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
    status: 'running',
    workspaceRelPath: 'w',
    createdAt: NOW - 5 * 60_000,
    updatedAt: NOW - 60_000,
    steps: [],
    artifacts: [],
    tokensUsed: 0,
    costUsd: 0,
    ...overrides,
  } as unknown as WorkTask;
}

describe('inspectTask', () => {
  it('says nothing about healthy work', () => {
    expect(inspectTask(task(), NOW).kind).toBe('ok');
  });

  it('catches the most common shape of spinning: the same step over and over', () => {
    const steps = Array.from({ length: 6 }, (_, index) => ({
      at: NOW - (6 - index) * 1000,
      text: '重试 node --test',
    }));
    const verdict = inspectTask(task({ steps }), NOW);
    expect(verdict.kind).toBe('spinning');
    expect(verdict.kind === 'spinning' && verdict.reason).toContain('重试 node --test');
  });

  it('does not cry spinning over a step that merely repeats twice', () => {
    const steps = [
      { at: NOW - 3000, text: '读取任务' },
      { at: NOW - 2000, text: '读取任务' },
      { at: NOW - 1000, text: '写入 server.js' },
    ];
    expect(inspectTask(task({ steps }), NOW).kind).toBe('ok');
  });

  it('only looks at the recent window, not the whole history', () => {
    // Four repeats sit outside the window once the fresh steps push them out.
    const old = Array.from({ length: 4 }, () => ({ at: NOW - 500_000, text: '旧步骤' }));
    const fresh = Array.from({ length: 12 }, (_, index) => ({ at: NOW - index * 100, text: `新步骤 ${index}` }));
    expect(inspectTask(task({ steps: [...old, ...fresh] }), NOW).kind).toBe('ok');
  });

  it('calls a run with no new step in half an hour stalled', () => {
    const verdict = inspectTask(task({ updatedAt: NOW - DEFAULT_THRESHOLDS.stalledMs }), NOW);
    expect(verdict.kind).toBe('stalled');
    expect(verdict.kind === 'stalled' && verdict.reason).toContain('没有任何新进展');
  });

  it('calls work that never started orphaned, and says why it might be', () => {
    const verdict = inspectTask(
      task({ status: 'open', createdAt: NOW - DEFAULT_THRESHOLDS.orphanMs, updatedAt: NOW - DEFAULT_THRESHOLDS.orphanMs }),
      NOW,
    );
    expect(verdict.kind).toBe('orphaned');
  });

  it('ignores tasks that are already finished', () => {
    expect(inspectTask(task({ status: 'accepted', updatedAt: NOW - 10 * 60 * 60_000 }), NOW).kind).toBe('ok');
  });
});

describe('Watchdog.sweep', () => {
  function watchdog(pending: WorkTask[], overrides: { withThread?: boolean } = {}) {
    const reports: { threadId: string; body: string }[] = [];
    const states: { threadId: string; state: string }[] = [];
    const loop = new Watchdog({
      threads: {
        addReport: (input: { threadId: string; body?: string }) => {
          reports.push({ threadId: input.threadId, body: input.body ?? '' });
          return {} as never;
        },
        setState: (threadId: string, state: string) => {
          states.push({ threadId, state });
          return {} as never;
        },
      } as never,
      pending: () => pending,
      now: () => NOW,
    });
    return { loop, reports, states, withThread: overrides.withThread };
  }

  it('speaks up once per task per problem, not once per tick', () => {
    const stuck = task({ threadId: 'th-1', updatedAt: NOW - 40 * 60_000 });
    const { loop, reports, states } = watchdog([stuck]);

    expect(loop.sweep()).toBe(1);
    expect(loop.sweep()).toBe(0);
    expect(reports).toHaveLength(1);
    expect(states).toEqual([{ threadId: 'th-1', state: 'waiting' }]);
  });

  it('stays quiet when everything is moving', () => {
    const { loop, reports } = watchdog([task({ threadId: 'th-1' })]);
    expect(loop.sweep()).toBe(0);
    expect(reports).toHaveLength(0);
  });

  it('reports on the line of work, not the task', () => {
    const { loop, reports } = watchdog([task({ threadId: 'th-9', updatedAt: NOW - 40 * 60_000 })]);
    loop.sweep();
    expect(reports[0]?.threadId).toBe('th-9');
  });
});
