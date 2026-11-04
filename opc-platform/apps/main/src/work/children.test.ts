import type { WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { buildChildren, childStatusLabel, isSettled, MAX_CHILDREN, unsettledChildren } from './children';

/**
 * 团队收口（原文 §2.2）。
 *
 * 拆解以前只有一半：派出去的活各自验收、各自汇报，然后没有人收口。于是"谁先跑完谁
 * 说了算"——父还在等子，线已经 `done` 了。这三条纯函数是收口的第一半：**怎么判断
 * 一个子任务算交回了**，以及**父看到的那一段是什么**。
 */
function child(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'task-c1',
    title: '写 server.js',
    brief: 'b',
    deliverableSpec: 'd',
    assigneeId: 'w-2',
    assigneeName: '林澈',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 1,
    childCount: 0,
    estTokens: 1_000,
    acceptanceCommand: ['node', 'verify.mjs'],
    acceptanceTemplate: 'http-ok',
    status: 'accepted',
    workspaceRelPath: 'tasks/task-c1',
    createdAt: 0,
    updatedAt: 0,
    artifacts: [],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...overrides,
  };
}

describe('子任务算不算交回', () => {
  it('通过、没通过、跑挂了、中止，都算交回', () => {
    for (const status of ['accepted', 'delivered', 'rejected', 'failed', 'cancelled'] as const) {
      expect(isSettled({ status })).toBe(true);
    }
  });

  it('还在跑、等着、待复核，都不算：父不许在它们回来之前往下走', () => {
    for (const status of ['open', 'running', 'review'] as const) {
      expect(isSettled({ status })).toBe(false);
    }
  });

  it('只报没回来的那几个，父拿它决定还要不要睡', () => {
    const all = [
      child({ id: 'a', status: 'accepted' }),
      child({ id: 'b', status: 'running' }),
      child({ id: 'c', status: 'review' }),
    ];
    expect(unsettledChildren(all).map((entry) => entry.id)).toEqual(['b', 'c']);
  });
});

describe('父看到的子任务产出', () => {
  it('给结论和产物路径，不给一段叙述', () => {
    const [only] = buildChildren([
      child({
        artifacts: [{ id: 'x', relPath: 'server.js', bytes: 120, sha256: 'h' }],
        acceptance: {
          verdict: 'pass',
          reason: '退出码 0（90ms）',
          evidence: { command: [], exitCode: 0, stdoutTail: '', stderrTail: '', durationMs: 90 },
          createdAt: 1,
        },
      }),
    ]);

    expect(only).toMatchObject({
      id: 'task-c1',
      verdict: 'pass',
      reason: '退出码 0（90ms）',
      artifacts: ['server.js'],
    });
  });

  it('没有闸门的子任务写成 null，不写成"通过"', () => {
    const [only] = buildChildren([child({ status: 'accepted' })]);
    expect(only?.verdict).toBeNull();
  });

  it('跑挂了的把原因带上：父汇总时唯一有用的就是这句', () => {
    const [only] = buildChildren([child({ status: 'failed', error: '执行体没有产出任何文件' })]);
    expect(only?.reason).toBe('执行体没有产出任何文件');
  });

  it('按派出去的顺序给，不按重要性：合成交付物时人是顺着读的', () => {
    const ordered = buildChildren([
      child({ id: 'b', createdAt: 200 }),
      child({ id: 'a', createdAt: 100 }),
      child({ id: 'c', createdAt: 300 }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('最多给八条：提示词是预算，不是账本', () => {
    const many = Array.from({ length: 20 }, (_, index) => child({ id: `c-${index}`, createdAt: index }));
    expect(buildChildren(many)).toHaveLength(MAX_CHILDREN);
  });

  it('状态用工作语域说，不用实现词', () => {
    expect(childStatusLabel('accepted')).toBe('通过了验收');
    expect(childStatusLabel('rejected')).toBe('没通过验收');
    expect(childStatusLabel('review')).toBe('待复核');
  });
});
