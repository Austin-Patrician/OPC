import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { TaskRepository } from '../data/taskRepository';
import { UNVERIFIED_GATE } from './acceptanceGate';
import { MemoryService } from '../memory/memoryService';
import { USER_MEMORY_OWNER } from '../memory/owners';
import { SignalStore } from '../memory/signals';
import { WorkService } from './workService';

/**
 * The join between the two halves: a real task, run through the real durable
 * runner and the real acceptance command, speaking to a real thread.
 *
 * `threadOutcome.test.ts` pins the mapping; this pins that the mapping is actually
 * reached — that a task carrying a `threadId` leaves a report behind and moves its
 * line of work, without anyone wiring it by hand.
 *
 * No model is involved: `scriptedBrain` writes a working HTTP server and the
 * acceptance gate really starts it (that path is what `--self-test` uses too).
 */
let dir: string;
let db: CompanyDatabase;
let paths: AppPaths;
let work: WorkService;
let threads: ThreadRepository;
let assigneeId: string;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-thread-report-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  paths = {
    userData: dir,
    database: path.join(dir, 'company.db'),
    agentsDir: path.join(dir, 'agents'),
    artifactsDir: path.join(dir, 'artifacts'),
    workspaceDir: path.join(dir, 'workspace'),
    logsDir: path.join(dir, 'logs'),
    probeDir: path.join(dir, 'probe'),
    cacheDir: path.join(dir, 'cache'),
  };
  for (const target of [paths.agentsDir, paths.artifactsDir, paths.workspaceDir, paths.logsDir]) {
    mkdirSync(target, { recursive: true });
  }

  threads = new ThreadRepository(db);
  // 任务归属是一个**执行体**，不是一个人（§2.2）。
  const home = threads.createThread({ title: '测试台', goal: '测试' });
  assigneeId = threads.createWorker({ name: '李雷', threadId: home.id }).id;

  memory = new MemoryService(db);
  work = new WorkService({
    db,
    paths,
    upsertTaskCard: () => undefined,
    memory,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function runOne(overrides: { threadId?: string } = {}) {
  const thread = threads.createThread({ title: '写一个返回 ok 的服务' });
  const created = work.createTask({
    title: '写一个返回 ok 的服务',
    brief: '用 node 内置 http',
    deliverableSpec: 'server.js 返回 ok',
    assigneeId,
    estTokens: 5_000,
    acceptanceCommand: ['node', '{checks}/verify.mjs'],
    acceptanceTemplate: 'http-ok',
    ...(overrides.threadId === undefined ? { threadId: thread.id } : { threadId: overrides.threadId }),
  });
  if (!created.ok) throw new Error(created.error.message);
  const final = await work.runTaskAndWait(created.task.id);
  return { thread, task: final };
}

describe('task → thread reporting', () => {
  it('closes the line of work quietly when the work passes acceptance', async () => {
    const { thread, task } = await runOne();

    expect(task.status).toBe('accepted');
    const updated = threads.getThread(thread.id);
    expect(updated?.state).toBe('done');
    expect(updated?.spentTokens).toBeGreaterThanOrEqual(0);

    // Recorded, but not in the your face: the queue stays empty.
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('carries the thread on the task, so the work line owns the work', async () => {
    const { thread, task } = await runOne();
    expect(task.threadId).toBe(thread.id);
    expect(task.workerId).toBeDefined();
  });
});

describe('a task dispatched without a line of work', () => {
  it('gets one, so its result still has somewhere to go', async () => {
    const created = work.createTask({
      title: '写一个返回 ok 的服务',
      brief: '用 node 内置 http',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
    });
    if (!created.ok) throw new Error(created.error.message);

    const final = await work.runTaskAndWait(created.task.id);
    expect(final.status).toBe('accepted');

    // The line was opened by the dispatch itself, and it carries the goal text.
    const thread = threads.getThread(final.threadId!);
    expect(thread?.title).toBe('写一个返回 ok 的服务');
    expect(thread?.goal).toBe('用 node 内置 http');
    expect(thread?.state).toBe('done');
    // Finished work does not interrupt: recorded, not queued.
    expect(threads.listQueue()).toHaveLength(0);
  });
});


/**
 * 一个执行体同时只跑一个任务。
 *
 * 不是排序偏好，是正确性：执行体的 harness 背后是一份 sqlite 会话，两个 run 并发写
 * 同一份库会把会话毒化，之后它的每一次运行都失败。直通（§3.2）把派活从"人打一次字"
 * 变成"一来一串事件"，这条就从"偶尔踩到"变成"每天都会踩到"。
 */
describe('一个执行体同时只跑一个任务', () => {
  function unsifted(title: string) {
    const thread = threads.createThread({ title });
    const created = work.createTask({
      title,
      brief: title,
      deliverableSpec: title,
      assigneeId,
      estTokens: 2_000,
      acceptanceCommand: [...UNVERIFIED_GATE],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.task;
  }

  it('第二个任务排在第一个之后，不是同时开跑', async () => {
    const first = unsifted('第一件');
    const second = unsifted('第二件');

    work.runTask(first.id);
    work.runTask(second.id);

    // 一眼就能看出排上了：一个在跑，一个在等。
    expect(work.queueSnapshot(assigneeId)).toEqual({ running: first.id, waiting: 1 });

    for (let i = 0; i < 200; i += 1) {
      const a = new TaskRepository(db).getTask(first.id);
      const b = new TaskRepository(db).getTask(second.id);
      if (a?.finishedAt && b?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const a = new TaskRepository(db).getTask(first.id)!;
    const b = new TaskRepository(db).getTask(second.id)!;
    expect(a.finishedAt).toBeGreaterThan(0);
    // 串行：第二个的开始时间不早于第一个的结束时间。
    expect(b.startedAt).toBeGreaterThanOrEqual(a.finishedAt!);
    expect(work.queueSnapshot(assigneeId).running).toBeNull();
  });
});

/**
 * steering 层：你在队列上的两个动作。
 *
 * 这是系统唯一一处「人判定对不对」的入口——没有可执行闸门的活，系统自己
 * 判不了，所以才把它交出来。
 */
describe('user steering', () => {
  async function needsJudgement() {
    const thread = threads.createThread({ title: '整理财报', goal: '整理财报' });
    const created = work.createTask({
      title: '整理财报',
      brief: '读三份 PDF',
      deliverableSpec: '一页摘要',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: [...UNVERIFIED_GATE],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    await work.runTaskAndWait(created.task.id);
    return { thread, taskId: created.task.id };
  }

  it('asks instead of claiming a pass it cannot prove', async () => {
    const { thread } = await needsJudgement();
    expect(threads.getThread(thread.id)?.state).toBe('waiting');
    const queue = threads.listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.level).toBe('decide');
    expect(queue[0]?.body).toContain('判定不了对错');
  });

  it('closes the line when you approve', async () => {
    const { thread, taskId } = await needsJudgement();
    const result = work.decideThread(thread.id, 'approve');

    expect(result.ok).toBe(true);
    expect(threads.getThread(thread.id)?.state).toBe('done');
    expect(new TaskRepository(db).getTask(taskId)?.status).toBe('delivered');
  });

  it('rework puts a second task on the same line, carrying the note', async () => {
    const { thread, taskId } = await needsJudgement();
    const result = work.decideThread(thread.id, 'rework', '图表要标上单位');

    expect(result.ok).toBe(true);
    const latest = new TaskRepository(db).latestForThread(thread.id);
    expect(latest?.id).not.toBe(taskId);
    expect(latest?.threadId).toBe(thread.id);
    expect(latest?.brief).toContain('图表要标上单位');

    // The second attempt runs on its own; let it settle before teardown.
    for (let i = 0; i < 100 && latest && ['open', 'running'].includes(latest.status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const current = new TaskRepository(db).getTask(latest.id);
      if (current) latest.status = current.status;
    }
  });

  /**
   * 学习回路闭合：用户的要求真的改变了执行体看到的提示词。
   *
   * 这条是 P5 的全部意义。以前格式要求只存在记忆里，执行体按相关度捞经验——而
   * 「代码里不要写注释」和任务标题字面上几乎不重叠，捞不到，于是第四次还在犯。
   */
  it('用户要求过的做事规矩，会出现在执行体的提示词里', async () => {
    // 故意让它的字面和任务标题高度重合：如果它走"相关度"那一路，这次一定会被捞到。
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'format',
      content: '健康检查服务里不要写注释',
      scope: { type: 'personal' },
      sourceType: 'manual',
      subject: 'code.comments',
    });

    const { task } = await runOne();
    const steps = task.steps.map((step) => step.text);

    // 走的是"做事规矩"那条通道。
    expect(steps).toContain('注入 1 条做事规矩');
    // 而且**只走这一条**：同一条要求既当规矩又当经验，模型会当成两条。
    expect(steps.some((text) => /^注入 \d+ 条记忆$/.test(text))).toBe(false);
  });

  it('把「重做」的理由收进偏好收集箱——这句话以前被拼进 brief 就冲掉了', async () => {
    const { thread } = await needsJudgement();
    work.decideThread(thread.id, 'rework', '图表要标上单位，单位写在轴标题里');

    const pending = new SignalStore(db).pending();
    expect(pending.map((signal) => signal.origin)).toEqual(['rework']);
    expect(pending[0]?.text).toBe('图表要标上单位，单位写在轴标题里');
    expect(pending[0]?.threadId).toBe(thread.id);
  });

  it('把「中途改方向」也收进去——和返工理由是同一类证据', () => {
    const thread = threads.createThread({ title: '写周报', goal: '写周报' });
    const created = work.createTask({
      title: '写周报',
      brief: '整理本周进展',
      deliverableSpec: '一页',
      assigneeId,
      estTokens: 1_000,
      acceptanceCommand: [...UNVERIFIED_GATE],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);

    void work.steerThread(thread.id, '周报改成三段，别用编号列表');

    const pending = new SignalStore(db).pending();
    expect(pending.map((signal) => signal.origin)).toEqual(['steering']);
  });

  it('refuses to rework a line that has no task at all', () => {
    const empty = threads.createThread({ title: '空线索' });
    const result = work.decideThread(empty.id, 'rework');
    expect(result.ok).toBe(false);
  });
});


/**
 * 派活时指定的执行体。
 *
 * workerPool 挑好人之后会把 workerId 一起交出去——这是"谁来做"唯一被记录的地方。
 * 一个属于别的工作线的 worker 必须被忽略，否则运行时和线索会错位。
 */
describe('an explicitly chosen worker', () => {
  const base = {
    title: '写一个返回 ok 的服务',
    brief: '用 node 内置 http',
    deliverableSpec: 'server.js 返回 ok',
    assigneeId: '',
    estTokens: 5_000,
    acceptanceCommand: ['node', '{checks}/verify.mjs'],
    acceptanceTemplate: 'http-ok' as const,
  };

  it('is the execution body recorded on the task', () => {
    const thread = threads.createThread({ title: '写一个返回 ok 的服务' });
    const worker = threads.ensureWorker({ threadId: thread.id, ownerId: assigneeId, name: '李雷', template: 'code' });
    const created = work.createTask({ ...base, assigneeId, threadId: thread.id, workerId: worker.id });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.task.workerId).toBe(worker.id);
  });

  it('is ignored when it belongs to another line of work', () => {
    const elsewhere = threads.createThread({ title: '别的线索' });
    const foreign = threads.ensureWorker({ threadId: elsewhere.id, ownerId: assigneeId, name: '李雷' });
    const mine = threads.createThread({ title: '我的线索' });

    const created = work.createTask({ ...base, assigneeId, threadId: mine.id, workerId: foreign.id });
    if (!created.ok) throw new Error(created.error.message);

    expect(created.task.workerId).not.toBe(foreign.id);
    expect(created.task.workerId).toBeDefined();
    // The worker that was actually used lives on this thread.
    expect(threads.getWorker(created.task.workerId!)?.threadId).toBe(mine.id);
  });
});
