import path from 'node:path';
import type { Context } from '@earendil-works/chord/context';
import type { Harness, Registry } from '@earendil-works/pi-durable';
import { createRegistry } from '@earendil-works/pi-durable';
import type { ModelRef, TriagePolicy, WorkReport } from '@opc/shared/domain';
import { recallOwners, USER_MEMORY_OWNER } from '../memory/owners';
import type { CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import type { FactService } from '../memory/factService';
import type { MemoryService } from '../memory/memoryService';
import type { DecisionService } from '../models/decisionService';
import type { ModelConfigService } from '../models/modelConfigService';
import { Router } from './router';
import { RouterSession } from './routerSession';
import { createRouterTools, type LineSummary } from './routerTools';
import { createDecisionGate, keepAll, type SemanticScreener } from './semanticGate';
import { createFastPath } from './triage';
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
 * 同时它**不是**聊天窗口：你看不到它的推理，只看到 `reply_to_user` 说出去的话。
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
  /** 对你说话。 */
  reply: (text: string) => void;
  /** 中途改方向。`live` 是"真的插进正在跑的会话"的条数。 */
  steer?: (
    threadId: string,
    note: string,
  ) => Promise<{ ok: boolean; reason?: string; live: number; queued: number }>;
  /** 两层过滤怎么配（§3.1）；每一轮都重新读，改完立刻生效。 */
  policy: () => TriagePolicy;
  /** 语义门用的分类器。没配（或没模型）时这一层自然关掉。 */
  decisions?: DecisionService;
  /**
   * Router 的记忆。它读写的 `ownerId` 是 `ROUTER_ID`——归档会话巩固出来的记忆
   * 也落在那个 id 上（`chatService` 用 `memberIds[0]` 当 owner），所以写的人和
   * 读的人是同一个。这正是 §2.1 说的"Router 是全局序点…和记忆"。
   */
  memory?: MemoryService;
  /** 工作台的规矩：`fact` 的 global 那几条，每轮带进 Router 的上下文。 */
  facts?: FactService;
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

  /** Router 的模型：跟设置走的工作台默认。轻量即可（§2.1）。 */
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

    const remembered = deps.memory?.get(id);
    if (remembered) {
      const when = new Date(remembered.createdAt).toISOString().slice(0, 10);
      return [
        `memory ${remembered.id}（${remembered.kind}）`,
        `记于 ${when} · 作用域 ${remembered.scopeType}` +
          `${remembered.scopeId ? ` ${remembered.scopeId}` : ''} · 来源 ${remembered.sourceType}` +
          `${remembered.sourceId ? ` ${remembered.sourceId}` : ''}`,
        `内容：${remembered.content}`,
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

  const askUser = (threadId: string | null, question: string) => {
    const target = threadId ?? threads.listActiveThreads(1)[0]?.id ?? null;
    if (!target) return { ok: false, reason: '没有可以挂靠的线；用 reply_to_user 直接说话' };
    threads.addReport({ threadId: target, level: 'decide', title: '需要你拍板', body: question });
    threads.setAttention(target, 'decide');
    return { ok: true };
  };

  /**
   * Router 自己的记忆。
   *
   * 它记的是**关于你的事**：你的偏好、你否决过的方向、你要求过的格式。这些不属于
   * 任何一条工作线，所以落在 `personal`（owner 是 `router`）。
   *
   * 这条链路以前是断的：归档会话巩固出来的记忆写着 `owner_id = 'router'`，而唯一
   * 会读记忆的人是执行体（读自己的 id）。也就是说，记得这件事的库、和会去回忆的人，
   * 从来不是同一个。现在 Router 有了读的入口，写和读终于指向同一个 owner。
   */
  const remember = async (text: string, options?: { standing?: boolean }) => {
    if (!deps.memory) return { ok: false, reason: '这个环境没有可用的记忆库' };
    const content = text.trim();
    if (!content) return { ok: false, reason: '内容是空的' };
    const tier = options?.standing ? ('standing' as const) : ('long' as const);
    let id: string;
    try {
      id = await deps.memory.remember({
      // 挂在**这个人**名下，不是挂在 'router' 名下：一条「以后结论放前面」是关于他的，
      // 执行体也得读得到。挂在自己名下的话，关于同一个人的偏好会被切成 N+1 份。
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content,
        scope: { type: 'personal' },
        sourceType: 'manual',
        tier,
      });
    } catch (error) {
      // 常驻层满了、或者这条已经在里面了：把原因原样交回去，别让模型自己编一个。
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, id };
  };

  /**
   * 撤掉一条。
   *
   * 用户说「以后别这样了」时必须有一条路可走——没有一个撤入口的记忆系统，常驻层
   * 一旦填满就永久填满，而里面每一条都在替用户说话。
   */
  const forget = async (id: string) => {
    if (!deps.memory) return { ok: false, reason: '这个环境没有可用的记忆库' };
    return deps.memory.forget(id)
      ? { ok: true }
      : { ok: false, reason: `没找到这条记忆，或者它已经撤掉了：${id}` };
  };

  /**
   * 回忆一次。
   *
   * 两处刻意的选择：
   *
   * 1. **跨三个归属域查**：这个人（`'user'`）+ 最近 5 条活跃线。只查人就查不到这单
   *    踩过的坑，只查线就查不到他本人的要求，而这两样必须同时在场。
   * 2. **`minRelevance: 0`**：显式回忆是「他明确问我在想什么」的时刻，这时候因为"不够相关"
   *    而回一句"没有记录"，等于把库里的东西藏起来。宁可给出最相关的那几条，
   *    让模型自己判断有没有用。
   */
  const recallMemory = async (query: string) => {
    if (!deps.memory) return { ok: false, reason: '这个环境没有可用的记忆库' };
    const lines = threads.listActiveThreads(5);
    const owners = recallOwners({});
    for (const thread of lines) owners.push(thread.id);

    const found = await deps.memory.retrieve({
      owners,
      query,
      scopes: [{ type: 'personal' }, ...lines.map((thread) => ({ type: 'thread' as const, id: thread.id }))],
      limit: 5,
      minRelevance: 0,
    });
    return {
      ok: true as const,
      items: found.map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
        createdAt: item.createdAt,
        sourceType: item.sourceType,
        relevance: item.relevance,
      })),
    };
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
          deps.steer?.(threadId, note) ??
          Promise.resolve({
            ok: false,
            reason: '这个环境不支持中途改方向',
            live: 0,
            queued: 0,
          }),
        askUser,
        closeLine,
        remember,
        forget,
        recallMemory,
      }),
    );
    return built;
  }

  /** 程序层：策略由设置决定，每一轮重新读。 */
  const fastPath = createFastPath({ policy: () => deps.policy() });

  /**
   * 语义门：开了 `decision` 就先用分类器筛一遍噪声，关着就全部交给 Router。
   *
   * 这里每轮重新读策略，所以"在设置里把语义层换成分类器"不需要重启，下一轮生效。
   * 分类器没配时自动退回 `keepAll`——那不是错误，只是这一层没启用。
   */
  const gate = deps.decisions
    ? createDecisionGate({
        decisions: deps.decisions,
        threshold: () => deps.policy().noiseThreshold,
        // 判噪策略本身也是配置：什么算噪声，取决于你怎么用这个工作台，不取决于
        // 写代码的人怎么想。每次重新读，改完下一批生效。
        policy: () => deps.policy().semanticPrompt,
      })
    : null;

  const semantic: SemanticScreener = async (events) =>
    deps.policy().semantic === 'decision' && gate ? gate(events) : keepAll(events);

  /** 工作台的规矩：Router 也得知道这些，否则"规矩"只有干活的人知道。 */
  const rules = (): string[] =>
    deps.facts ? deps.facts.current([{ type: 'global' }], 12).map((fact) => fact.statement) : [];

  /**
   * 常驻约束：每轮都在场的那几条。
   *
   * 它**不经过检索**——「回答不要客套」不该因为这一轮的事件不相关就不出现。这正是
   * `07-memory.md` 公理 A4 的落地：必须每轮生效的东西不能依赖模型主动去取。
   */
  const standing = (): string[] =>
    deps.memory ? deps.memory.standing(USER_MEMORY_OWNER).map((item) => item.content) : [];

  const router = new Router({
    threads,
    prefilter: fastPath,
    semantic,
    rules,
    standing,
    deliver: (text) => session.deliver(text),
    /**
     * 直通（§3.2 Fast Path）：这条事件流的归属已经确定，程序直接发给盯它的执行体，
     * 不经过 Router 的模型。它省的是 Router 的决策次数与读缓存 token（原文 7.1
     * 实测各约 30%），不是正确性。
     *
     * 事件自己的内容要带过去：直通省掉的是"判断"，不是"信息"。否则同一个话题里
     * 第二条事件到达时，执行体看到的还是第一条的目标。
     *
     * `workerId` 也带过去：归属已定的意思是**连人也定了**。不带它，`openLine` 会
     * 按目标从全库重新挑一次——单执行体的机器上看不出来，多执行体的机器上就是
     * 同一件事被两个人各干一半。
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
        workerId: intent.workerId,
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
