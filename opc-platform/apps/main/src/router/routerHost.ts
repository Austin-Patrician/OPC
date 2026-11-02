import path from 'node:path';
import type { Context } from '@earendil-works/chord/context';
import type { Harness, Registry } from '@earendil-works/pi-durable';
import { createRegistry } from '@earendil-works/pi-durable';
import type { ModelRef, WorkReport } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import type { ModelConfigService } from '../models/modelConfigService';
import { Router } from './router';
import { RouterSession } from './routerSession';
import { createRouterTools, type LineSummary } from './routerTools';
import type { OpenLineInput, OpenLineResult } from './workDispatch';

/**
 * 把 Router 装起来。
 *
 * 这里回答一个很容易被糊弄过去的问题：**Router 到底是不是一个真的会话？**
 *
 * 是。它有一份自己的 sqlite（`agents/router.sqlite`）、一个常驻的 conversation、
 * 一套只属于它的工具、自己的模型与 thinking、自己的压缩策略。进程重启后它记得
 * 之前发生过什么。它没有 bash、没有文件读写——按 §2.1，Router 是序点不是人手。
 *
 * 同时它**不是**聊天窗口：老板看不到它的推理，只看到 `reply_to_boss` 说出去的话。
 * 这个区分就是 v1 那个"单会话阻塞"和 v2 双层架构的分界线。
 */

export interface RouterHostDeps {
  db: CompanyDatabase;
  /** Router 自己的运行时目录（与执行体分开，互不污染）。 */
  agentsDir: string;
  workspaceDir: string;
  modelConfig?: ModelConfigService;
  /** 执行体的环境（PATH 里的 node/python）；Router 用不到，但 pi 要一个 env。 */
  envFor: () => Record<string, string>;
  context: () => Promise<Context>;
  /** 派活：开线 + 建任务 + 启动，立刻返回。 */
  openLine: (input: OpenLineInput) => OpenLineResult;
  /** 对老板说话。 */
  reply: (text: string) => void;
  /** 中途改方向。 */
  steer?: (threadId: string, note: string) => { ok: boolean; reason?: string };
}

export interface RouterHost {
  router: Router;
  session: RouterSession;
  /** 一轮调度。定时器和 IPC 都调它。 */
  tick: () => ReturnType<Router['tick']>;
  settle: () => Promise<void>;
}

