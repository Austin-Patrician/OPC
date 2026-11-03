import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { WorkService } from './workService';

/**
 * 你中途改方向（§8.2「随时介入」）。
 *
 * 这条链路原来的状态是一个**空插座**：`steer_line` 这个工具在 Router 的工具带里、
 * 提示词里也写着"中途改方向用它"，但 `createRouterHost` 从来没拿到 `steer`，
 * 调用它只会得到「这个环境不支持中途改方向」。这个用例锁的是"它真的落到了数据上"。
 *
 * 两件事分别覆盖两个时刻，都要成立：
 *  - 还没开跑 / 要重试 → 写进 `task.steering`，`produce` 下次读任务带得上；
 *  - 正在跑 → 插进会话（那条要用真模型，见 `harnessBrain` 的 `interject`）。
 */
let dir: string;
let db: CompanyDatabase;
let work: WorkService;
let threads: ThreadRepository;
let workerId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-steer-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  const paths: AppPaths = {
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
  const home = threads.createThread({ title: '测试台', goal: '测试' });
  workerId = threads.createWorker({ name: '小助手', threadId: home.id }).id;
  // 没有 modelConfig：`modelBrain` 为 null，于是插话这条路会如实地返回 false，
  // 我们测的是"话有没有被存住"，不是"模型有没有听懂"。
  work = new WorkService({ db, paths, upsertTaskCard: () => undefined });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function openTaskOn(threadId: string) {
  const created = work.createTask({
    title: '写一个返回 ok 的服务',
    brief: '用 node 内置 http',
    deliverableSpec: 'server.js 返回 ok',
    assigneeId: workerId,
    estTokens: 5_000,
    acceptanceCommand: ['node', 'exit 0'],
    acceptanceTemplate: 'http-ok',
    threadId,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.task;
}

describe('你中途改方向', () => {
  it('没在跑的活：话记在任务上，下一次尝试会读到', async () => {
    const thread = threads.createThread({ title: '写个服务' });
    const task = openTaskOn(thread.id);

    const result = await work.steerThread(thread.id, '改成 8080 端口，别用 3000');

    expect(result.ok).toBe(true);
    // 没有模型就没有会话可插：如实算"排队中"。
    expect(result.live).toBe(0);
    expect(result.queued).toBe(1);

    const stored = work.listTasks(10).find((entry) => entry.id === task.id);
    expect(stored?.steering?.map((entry) => entry.note)).toEqual(['改成 8080 端口，别用 3000']);
    // 时间线上留一行，你才看得出这句话被带到了。
    expect(stored?.steps.some((step) => step.text.includes('你改方向'))).toBe(true);
  });

  it('改两次就记两条：都是真的发生过的事', async () => {
    const thread = threads.createThread({ title: '写个服务' });
    openTaskOn(thread.id);

    await work.steerThread(thread.id, '先给最小可运行版本');
    await work.steerThread(thread.id, '再加一个 /health');

    const stored = work.listTasks(10).find((entry) => entry.threadId === thread.id);
    expect(stored?.steering?.map((entry) => entry.note)).toEqual([
      '先给最小可运行版本',
      '再加一个 /health',
    ]);
  });

  it('活已经收尾了就如实拒绝：改方向得开新线，不是改一条关掉的线', async () => {
    const thread = threads.createThread({ title: '写个服务' });
    const task = openTaskOn(thread.id);
    db.prepare("UPDATE task SET status = 'accepted' WHERE id = ?").run(task.id);

    const result = await work.steerThread(thread.id, '换个做法');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('收尾');
  });

  it('等验收的活要重做，而不是在验收里改', async () => {
    const thread = threads.createThread({ title: '写个服务' });
    const task = openTaskOn(thread.id);
    db.prepare("UPDATE task SET status = 'review' WHERE id = ?").run(task.id);

    const result = await work.steerThread(thread.id, '换个做法');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('重做');
  });

  it('空话不落库，未知的线不假装成功', async () => {
    const thread = threads.createThread({ title: '写个服务' });
    openTaskOn(thread.id);

    expect((await work.steerThread(thread.id, '   ')).ok).toBe(false);
    expect((await work.steerThread('thread-不存在', '换做法')).ok).toBe(false);
    const stored = work.listTasks(10).find((entry) => entry.threadId === thread.id);
    expect(stored?.steering).toBeUndefined();
  });
});
