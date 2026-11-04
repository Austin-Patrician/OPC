import type { WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_GATE } from './acceptanceGate';
import { threadOutcomeFor } from './threadOutcome';

/**
 * The mapping that decides whether you hears about a finished task.
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

  it('stays quiet when you already signed it off', () => {
    // `delivered` is only reachable through `userDecision`: asking again would be
    // asking the same person the same question twice.
    const outcome = threadOutcomeFor(task({ status: 'delivered' }));
    expect(outcome?.state).toBe('done');
    expect(outcome?.report?.level).toBe('silent');
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

  /**
   * 分类（§3.7）在这里第一次变成人看得见的东西：同样是 `failed`，「没模型」和
   * 「运行时被打断」该做的事完全相反——一个重试一万次也不会好，一个再点一次通常就好了。
   */
  it('「起不来」和「运行中断」说的不是一回事', () => {
    const blocked = threadOutcomeFor(
      task({ status: 'failed', error: '未配置默认 LLM 模型', errorKind: 'blocked' }),
    );
    expect(blocked?.state).toBe('failed');
    expect(blocked?.report?.body).toContain('起不来');
    expect(blocked?.report?.body).toContain('不是重试能解决的');

    const retryable = threadOutcomeFor(
      task({ status: 'failed', error: 'pi 循环未完成（unanswered）', errorKind: 'retryable' }),
    );
    expect(retryable?.report?.body).toContain('运行中断');
    expect(retryable?.report?.body).toContain('再跑一次');
  });

  it('验收没过时把「所以该怎么办」也说出来', () => {
    const outcome = threadOutcomeFor(
      task({
        status: 'rejected',
        errorKind: 'rejected',
        acceptance: { verdict: 'fail', reason: '退出码 1' } as never,
      }),
    );
    expect(outcome?.report?.body).toContain('退出码 1');
    expect(outcome?.report?.body).toContain('验收条件');
  });

  it('没分类的老任务仍然说人话：缺一个字段不能让正文变空', () => {
    const outcome = threadOutcomeFor(task({ status: 'failed', error: 'boom' }));
    expect(outcome?.report?.body).toContain('boom');
    expect(outcome?.report?.level).toBe('decide');
  });

  it('says nothing while a manager is still signing off', () => {
    const outcome = threadOutcomeFor(task({ status: 'review' }));
    // The line waits, but you is not interrupted once per review round.
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

/**
 * 静默线（§3.4）：**永远不 `decide`**。
 *
 * `decide` 的意思是「我要你放下手上的事」，而投机的前提恰恰是这件事还没有确定性价值。
 * 所以判据换成闸门：过了才 notify，没过就 silent 归档——包括"没有闸门"这种情形，
 * 因为那时根本没有资格判断它值不值。
 */
describe('静默线', () => {
  const speculative = { speculative: true };

  it('闸门过了才说话：notify，不是 silent', () => {
    const outcome = threadOutcomeFor(
      task({
        acceptance: { verdict: 'pass', reason: 'ok', evidence: { exitCode: 0 } } as never,
      }),
      speculative,
    );
    expect(outcome?.state).toBe('done');
    expect(outcome?.report?.level).toBe('notify');
  });

  it('没通过就归档：记录还在，但不占他的注意力', () => {
    const outcome = threadOutcomeFor(
      task({
        status: 'rejected',
        acceptance: { verdict: 'fail', reason: '退出码 1（90ms）' } as never,
      }),
      speculative,
    );
    expect(outcome?.state).toBe('archived');
    expect(outcome?.report?.level).toBe('silent');
    expect(outcome?.report?.body).toContain('退出码 1');
  });

  it('跑挂了也一样：不 decide', () => {
    const outcome = threadOutcomeFor(task({ status: 'failed', error: '模型限流' }), speculative);
    expect(outcome?.state).toBe('archived');
    expect(outcome?.report?.level).toBe('silent');
    expect(outcome?.report?.body).toContain('模型限流');
  });

  it('没有闸门就没有判据：归档，不冒充通过也不打扰', () => {
    // 没有闸门的任务是 `UNVERIFIED_GATE`（一个永远成功、什么都证明不了的命令）。
    // 静默线上这等于"我不知道它对不对"，那就更不能拿它去换他的一次注意。
    const outcome = threadOutcomeFor(task({ acceptanceCommand: [...UNVERIFIED_GATE] }), speculative);
    expect(outcome?.state).toBe('archived');
    expect(outcome?.report?.level).toBe('silent');
  });

  it('非静默线不受影响：同样的任务还是老规矩', () => {
    const outcome = threadOutcomeFor(
      task({
        status: 'rejected',
        acceptance: { verdict: 'fail', reason: '退出码 1' } as never,
      }),
    );
    expect(outcome?.report?.level).toBe('decide');
  });
});
