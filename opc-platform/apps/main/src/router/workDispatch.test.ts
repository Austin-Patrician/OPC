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
 * 2. **同一个环境身份不出第二条线**。你在同一话题里连说三句，是一条线的三段
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
      const worker = threads.ensureWorker({ threadId, ownerId: 'emp-1', name: '执行体' });
      return { ownerId: 'emp-1', workerId: worker.id };
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

  it('钉住执行体时不再挑人：直通的归属已经定了', () => {
    const thread = threads.createThread({ title: '季度财报', goal: '整理', threadKey: 'folder:inbox/q3.md' });
    // 两个执行体都在这条线上，被钉住的是第二个。
    threads.createWorker({ name: '甲', threadId: thread.id, ownerId: 'emp-a' });
    const pinned = threads.createWorker({ name: '乙', threadId: thread.id, ownerId: 'emp-b' });

    let picked = 0;
    const created: CreateTaskInput[] = [];
    const open = createLineOpener({
      threads,
      resolveWorker: () => {
        picked += 1;
        return { ownerId: 'emp-a', workerId: 'someone-else' };
      },
      createTask: (input) => {
        created.push(input);
        return { ok: true, task: { id: 'task-1' } } as never;
      },
      startTask: () => undefined,
    });

    const result = open({ goal: '这个文件又变了', threadKey: 'folder:inbox/q3.md', workerId: pinned.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 挑人这一步根本没发生，任务挂在被钉住的那个执行体上。
    expect(picked).toBe(0);
    expect(result.workerId).toBe(pinned.id);
    expect(created[0]!.workerId).toBe(pinned.id);
    expect(created[0]!.assigneeId).toBe('emp-b');
  });

  it('钉住的人不在这条线上（线被重建过）时退回正常挑人', () => {
    const thread = threads.createThread({ title: '新事', goal: '新事', threadKey: 'folder:inbox/new.md' });
    const stray = threads.createWorker({ name: '外人', ownerId: 'emp-x' });

    const { open, created } = opener();
    const result = open({ goal: '看一眼', threadKey: 'folder:inbox/new.md', workerId: stray.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.threadId).toBe(thread.id);
    expect(created[0]!.workerId).not.toBe(stray.id);
  });
});

/**
 * 静默线（§3.4）：Router 用它表达"值得跑，但值不值得让他知道还不确定"。
 *
 * 标记落在**线**上而不是任务上：规矩是这条线的规矩，而且它得在派第一个任务之前就定下来
 * ——否则第一次跑完就已经打扰过他了。
 */
describe('静默线', () => {
  it('标记落在线上', () => {
    const { open } = opener();
    const result = open({ goal: '查一下群里说的那个报错是不是真的', speculative: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(threads.getThread(result.threadId)?.speculative).toBe(true);
  });

  it('普通派活不是静默线：老规矩，跑完了要说话', () => {
    const { open } = opener();
    const result = open({ goal: '整理 Q3 财报' });
    if (!result.ok) throw new Error(result.reason);
    expect(threads.getThread(result.threadId)?.speculative).toBe(false);
  });

  it('同一个身份已经有线时不改它的性质：已有那条线不是投机开的', () => {
    const { open } = opener();
    const first = open({ goal: '整理 Q3 财报', threadKey: 'im:oc_1:om_1' });
    if (!first.ok) throw new Error(first.reason);

    const second = open({
      goal: '补充一句：只要结论',
      threadKey: 'im:oc_1:om_1',
      speculative: true,
    });
    if (!second.ok) throw new Error(second.reason);

    expect(second.threadId).toBe(first.threadId);
    expect(threads.getThread(first.threadId)?.speculative).toBe(false);
  });
});
