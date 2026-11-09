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
const approvalCards: { reportId: string; taskId: string; tool: string }[] = [];
const approvalResolutions: { reportId: string; state: 'allowed' | 'denied' }[] = [];

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
  approvalCards.length = 0;
  approvalResolutions.length = 0;
  work = new WorkService({
    db,
    threads,
    paths,
    upsertTaskCard: () => undefined,
    onApprovalCard: ({ report, task, tool }) => approvalCards.push({ reportId: report.id, taskId: task.id, tool }),
    onApprovalResolved: (reportId, state) => approvalResolutions.push({ reportId, state }),
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

/**
 * 原始记录（§3.3 / E1）。
 *
 * 以前执行体只看到 `brief = goal`——Router 用自己的话把目标重写了一遍。这条链路锁的是
 * **它现在能回到源头**：摘要里有 ID 和用户原话，顺着 ID 能取到全文，别条线的取不到。
 */
describe('原始记录', () => {
  async function runWithEvent(text: string) {
    const thread = threads.createThread({ title: '写一个返回 ok 的服务' });
    const event = threads.enqueueEvent({
      source: 'im',
      kind: 'message',
      payload: { text },
      threadId: thread.id,
    });
    threads.triageEvent(event.id, 'accepted', thread.id);

    const created = work.createTask({
      title: '写一个返回 ok 的服务',
      brief: '用 node 内置 http',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    const final = await work.runTaskAndWait(created.task.id);
    return { thread, event, task: final };
  }

  it('线上的事件以 id + 摘要进入执行体的上下文，原话逐字保留', async () => {
    const { thread, event, task } = await runWithEvent('健康检查的端口改成 8081，不要 3000');

    expect(task.steps.map((step) => step.text)).toContain('注入 1 条原始记录');

    const records = work.recordsOfThread(thread.id, task.id);
    expect(records[0]).toMatchObject({ kind: 'event', id: event.id });
    // 逐字：不是 Router 重写过的那个版本。
    expect(records[0]?.excerpt).toContain('8081');
  });

  it('顺着那个 id 能取到全文——摘要短，源头不短', async () => {
    const { event, task } = await runWithEvent('健康检查的端口改成 8081，不要 3000');
    const recalled = work.recallRecord({ taskId: task.id, id: event.id, page: 1 });

    expect(recalled.found).toBe(true);
    if (recalled.found) expect(recalled.text).toContain('8081');
  });

  it('取不到别的线上的记录：作用域由任务决定，不由模型决定', async () => {
    const { task } = await runWithEvent('健康检查的端口改成 8081');
    const otherThread = threads.createThread({ title: '另一条线' });
    const otherEvent = threads.enqueueEvent({
      source: 'github',
      kind: 'comment',
      payload: { text: '另一条线的秘密' },
      threadId: otherThread.id,
    });

    expect(work.recallRecord({ taskId: task.id, id: otherEvent.id, page: 1 })).toEqual({
      found: false,
      reason: 'out-of-scope',
    });
    expect(work.recallRecord({ taskId: task.id, id: 'ev-nope', page: 1 })).toEqual({
      found: false,
      reason: 'not-found',
    });
  });

  it('任务自己不算"背景"：记录里排掉当前这条', async () => {
    const { thread, task } = await runWithEvent('健康检查的端口改成 8081');
    const records = work.recordsOfThread(thread.id, task.id);
    expect(records.some((record) => record.id === task.id)).toBe(false);
  });
});

/**
 * 执行体只有终局的那张嘴（E3）。
 *
 * 请示与交回补上的是第三条路：以前它卡住只能猜（跑完一个你不想要的东西）或者失败
 * （一次尝试 + 一笔钱 + Router 一次复盘）。
 *
 * 这一组用例里最要紧的两条：**同一件事请示第二次不插队**，以及**交回之后线不被按回去**
 * ——后者要是漏了，交回就等于没发生：那条线会在任务结束时被改成 done。
 */
describe('请示与交回', () => {
  function openTask() {
    const thread = threads.createThread({ title: '写一个返回 ok 的服务' });
    const created = work.createTask({
      title: '写一个返回 ok 的服务',
      brief: '用 node 内置 http',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return { thread, task: created.task };
  }

  it('第一次请示插队，第二次只记在线上', () => {
    const { thread, task } = openTask();
    const ask = (question: string) =>
      work.escalateFor({ taskId: task.id, question, tried: '两个都试过', suggestion: '选稳的' });

    expect(ask('A 快 B 稳，要哪个').level).toBe('decide');
    expect(ask('还是那个问题：A 快 B 稳').level).toBe('notify');

    // 新的在前：第二次（notify）排在上面。
    const reports = threads.listReportsOf(thread.id, 10);
    expect(reports.map((report) => report.level)).toEqual(['notify', 'decide']);
    // 第一次之后线就停在"等人决定"，不是"在跑"。
    expect(threads.getThread(thread.id)?.state).toBe('waiting');
    // 两次请示都记在步骤流里：等级是算出来的，不是模型说的。
    expect(task.id).toBeTruthy();
    const steps = work.listTasks().find((entry) => entry.id === task.id)?.steps ?? [];
    expect(steps.filter((step) => step.text.startsWith('请示：'))).toHaveLength(2);
  });

  it('请示里带上你试过什么、建议怎么办', () => {
    const { thread, task } = openTask();
    work.escalateFor({
      taskId: task.id,
      question: '缺验收标准，什么算做完',
      tried: '读了 README，没有判定命令',
      suggestion: '按"返回 ok"判定',
    });

    const [report] = threads.listReportsOf(thread.id, 5);
    expect(report?.body).toContain('试过：读了 README');
    expect(report?.body).toContain('建议：按"返回 ok"判定');
  });

  it('进度不进 Router：正常干完的活只留一条 silent 记录', async () => {
    const { thread, task } = await (async () => {
      const opened = openTask();
      return { thread: opened.thread, task: await work.runTaskAndWait(opened.task.id) };
    })();
    expect(task.status).toBe('accepted');

    // 步骤很多，但它们是步骤——不是汇报。
    expect(task.steps.length).toBeGreaterThan(2);
    const reports = threads.listReportsOf(thread.id, 20);
    expect(reports.every((report) => report.level === 'silent')).toBe(true);
    expect(reports.some((report) => report.title.startsWith('请示'))).toBe(false);
    // 队列空的：干完的活不打扰人。
    expect(threads.listPendingConversationReports()).toHaveLength(0);
  });

  it('交回：退订、线回 open、留一条说明', async () => {
    const { thread, task } = openTask();
    // 直通（§3.2）会在派活时订阅；这里手工订一次，为了看清"交回把它去掉了"。
    threads.subscribe(thread.id, task.workerId ?? task.assigneeId);
    expect(threads.subscribersOf(thread.id).length).toBeGreaterThan(0);

    const result = work.handBackFor({ taskId: task.id, reason: '目标变了，这条线不该由我接' });
    expect(result.ok).toBe(true);

    expect(threads.subscribersOf(thread.id)).toHaveLength(0);
    expect(threads.getThread(thread.id)?.state).toBe('open');
    const [report] = threads.listReportsOf(thread.id, 5);
    expect(report?.level).toBe('decide');
    expect(report?.body).toContain('目标变了');
  });

  it('交回之后，这条任务跑完也不许把线按回去', async () => {
    const { thread, task } = openTask();
    work.handBackFor({ taskId: task.id, reason: '不是执行类的工作' });

    // 手上的活还是跑完了（改动不用回滚），但线要停在交回时的样子。
    const finished = await work.runTaskAndWait(task.id);
    expect(finished.status).toBe('accepted');
    expect(threads.getThread(thread.id)?.state).toBe('open');
    expect(threads.listReportsOf(thread.id, 10)).toHaveLength(1);
  });
});

/**
 * 静默线（§3.4 / E4）。
 *
 * 它不是"提前跑"（那需要后台有富余算力，单机上只是抢你自己的时间），是**说不说的判断**：
 * Router 已经决定要跑，但"值不值得让他知道"还不确定。所以规矩是反的——永远不 `decide`，
 * 闸门过了才 `notify`。
 */
describe('静默线', () => {
  function speculativeThread() {
    const thread = threads.createThread({ title: '查一下那个报错', speculative: true });
    const created = work.createTask({
      title: '查一下那个报错',
      brief: '群里说是 500',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return { thread, task: created.task };
  }

  it('跑通了才说话：一条 notify 进队列', async () => {
    const { thread, task } = speculativeThread();
    const finished = await work.runTaskAndWait(task.id);
    expect(finished.status).toBe('accepted');

    const queue = threads.listPendingConversationReports();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.level).toBe('notify');
    expect(threads.getThread(thread.id)?.state).toBe('done');
  });

  it('中途请示也不插队：静默线上的 escalate 只 notify', () => {
    const { thread, task } = speculativeThread();
    const result = work.escalateFor({
      taskId: task.id,
      question: '这算不算他关心的问题',
      tried: '看了群聊上下文',
      suggestion: '先查，不通就算了',
    });

    expect(result.level).toBe('notify');
    expect(threads.listPendingConversationReports().every((report) => report.level !== 'decide')).toBe(true);
    // 线不回 waiting：没人需要为它做决定。
    expect(threads.getThread(thread.id)?.state).not.toBe('waiting');
  });
});

/**
 * 团队收口（原文 §2.2：Worker 本身可以是一个 Agent Team）。
 *
 * 拆解以前只做了一半：子任务各自验收、各自汇报，父不等子就走了。于是三件事全押在
 * "谁先跑完谁说了算"上——父跑得快就先 `done`、子再失败就变 `failed`，父的交付物里
 * 也没有子的产物。
 *
 * 这里锁的是收口的三个面：**等**（`collect`）、**收**（子任务产出进提示词）、
 * **谁说**（线的状态由根任务决定）。
 */
/**
 * 回答执行体的请示（W3）。
 *
 * E3 给了执行体请示的嘴，但收件端只有「认可 / 重做」两个动词——它们回答不了一句问句。
 * 这一组锁的是：请示记得住是哪件活问的、回答落在**那件活**上、以及三种时刻各自的去向。
 */
describe('回答请示', () => {
  function openTask(title = '写一个返回 ok 的服务') {
    const thread = threads.createThread({ title });
    const created = work.createTask({
      title,
      brief: '用 node 内置 http',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return { thread, task: created.task };
  }

  it('请示记着是哪件活问的，种类是问题而不是汇报', () => {
    const { thread, task } = openTask();
    work.escalateFor({ taskId: task.id, question: 'A 快 B 稳，要哪个', tried: '', suggestion: '' });

    const [report] = threads.listReportsOf(thread.id, 5);
    expect(report?.kind).toBe('question');
    expect(report?.taskId).toBe(task.id);
    // 队列里也是同一条（界面据此换动词）。
    expect(threads.listPendingConversationReports()[0]?.kind).toBe('question');
  });

  it('回答记在那件活上，线从"等你"回到"在跑"', async () => {
    const { thread, task } = openTask();
    work.escalateFor({ taskId: task.id, question: 'A 快 B 稳，要哪个', tried: '', suggestion: '' });
    expect(threads.getThread(thread.id)?.state).toBe('waiting');

    const [report] = threads.listReportsOf(thread.id, 5);
    const result = await work.answerFor({ reportId: report!.id, text: '选稳的那个' });

    // 没模型在跑 → 记在那件活上，下一次尝试会看到。
    expect(result).toEqual({ ok: true, delivered: 'next-attempt' });
    const updated = new TaskRepository(db).getTask(task.id)!;
    expect(updated.steering).toEqual([
      expect.objectContaining({ kind: 'answer', note: '回答（我问的「A 快 B 稳，要哪个」）：选稳的那个' }),
    ]);
    expect(threads.getThread(thread.id)?.state).toBe('running');
    // 答过的那一行离开队列：它不再是"等你"。
    expect(threads.listPendingConversationReports()).toHaveLength(0);
  });

  it('那件活已经收尾：答案不烂在地里，带着它新开一件', async () => {
    const { thread, task } = openTask();
    const finished = await work.runTaskAndWait(task.id);
    expect(finished.status).toBe('accepted');

    // 它跑完之后又问了一句（真实里不会，但数据形状必须处理得住）。
    work.escalateFor({ taskId: task.id, question: '要不要顺手加个 README', tried: '', suggestion: '' });
    const [report] = threads.listReportsOf(thread.id, 5);

    const result = await work.answerFor({ reportId: report!.id, text: '要' });
    expect(result).toEqual({ ok: true, delivered: 'new-task' });

    const latest = new TaskRepository(db).latestForThread(thread.id)!;
    expect(latest.id).not.toBe(task.id);
    expect(latest.brief).toContain('要');
  }, 30_000);

  it('对一条普通的汇报按「回答」会被拒绝，而且告诉它该用哪个动作', async () => {
    const { thread, task } = openTask();
    await work.runTaskAndWait(task.id);
    const [report] = threads.listReportsOf(thread.id, 5);
    expect(report?.kind).toBe('report');

    const result = await work.answerFor({ reportId: report!.id, text: '收到' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('认可或返工');
  }, 30_000);

  it('空回答不送出去', async () => {
    const { thread, task } = openTask();
    work.escalateFor({ taskId: task.id, question: 'A 快 B 稳，要哪个', tried: '', suggestion: '' });
    const [report] = threads.listReportsOf(thread.id, 5);
    expect(await work.answerFor({ reportId: report!.id, text: '   ' })).toEqual({
      ok: false,
      error: '回答不能是空的',
    });
  });
});

/**
 * 动作级审批（M3）。
 *
 * 执行体要调一个会改动东西的 MCP 工具时，系统停下来问人——而且**必须由系统去问**：
 * 模型被拦之后最常见的反应是换个说法继续，那条"我被拦了"的话如果只写在工具返回里，
 * 你就永远看不到。
 */
describe('动作级审批', () => {
  function openTask() {
    const thread = threads.createThread({ title: '整理一下这个仓库' });
    const created = work.createTask({
      title: '整理一下这个仓库',
      brief: '把过期的文件挪走',
      deliverableSpec: '一份搬迁记录',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: [...UNVERIFIED_GATE],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return { thread, task: created.task };
  }

  it('要你点头：落一条 approval 汇报，线停在"等你"，工具名记在 subject 上', () => {
    const { thread, task } = openTask();
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });

    const [report] = threads.listReportsOf(thread.id, 5);
    expect(report).toMatchObject({
      kind: 'approval',
      level: 'silent',
      taskId: task.id,
      subject: 'mcp__fs__write',
    });
    expect(approvalCards).toEqual([{ reportId: report!.id, taskId: task.id, tool: 'mcp__fs__write' }]);
    expect(threads.getThread(thread.id)?.state).toBe('waiting');
    expect(threads.listPendingConversationReports().some((entry) => entry.kind === 'approval')).toBe(false);
  });

  it('同一件活、同一个工具只问一次：问第二遍是噪音', () => {
    const { thread, task } = openTask();
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    expect(threads.listReportsOf(thread.id, 10)).toHaveLength(1);
  });

  it('允许：落一张放行条，线回到"在跑"，那一行离开队列', async () => {
    const { thread, task } = openTask();
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    const [report] = threads.listReportsOf(thread.id, 5);

    const result = await work.answerFor({ reportId: report!.id, text: '', allow: true });
    expect(result.ok).toBe(true);
    expect(new TaskRepository(db).hasMcpPermit(task.id, 'mcp__fs__write')).toBe(true);
    expect(approvalResolutions).toEqual([{ reportId: report!.id, state: 'allowed' }]);
    expect(threads.getThread(thread.id)?.state).toBe('running');
    expect(threads.listPendingConversationReports()).toHaveLength(0);
  });

  it('重复点击已处理的审批也会通知界面清掉旧卡片', async () => {
    const { thread, task } = openTask();
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    const [report] = threads.listReportsOf(thread.id, 5);

    await work.answerFor({ reportId: report!.id, text: '', allow: true });
    approvalResolutions.length = 0;
    const result = await work.answerFor({ reportId: report!.id, text: '', allow: true });

    expect(result).toEqual({ ok: true, delivered: 'next-attempt' });
    expect(approvalResolutions).toEqual([{ reportId: report!.id, state: 'allowed' }]);
  });

  it('不允许：不落条，而且告诉它别再试', async () => {
    const { thread, task } = openTask();
    work.askForApproval({ taskId: task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    const [report] = threads.listReportsOf(thread.id, 5);

    await work.answerFor({ reportId: report!.id, text: '先别动那个目录', allow: false });
    expect(new TaskRepository(db).hasMcpPermit(task.id, 'mcp__fs__write')).toBe(false);
    const updated = new TaskRepository(db).getTask(task.id)!;
    expect(updated.steering?.some((entry) => entry.note.includes('不放行'))).toBe(true);
  });

  it('放行条只对那件活有效：换一件活要重新问', async () => {
    const first = openTask();
    work.askForApproval({ taskId: first.task.id, tool: 'mcp__fs__write', title: '[fs] write_file' });
    const [report] = threads.listReportsOf(first.thread.id, 5);
    await work.answerFor({ reportId: report!.id, text: '', allow: true });

    const second = openTask();
    expect(new TaskRepository(db).hasMcpPermit(second.task.id, 'mcp__fs__write')).toBe(false);
  });
});

describe('团队收口', () => {
  const repo = () => new TaskRepository(db);

  /** 直接落一条子任务，不给它派活：这样"还没交回"是确定的状态，而不是抢时序。 */
  function draftChild(parent: { id: string; threadId?: string; assigneeId: string }, title = '写 server.js') {
    const childId = `task-child-${Math.random().toString(36).slice(2, 8)}`;
    const child = repo().createTask(
      {
        title,
        brief: '用 node 内置 http',
        deliverableSpec: 'server.js 返回 ok',
        assigneeId: parent.assigneeId,
        estTokens: 1_000,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'http-ok',
        ...(parent.threadId ? { threadId: parent.threadId } : {}),
      },
      `tasks/${childId}`,
      childId,
      { parentTaskId: parent.id, depth: 1 },
    );
    return child;
  }

  function openParent() {
    const thread = threads.createThread({ title: '做一件要两个人干的事' });
    const created = work.createTask({
      title: '做一件要两个人干的事',
      brief: '先各写一半，再合成一份交付',
      deliverableSpec: 'server.js 返回 ok',
      assigneeId,
      estTokens: 5_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);
    return { thread, task: created.task };
  }

  async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('等不到那个状态');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  const stepsOf = (taskId: string) =>
    (repo().getTask(taskId)?.steps ?? []).map((step) => step.text).join('\n');

  it('父任务等子任务交回之后才去验收', async () => {
    const { task } = openParent();
    const child = draftChild(task);

    const running = work.runTaskAndWait(task.id);
    // 子任务还挂着：父要停在"等"，而不是拿着半个交付物去验收。
    await waitUntil(() => stepsOf(task.id).includes('等 1 个子任务交回'));
    expect(repo().getTask(task.id)?.status).toBe('running');
    expect(threads.getWorker(task.workerId ?? task.assigneeId)?.status).toBe('running');

    repo().setStatus(child.id, 'accepted');
    const final = await running;

    const steps = stepsOf(task.id);
    expect(steps).toContain('子任务全部交回（1 个）');
    expect(steps).toContain('注入 1 条子任务产出');
    // 先收口，再验收。
    expect(steps.indexOf('子任务全部交回')).toBeLessThan(steps.indexOf('自动验收通过'));
    expect(final.status).toBe('accepted');
    expect(threads.getWorker(task.workerId ?? task.assigneeId)?.status).toBe('idle');
  }, 30_000);

  /**
   * 收口一次的真实用途不是"等"，是**让下一轮看得见它们**。
   *
   * 子任务已经跑完的时候，父如果直接去验收，交付物就是一份不含子任务成果的东西——
   * 而它还会通过验收（闸门只判它自己的目录）。所以拆解过的任务至少收口一次。
   */
  it('子任务早就跑完了也要收口一次：否则父交的是一份不含它们的东西', async () => {
    const { task } = openParent();
    const child = draftChild(task);
    repo().setStatus(child.id, 'accepted');

    const final = await work.runTaskAndWait(task.id);
    const steps = stepsOf(task.id);

    expect(steps).toContain('收口 1 个子任务');
    expect(steps).toContain('注入 1 条子任务产出');
    expect(steps).not.toContain('等 1 个子任务交回');
    expect(final.status).toBe('accepted');
  }, 30_000);

  it('子任务的终局不动线的状态，也不进你的队列', async () => {
    const { thread, task } = openParent();
    const child = draftChild(task);
    expect(threads.getThread(thread.id)?.state).toBe('open');

    // 只跑子任务：父还没开始。
    const finished = await work.runTaskAndWait(child.id);
    expect(finished.status).toBe('accepted');

    // 线还是 open——收口人是父，不是它。
    expect(threads.getThread(thread.id)?.state).toBe('open');
    // 也不占你的注意力：记录留着，等父汇总时再说。
    expect(threads.listPendingConversationReports()).toHaveLength(0);
    const reports = threads.listReportsOf(thread.id, 10);
    expect(reports.every((report) => report.level === 'silent')).toBe(true);
  }, 30_000);

  it('真的走一遍 decompose：父汇总之后才交出一份通过验收的活', async () => {
    const { thread, task } = openParent();
    const helper = threads.createWorker({ name: '林澈', threadId: thread.id });

    const dispatched = work.decompose(task.id, assigneeId, [
      {
        title: '写 server.js',
        brief: '用 node 内置 http',
        deliverableSpec: 'server.js 返回 ok',
        assigneeId: helper.id,
        estTokens: 1_000,
      },
    ]);
    expect(dispatched.ok).toBe(true);

    const final = await work.runTaskAndWait(task.id);
    expect(final.status).toBe('accepted');
    expect(stepsOf(task.id)).toContain('注入 1 条子任务产出');
    // 根任务说话：线是被父关掉的。
    expect(threads.getThread(thread.id)?.state).toBe('done');
  }, 60_000);
});

describe('task → thread reporting', () => {
  it('uses the shared thread repository for completion observers', async () => {
    const observed: string[] = [];
    threads.onReportCreated = (report) => observed.push(`${report.kind}:${report.level}`);

    await runOne();

    expect(observed).toContain('report:silent');
  });

  it('closes the line of work quietly when the work passes acceptance', async () => {
    const { thread, task } = await runOne();

    expect(task.status).toBe('accepted');
    const updated = threads.getThread(thread.id);
    expect(updated?.state).toBe('done');
    expect(updated?.spentTokens).toBeGreaterThanOrEqual(0);

    // Recorded, but not in the your face: the queue stays empty.
    expect(threads.listPendingConversationReports()).toHaveLength(0);
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
    expect(threads.listPendingConversationReports()).toHaveLength(0);
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
  /** 等一条任务自己跑完（返工是 fire-and-forget 的）。 */
  async function settle(taskId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = new TaskRepository(db).getTask(taskId);
      if (task && !['open', 'running'].includes(task.status)) return task;
      if (Date.now() > deadline) throw new Error(`任务 ${taskId} 没有在 ${timeoutMs}ms 内结束`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

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
    const queue = threads.listPendingConversationReports();
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

    // 第二版自己跑，但**必须在收尾前跑完**：任务还在跑而库已经关掉，会以一条
    // unhandled rejection 结束整个文件——那会让真正的失败混在一堆噪音里。
    const settled = await settle(latest!.id);
    expect(settled.status).toBe('accepted');
  });

  /**
   * 学习回路闭合：用户的要求真的改变了执行体看到的提示词。
   *
   * 这条是 P5 的全部意义。以前格式要求只存在记忆里，执行体按相关度捞经验——而
   * 「代码里不要写注释」和任务标题字面上几乎不重叠，捞不到，于是第四次还在犯。
   */
  /**
   * 通过验收**不再**往记忆里写东西。
   *
   * 它以前会在每次验收通过时写一条「任务《X》通过验收。交付物：…」，挂在线上。那是
   * 日志冒充记忆：内容与 `report` 表里那条一模一样，而它读起来是"发生过什么"，不是
   * "下次该怎么做"。真实库上这类攒了 185 条，把真正的偏好淹在下面。
   */
  it('一次成功的交付不会往记忆里写东西——那是日志，不是记忆', async () => {
    const { thread, task } = await runOne();
    expect(task.status).toBe('accepted');

    expect(memory.list(thread.id)).toHaveLength(0);
    expect(memory.list(USER_MEMORY_OWNER)).toHaveLength(0);
    expect(memory.list(assigneeId)).toHaveLength(0);
    // 记录本身没丢：它在汇报里。
    expect(threads.listReportsOf(thread.id).length).toBeGreaterThan(0);
  });

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

    // 返工是 fire-and-forget 的：不把它跑完，收尾时库就关了，那条正在跑的任务
    // 会以一条 unhandled rejection 结束整个文件。
    await settle(new TaskRepository(db).latestForThread(thread.id)!.id);
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