export function createRouterHost(deps: RouterHostDeps): RouterHost {
  const threads = new ThreadRepository(deps.db);
  const tasks = new TaskRepository(deps.db);

  /** Router 的模型：跟设置走的公司默认。轻量即可（§2.1）。 */
  const model = (): ModelRef | null => deps.modelConfig?.getDefaults().llm ?? null;

  let harnessPromise: Promise<Harness> | null = null;
  const harness = (): Promise<Harness> => {
    harnessPromise ??= openRouterHarness(deps, registry());
    return harnessPromise;
  };

  const session = new RouterSession({
    harness,
    context: () => deps.context() as Promise<unknown>,
    model,
    thinking: () => deps.modelConfig?.getThinking() ?? 'low',
    cwd: () => deps.workspaceDir,
  });

  // ── 工具背后的动作 ────────────────────────────────────────────────────

  const reply = (text: string): void => deps.reply(text);

  const lines = (state: 'active' | 'all' = 'active'): LineSummary[] => {
    const rows = state === 'active' ? threads.listActiveThreads(30) : threads.listThreads({ limit: 30 });
    return rows.map((thread) => {
      const [latest] = threads
        .listReportsOf(thread.id, 1)
        .map((report: WorkReport) => `${report.title}${report.body ? `：${report.body}` : ''}`);
      return {
        threadId: thread.id,
        title: thread.title,
        state: thread.state,
        attention: thread.attention,
        lastActivityAt: thread.lastActivityAt,
        latestReport: latest ?? null,
      };
    });
  };

  const recall = (id: string): string => {
    const thread = threads.getThread(id);
    if (thread) {
      const workers = threads.listWorkers(thread.id);
      const reports = threads.listReportsOf(thread.id, 5);
      const threadTasks = tasks.listByThread(thread.id, 5);
      return [
        `thread ${thread.id}「${thread.title}」`,
        `状态 ${thread.state} · 注意力 ${thread.attention} · 并线键 ${thread.threadKey ?? '（无）'}`,
        `目标：${thread.goal || '（空）'}`,
        workers.length > 0
          ? `执行体：${workers.map((worker) => `${worker.id}(${worker.name}, ${worker.template}, ${worker.status})`).join('、')}`
          : '执行体：无',
        threadTasks.length > 0
          ? `任务：\n${threadTasks
              .map((task) => `  - ${task.id} · ${task.status} · ${task.title}`)
              .join('\n')}`
          : '任务：无',
        reports.length > 0
          ? `最近汇报：\n${reports
              .map((report) => `  - ${report.id} · ${report.level} · ${report.title}：${report.body}`)
              .join('\n')}`
          : '最近汇报：无',
      ].join('\n');
    }

    const worker = threads.getWorker(id);
    if (worker) {
      return [
        `worker ${worker.id}（${worker.name}）`,
        `模板 ${worker.template} · 状态 ${worker.status} · 技能 ${worker.skills.join('、') || '（无）'}`,
        worker.threadId ? `所属线：${worker.threadId}` : '所属线：无（空闲）',
      ].join('\n');
    }

    const task = tasks.getTask(id);
    if (task) {
      return [
        `task ${task.id}「${task.title}」`,
        `状态 ${task.status} · 线 ${task.threadId ?? '（无）'} · 执行体 ${task.workerId ?? task.assigneeId}`,
        `要求：${task.deliverableSpec}`,
        task.artifacts.length > 0
          ? `产出：${task.artifacts.map((artifact) => artifact.relPath).join('、')}`
          : '产出：无',
        task.error ? `错误：${task.error}` : '',
        task.acceptance
          ? `验收：${task.acceptance.verdict} · 退出码 ${task.acceptance.evidence.exitCode ?? 'null'} · ${task.acceptance.reason}`
          : '验收：无',
      ]
        .filter(Boolean)
        .join('\n');
    }

    const report = threads.getReport(id);
    if (report) {
      return [
        `report ${report.id}（${report.level}）`,
        `线：${report.threadId}`,
        `标题：${report.title}`,
        `内容：${report.body || '（空）'}`,
      ].join('\n');
    }

    const event = threads.getEvent(id);
    if (event) {
      return [
        `event ${event.id} · ${event.source}/${event.kind}`,
        `分诊 ${event.triage}${event.threadId ? ` · 线 ${event.threadId}` : ''}`,
        `内容：${JSON.stringify(event.payload)}`,
      ].join('\n');
    }

    return `找不到 ${id}。可能是 id 打错了，或者那条记录已经不在了。`;
  };

  const closeLine = (threadId: string, summary: string) => {
    const thread = threads.getThread(threadId);
    if (!thread) return { ok: false, reason: `未知的线：${threadId}` };
    threads.setState(threadId, 'done');
    threads.addReport({ threadId, level: 'silent', title: thread.title, body: summary });
    for (const worker of threads.listWorkers(threadId)) {
      threads.unsubscribe(threadId, worker.id);
      threads.retireWorker(worker.id);
    }
    return { ok: true };
  };

  const askBoss = (threadId: string | null, question: string) => {
    const target = threadId ?? threads.listActiveThreads(1)[0]?.id ?? null;
    if (!target) return { ok: false, reason: '没有可以挂靠的线；用 reply_to_boss 直接说话' };
    threads.addReport({ threadId: target, level: 'decide', title: '需要你拍板', body: question });
    threads.setAttention(target, 'decide');
    return { ok: true };
  };

  function registry(): Registry {
    const built = createRegistry();
    built.install(
      createRouterTools({
        openLine: deps.openLine,
        reply,
        recall,
        lines,
        steerLine: (threadId, note) =>
          deps.steer?.(threadId, note) ?? { ok: false, reason: '这个环境不支持中途改方向' },
        askBoss,
        closeLine,
      }),
    );
    return built;
  }

  const router = new Router({
    threads,
    // 程序层：只挡真正不是活的源。有语义层（Router 会话）在后面，这里不必聪明。
    prefilter: (event) => (event.source === 'manual' || event.source === 'folder' || event.source === 'im'
      ? 'keep'
      : 'drop'),
    deliver: (text) => session.deliver(text),
    /**
     * 直通（§3.2 Fast Path）：这条事件流的归属已经确定，程序直接发给盯它的执行体，
     * 不经过 Router 的模型。它省的是 Router 的决策次数与读缓存 token（原文 7.1
     * 实测各约 30%），不是正确性。
     *
     * 事件自己的内容要带过去：直通省掉的是"判断"，不是"信息"。否则同一个话题里
     * 第二条事件到达时，执行体看到的还是第一条的目标。
     */
    passthrough: (intent) => {
      const payload = intent.event.payload;
      const fresh = ['text', 'goal', 'summary', 'brief', 'path']
        .map((field) => payload[field])
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      deps.openLine({
        goal: fresh?.trim() || intent.thread.goal || intent.thread.title,
        title: intent.thread.title,
        threadKey: intent.thread.threadKey,
      });
    },
  });

  return {
    router,
    session,
    tick: () => router.tick(),
    settle: () => session.settle(),
  };
}

/**
 * Router 的 harness。
 *
 * 和执行体分开一个目录，原因不是洁癖：Router 的注册表里没有 bash、没有文件工具，
 * 而一个 harness 的注册表在打开时就固定了。混在一起，迟早会有一次派活让 Router
 * 拿到执行体的工具。
 */
async function openRouterHarness(deps: RouterHostDeps, registry: Registry): Promise<Harness> {
  const { Harness } = await import('@earendil-works/pi-durable');
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');

  const context = await deps.context();
  const models = deps.modelConfig
    ? await deps.modelConfig.runtime.createModels()
    : (await import('@earendil-works/pi-ai/models')).createModels();

  return Harness.open(
    await openNodeSqliteStorage(path.join(deps.agentsDir, 'router.sqlite')),
    {
      models,
      registry,
      ...(deps.modelConfig
        ? {
            settings: {
              compaction: {
                enabled: deps.modelConfig.getCompaction().enabled,
                reserveTokens: deps.modelConfig.getCompaction().reserveTokens,
                keepRecentTokens: deps.modelConfig.getCompaction().keepRecentTokens,
                backgroundTokens: deps.modelConfig.getCompaction().backgroundTokens,
              },
            },
          }
        : {}),
      env: ({ cwd }: { cwd?: string }) =>
        new NodeExecutionEnv({
          cwd: cwd ?? deps.workspaceDir,
          shellEnv: deps.envFor(),
        }),
    },
    context,
  );
}
