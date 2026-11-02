import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput, CreateTaskResult } from '@opc/shared/domain';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { UNVERIFIED_GATE } from '../work/acceptanceGate';
import { createLineOpener } from './workDispatch';

/**
 * 「派活」这个动作。
 *
 * 这里锁的是三条产品承诺：
 *
 * 1. **不阻塞**。派完立刻返回 id，不等任务跑完——这就是 §4.1 的全双工在
 *    Router 这一层的落地方式（活本身是跨进程的 durable task，天然异步）。
 * 2. **同一个环境身份不出第二条线**。老板在同一话题里连说三句，是一条线的三段
 *    上下文，不是三件互不相干的事。
 * 3. **没有闸门就说没有闸门**。验不了的活用 `UNVERIFIED_GATE`，结论是"需要人
 *    看一眼"，不假装通过。
 */
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let now: number;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-opener-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  now = 1_700_000_000_000;
  seq = 0;
  threads = new ThreadRepository(db, { now: () => (now += 1_000), id: () => `id-${(seq += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function opener(overrides: {
  noWorker?: boolean;
  create?: (input: CreateTaskInput) => CreateTaskResult;
} = {}) {
  const created: CreateTaskInput[] = [];
  const started: string[] = [];
  const open = createLineOpener({
    threads,
    // 真实装配里 resolveWorker 会 ensureWorker；这里照做，外键才有对象。
    resolveWorker: ({ threadId }) => {
      if (overrides.noWorker) return null;
      const worker = threads.ensureWorker({ threadId, employeeId: 'emp-1', name: '执行体' });
      return { employeeId: 'emp-1', workerId: worker.id };
    },
    createTask: (input) => {
      created.push(input);
      return overrides.create?.(input) ?? ({ ok: true, task: { id: 'task-1' } } as never);
    },
    startTask: (taskId) => started.push(taskId),
  });
  return { open, created, started };
}

describe('派活', () => {
  it('开线、订阅、建任务、启动，然后**立刻**返回', () => {
    const { open, created, started } = opener();
    const result = open({ goal: '整理 Q3 财报，输出一页摘要' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.threadId).toBeTruthy();
    expect(result.taskId).toBe('task-1');
    // 启动了但没等：返回值里没有任何执行结果。
    expect(started).toEqual(['task-1']);
    expect(created[0]!.threadId).toBe(result.threadId);
    // 订阅在建任务之前就位，否则任务开头那几条事件会漏掉。
    expect(threads.subscribersOf(result.threadId)).toHaveLength(1);
  });

  it('同一个并线键不出第二条线', () => {
    const { open } = opener();
    const first = open({ goal: '看这个文件', threadKey: 'folder:inbox/a.md' });
    const second = open({ goal: '这个文件又变了', threadKey: 'folder:inbox/a.md' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.threadId).toBe(first.threadId);
    expect(threads.listThreads()).toHaveLength(1);
  });

  it('没有闸门时用 UNVERIFIED_GATE，不假装验过', () => {
    const { open, created } = opener();
    open({ goal: '写一份调研' });
    expect(created[0]!.acceptanceCommand).toEqual([...UNVERIFIED_GATE]);
  });

  it('给了可执行验收命令就用它', () => {
    const { open, created } = opener();
    open({ goal: '加一个接口', template: 'code', acceptance: ['npm', 'test'] });
    expect(created[0]!.acceptanceCommand).toEqual(['npm', 'test']);
  });

  it('没人能干时如实说，不建线也不建任务', () => {
    const { open, created, started } = opener({ noWorker: true });
    const result = open({ goal: '随便干点什么' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('执行体');
    expect(created).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it('建任务失败时把理由原样带回去，不吞掉', () => {
    const { open } = opener({
      create: () => ({ ok: false, error: { code: 'X', message: '配额不足' } }) as never,
    });
    const result = open({ goal: '干活' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('配额不足');
  });
});
