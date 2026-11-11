import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Harness, Registry } from "@earendil-works/pi-durable";
import { createRegistry } from "@earendil-works/pi-durable";
import type {
  ChatAttachmentRef,
  ChatContentBlock,
  ModelRef,
  RouterResponse,
  TriagePolicy,
  WorkReport,
} from "@opc/shared/domain";
import { recallOwners, USER_MEMORY_OWNER } from "../memory/owners";
import type { CompanyDatabase } from "../data/companyDatabase";
import type { RouterScheduleRepository } from "../data/routerScheduleRepository";
import type { UsageRepository } from "../data/usageRepository";
import type { PricingMode } from "@opc/shared/domain";
import type { FaultSink } from "../data/systemEventRepository";
import { TaskRepository } from "../data/taskRepository";
import { ThreadRepository } from "../data/threadRepository";
import type { FactService } from "../memory/factService";
import type { MemoryKind, MemoryService } from "../memory/memoryService";
import type { DecisionService } from "../models/decisionService";
import type { ModelConfigService } from "../models/modelConfigService";
import { Router } from "./router";
import { pickRouterModel } from "./routerModel";
import { RouterSession } from "./routerSession";
import { openRouterStorage } from "./routerStorage";
import {
  createRouterTools,
  type LineSummary,
  type RouterToolDeps,
} from "./routerTools";
import type { AssistantToolsService } from "../assistant/assistantTools";
import {
  createDecisionGate,
  keepAll,
  type SemanticScreener,
} from "./semanticGate";
import { bodyOf, createFastPath } from "./triage";
import { unfinishedReason, unfinishedTasksOf } from "./threadBusy";
import type { OpenLineInput, OpenLineResult } from "./workDispatch";
import type { TriggerReplyTarget } from "../trigger/types";
import { renderTrace } from "../work/trace";
import type { ContextGraphStore } from "../ontology/types";
import type { RouterWorkerCapability } from "./routerCapabilities";

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
  /** Use the application's shared repository so report observers see worker results. */
  threads?: ThreadRepository;
  /** 系统故障的去处（`system_event`）。没有就只打到控制台。 */
  faults?: FaultSink;
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
  /** Desktop fallback; external sends can be injected without coupling Router to SDKs. */
  reply: (
    response: RouterResponse,
    target?: TriggerReplyTarget,
    content?: ChatContentBlock[],
  ) => void | Promise<void>;
  /** Optional desktop-only stream for the Router's plain-text final answer. */
  streamReply?: (event: {
    type: "delta" | "clear" | "finish";
    text?: string;
  }) => void;
  /** User-facing assistant lifecycle phase; internal tool details stay hidden. */
  onActivity?: (
    phase:
      | "thinking"
      | "delegating"
      | "working"
      | "organizing"
      | "typing"
      | "completed"
      | "error",
  ) => void;
  /** Optional platform sender. If absent, a targeted reply falls back to desktop and logs. */
  externalReply?: (
    target: TriggerReplyTarget,
    text: string,
  ) => void | Promise<void>;
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
  /** User-owned response preferences, read every turn so changes apply immediately. */
  personalPreferences?: () => {
    tone: string;
    detail: string;
    instructions: string;
  };
  contextGraph?: ContextGraphStore;
  ontologyCommand?: RouterToolDeps["ontologyCommand"];
  /** Dynamic metadata-only Worker tool directory; Router never receives the tools. */
  workerCapabilities?: () =>
    | readonly RouterWorkerCapability[]
    | Promise<readonly RouterWorkerCapability[]>;
  assistantTools?: AssistantToolsService;
  usageRepository?: UsageRepository;
  pricingMode?: () => PricingMode;
  schedules?: RouterScheduleRepository;
}

export interface RouterHost {
  router: Router;
  session: RouterSession;
  /** 一轮调度。定时器和 IPC 都调它。 */
  tick: () => ReturnType<Router["tick"]>;
  settle: () => Promise<void>;
}

export function shouldRepairMissingReply(
  hasResponse: boolean,
  openedLine: boolean,
): boolean {
  return !hasResponse && !openedLine;
}

export function createRouterHost(deps: RouterHostDeps): RouterHost {
  const threads = deps.threads ?? new ThreadRepository(deps.db);
  const tasks = new TaskRepository(deps.db);

  /**
   * Router 的模型：显式配的 `router` 一档优先，没配就跟随执行体的默认模型。
   *
   * 每轮重新读（`RouterSession.reconfigure`），所以设置里换完下一轮生效，不用重启。
   */
  const model = (): ModelRef | null =>
    pickRouterModel(deps.modelConfig?.getDefaults());

  let harnessPromise: Promise<Harness> | null = null;
  const harness = (): Promise<Harness> => {
    harnessPromise ??= openRouterHarness(deps, registry());
    return harnessPromise;
  };
  const resetHarness = async (): Promise<void> => {
    const current = harnessPromise;
    harnessPromise = null;
    if (!current) return;
    const opened = await current.catch(() => null);
    if (!opened) return;
    await opened.close((await deps.context()) as never).catch(() => undefined);
  };

  // The target set belongs to the input currently being processed. Router tools can
  // only select one of these exact addresses; arbitrary model-supplied destinations
  // are never trusted.
  let activeReplyTargets: readonly TriggerReplyTarget[] = [];
  let openedLineThisTurn = false;
  /** Attachments belonging to the current Router input. They are copied into
   * every newly opened line unless the model already supplied the same refs. */
  let activeInputAttachments: readonly ChatAttachmentRef[] = [];

  const session = new RouterSession({
    harness,
    resetHarness,
    context: () => deps.context() as Promise<unknown>,
    model,
    thinking: () => deps.modelConfig?.getRouterThinking() ?? "low",
    cwd: () => deps.workspaceDir,
    onText: (text) => {
      deps.onActivity?.("typing");
      deps.streamReply?.({ type: "delta", text });
    },
    onToolRound: () => {
      deps.onActivity?.("thinking");
      deps.streamReply?.({ type: "clear" });
    },
    onTurn: ({ ok }) => {
      if (!ok) deps.onActivity?.("error");
    },
    onUsage: (usage) => {
      const configuredCost = usage.configuredCostUsd;
      const chargedCost = deps.pricingMode?.() === "provider_only" ? undefined : configuredCost;
      deps.usageRepository?.recordSafely({
        idempotencyKey: `router:${usage.conversationId}:${usage.startedAt}`,
        startedAt: usage.startedAt,
        finishedAt: usage.finishedAt,
        durationMs: usage.finishedAt - usage.startedAt,
        conversationId: usage.conversationId,
        capability: "chat",
        operation: "router conversation usage delta",
        origin: "router",
        providerId: usage.providerId,
        modelId: usage.modelId,
        status: usage.status,
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.input + usage.output,
        tokenSource: "pi.session-delta",
        billingUnit: "token",
        ...(configuredCost !== undefined ? { configuredCostUsd: configuredCost } : {}),
        ...(chargedCost !== undefined ? { chargedCostUsd: chargedCost } : {}),
        costSource: chargedCost === undefined ? "unpriced" : "configured",
      });
    },
  });

  let pendingResponse: RouterResponse | null = null;

  // ── 工具背后的动作 ────────────────────────────────────────────────────

  const reply = async (
    input: RouterResponse | string,
    address?: string,
    content?: ChatContentBlock[],
  ): Promise<void> => {
    const response: RouterResponse =
      typeof input === "string"
        ? {
            blocks: content?.length
              ? content
              : [{ type: "markdown", text: input }],
            ...(address ? { replyTarget: address } : {}),
          }
        : input;
    if (pendingResponse)
      throw new Error("本轮已经提交过最终回复；reply_to_user 每轮只能调用一次");
    if (
      response.replyTarget &&
      !activeReplyTargets.some(
        (target) => target.address === response.replyTarget,
      )
    ) {
      throw new Error(`当前输入没有这个回复地址：${response.replyTarget}`);
    }
    for (const block of response.blocks) {
      if (
        block.type === "image" ||
        block.type === "video" ||
        block.type === "audio"
      ) {
        if (
          block.source.type === "url" &&
          !/^https?:$/i.test(new URL(block.source.url).protocol)
        ) {
          throw new Error("媒体 URL 只允许 http/https");
        }
      }
      if (
        (block.type === "image" ||
          block.type === "video" ||
          block.type === "audio" ||
          block.type === "file") &&
        block.source.type === "artifact"
      ) {
        const source = block.source as {
          type: "artifact";
          taskId: string;
          relPath: string;
        };
        const task = tasks.getTask(source.taskId);
        if (
          !task ||
          !task.artifacts.some(
            (artifact) => artifact.relPath === source.relPath,
          )
        ) {
          throw new Error(
            `未登记的任务产物：${source.taskId}/${source.relPath}`,
          );
        }
      }
    }
    pendingResponse = response;
  };

  const lines = (state: "active" | "all" = "active"): LineSummary[] => {
    const rows =
      state === "active"
        ? threads.listActiveThreads(30)
        : threads.listThreads({ limit: 30 });
    return rows.map((thread) => {
      const [latest] = threads
        .listReportsOf(thread.id, 1)
        .map(
          (report: WorkReport) =>
            `${report.title}${report.body ? `：${report.body}` : ""}`,
        );
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
        `状态 ${thread.state} · 注意力 ${thread.attention} · 并线键 ${thread.threadKey ?? "（无）"}`,
        `目标：${thread.goal || "（空）"}`,
        workers.length > 0
          ? `执行体：${workers.map((worker) => `${worker.id}(${worker.name}, ${worker.template}, ${worker.status})`).join("、")}`
          : "执行体：无",
        threadTasks.length > 0
          ? `任务：\n${threadTasks
              .map((task) => `  - ${task.id} · ${task.status} · ${task.title}`)
              .join("\n")}`
          : "任务：无",
        reports.length > 0
          ? `最近汇报：\n${reports
              .map(
                (report) =>
                  `  - ${report.id} · ${report.level} · ${report.title}：${report.body}`,
              )
              .join("\n")}`
          : "最近汇报：无",
      ].join("\n");
    }

    const worker = threads.getWorker(id);
    if (worker) {
      return [
        `worker ${worker.id}（${worker.name}）`,
        `模板 ${worker.template} · 状态 ${worker.status} · 技能 ${worker.skills.join("、") || "（无）"}`,
        worker.threadId ? `所属线：${worker.threadId}` : "所属线：无（空闲）",
      ].join("\n");
    }

    // `task:<id>` 与裸 id 等价：Router 从 `records` 里看到的是 `task-…`，
    // 但它也可能照着别处的写法带上前缀。两种都认。
    const task = tasks.getTask(
      id.startsWith("task:") ? id.slice("task:".length) : id,
    );
    if (task) {
      const trace = tasks.listTrace(task.id, 12);
      return [
        `task ${task.id}「${task.title}」`,
        `状态 ${task.status} · 线 ${task.threadId ?? "（无）"} · 执行体 ${task.workerId ?? task.assigneeId}`,
        `目标：${task.contract?.objective ?? task.brief}`,
        `交付：${task.contract?.deliverable ?? task.deliverableSpec}`,
        task.answer ? `执行体回答：${task.answer}` : "执行体回答：无",
        task.artifacts.length > 0
          ? `产出：${task.artifacts.map((artifact) => artifact.relPath).join("、")}`
          : "产出：无",
        // 动作流（W6）：Router 只看汇报，但「它到底在干什么」必须答得出来。
        trace.length > 0
          ? `最近动作（trace，最后 ${trace.length} 步）：\n${renderTrace(trace)
              .map((line) => `  - ${line}`)
              .join("\n")}`
          : "最近动作：无（这条任务没有动作记录）",
        task.error ? `错误：${task.error}` : "",
        task.acceptance
          ? `验收：${task.acceptance.verdict} · 退出码 ${task.acceptance.evidence.exitCode ?? "null"} · ${task.acceptance.reason}`
          : "验收：无",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const report = threads.getReport(id);
    if (report) {
      return [
        `report ${report.id}（${report.level}）`,
        `线：${report.threadId}`,
        `标题：${report.title}`,
        `内容：${report.body || "（空）"}`,
        ...(report.result
          ? [
              `结构化结果：${report.result.status} · ${report.result.conclusion}`,
              report.result.artifacts.length > 0
                ? `产物：${report.result.artifacts.map((artifact) => artifact.relPath).join("、")}`
                : "产物：无",
            ]
          : []),
      ].join("\n");
    }

    const remembered = deps.memory?.get(id);
    if (remembered) {
      const when = new Date(remembered.createdAt).toISOString().slice(0, 10);
      return [
        `memory ${remembered.id}（${remembered.kind}）`,
        `记于 ${when} · 作用域 ${remembered.scopeType}` +
          `${remembered.scopeId ? ` ${remembered.scopeId}` : ""} · 来源 ${remembered.sourceType}` +
          `${remembered.sourceId ? ` ${remembered.sourceId}` : ""}`,
        `内容：${remembered.content}`,
      ].join("\n");
    }

    const event = threads.getEvent(id);
    if (event) {
      return [
        `event ${event.id} · ${event.source}/${event.kind}`,
        `分诊 ${event.triage}${event.threadId ? ` · 线 ${event.threadId}` : ""}`,
        `内容：${JSON.stringify(event.payload)}`,
      ].join("\n");
    }

    return `找不到 ${id}。可能是 id 打错了，或者那条记录已经不在了。`;
  };

  const closeLine = (threadId: string, summary: string) => {
    const thread = threads.getThread(threadId);
    if (!thread) return { ok: false, reason: `未知的线：${threadId}` };

    // 手上还有活就不收线（和外部结束信号同一条判据）。收了线，执行体会被 retire，
    // 而任务还在后台跑——它的汇报之后会落到一条已经结束的线上。
    const blocking = unfinishedTasksOf(tasks, threadId);
    if (blocking.length > 0)
      return { ok: false, reason: unfinishedReason(blocking) };

    threads.setState(threadId, "done");
    // Closing a line records its final summary for history; the preceding task
    // report is the user-facing result, so this must remain audit-only.
    threads.addReport({
      threadId,
      level: "silent",
      title: thread.title,
      body: summary,
    });
    for (const worker of threads.listWorkers(threadId)) {
      threads.unsubscribe(threadId, worker.id);
      threads.retireWorker(worker.id);
    }
    return { ok: true };
  };

  const askUser = (threadId: string | null, question: string) => {
    const target = threadId ?? threads.listActiveThreads(1)[0]?.id ?? null;
    if (!target)
      return {
        ok: false,
        reason: "没有可以挂靠的线；用 reply_to_user 直接说话",
      };
    const task =
      unfinishedTasksOf(tasks, target)[0] ?? tasks.latestForThread(target);
    // Questions belong to the conversation that can answer them. Keep the
    // durable report for audit/recovery, but do not put it in the legacy
    // A second inbox makes it easy to answer the wrong copy; the conversation
    // card is the only user-facing action surface.
    threads.addReport({
      threadId: target,
      ...(task ? { taskId: task.id } : {}),
      level: "silent",
      kind: "question",
      title: "需要你回复",
      body: question,
    });
    return { ok: true };
  };

  const dispatchLine = (input: OpenLineInput): OpenLineResult => {
    deps.onActivity?.("delegating");
    const result = deps.openLine(input);
    if (result.ok) deps.onActivity?.("working");
    else deps.onActivity?.("error");
    return result;
  };

  const openLine = (input: OpenLineInput): OpenLineResult => {
    const explicit = input.contract.attachments ?? [];
    const authorized = new Map(
      activeInputAttachments.map((attachment) => [attachment.path, attachment]),
    );
    const unauthorized = explicit.find(
      (attachment) => !authorized.has(attachment.path),
    );
    if (unauthorized) {
      return {
        ok: false,
        reason: `附件未获当前输入授权：${unauthorized.name}`,
      };
    }
    const byPath = new Map<string, ChatAttachmentRef>();
    for (const attachment of [...activeInputAttachments, ...explicit]) {
      if (!byPath.has(attachment.path)) byPath.set(attachment.path, attachment);
    }
    const result = dispatchLine({
      ...input,
      contract: {
        ...input.contract,
        ...(byPath.size > 0 ? { attachments: [...byPath.values()] } : {}),
      },
    });
    if (result.ok) openedLineThisTurn = true;
    return result;
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
  const remember = async (
    text: string,
    options?: { standing?: boolean; kind?: string; subject?: string },
  ) => {
    if (!deps.memory) return { ok: false, reason: "这个环境没有可用的记忆库" };
    const content = text.trim();
    if (!content) return { ok: false, reason: "内容是空的" };
    const tier = options?.standing ? ("standing" as const) : ("long" as const);
    let id: string;
    try {
      id = await deps.memory.remember({
        // 挂在**这个人**名下，不是挂在 'router' 名下：一条「以后结论放前面」是关于他的，
        // 执行体也得读得到。挂在自己名下的话，关于同一个人的偏好会被切成 N+1 份。
        ownerId: USER_MEMORY_OWNER,
        kind: (options?.kind as MemoryKind | undefined) ?? "preference",
        content,
        scope: { type: "personal" },
        sourceType: "manual",
        tier,
        // 有了 subject，改主意就是「用同一个名字再记一遍」，旧的自动留档——而不是
        // 库里同时躺着两条互相矛盾的要求。
        ...(options?.subject ? { subject: options.subject } : {}),
      });
      // Explicit remember calls are high-trust ontology evidence as well as
      // legacy memory rows. Keep the old API compatible while making the new
      // profile graph traceable to the originating statement.
      if (deps.contextGraph) {
        try {
          const user =
            deps.contextGraph.resolveEntity("user") ??
            deps.contextGraph.ensureEntity({
              id: "ontology-user",
              entityType: "User",
              canonicalName: "用户",
            });
          const episode = deps.contextGraph.appendEpisode({
            sourceType: "memory",
            sourceId: id,
            actor: "user",
            content,
          });
          if (options?.kind === "goal") {
            const goal = deps.contextGraph.ensureEntity({
              entityType: "Goal",
              canonicalName: content,
            });
            deps.contextGraph.assertFact({
              subjectEntityId: user.id,
              predicate: "has_goal",
              objectEntityId: goal.id,
              valueType: "entity",
              sourceEpisodeId: episode.id,
              confidence: 1,
            });
          } else {
            deps.contextGraph.assertFact({
              subjectEntityId: user.id,
              predicate: "prefers",
              objectValue: content,
              valueType: "text",
              sourceEpisodeId: episode.id,
              confidence: 1,
            });
          }
        } catch (error) {
          console.warn("[ontology] 写入显式记忆的本体断言失败", error);
        }
      }
    } catch (error) {
      // 常驻层满了、或者这条已经在里面了：把原因原样交回去，别让模型自己编一个。
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
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
    if (!deps.memory) return { ok: false, reason: "这个环境没有可用的记忆库" };
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
    if (!deps.memory) return { ok: false, reason: "这个环境没有可用的记忆库" };
    const lines = threads.listActiveThreads(5);
    const owners = recallOwners({});
    for (const thread of lines) owners.push(thread.id);

    const found = await deps.memory.retrieve({
      owners,
      query,
      scopes: [
        { type: "personal" },
        ...lines.map((thread) => ({ type: "thread" as const, id: thread.id })),
      ],
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
        openLine: (input) => {
          const target = input.replyTarget
            ? (activeReplyTargets.find(
                (candidate) => candidate.address === input.replyTarget,
              ) ?? null)
            : null;
          if (input.replyTarget && !target) {
            return {
              ok: false,
              reason: `当前输入没有这个回复地址：${input.replyTarget}`,
            };
          }
          const { replyTarget: _rawTarget, ...rest } = input;
          return openLine({
            ...rest,
            ...(target ? { replyTarget: target } : {}),
          });
        },
        reply,
        recall,
        lines,
        steerLine: (threadId, note) =>
          deps.steer?.(threadId, note) ??
          Promise.resolve({
            ok: false,
            reason: "这个环境不支持中途改方向",
            live: 0,
            queued: 0,
          }),
        askUser,
        closeLine,
        remember,
        forget,
        recallMemory,
        ontologyCommand: deps.ontologyCommand,
        workerCapabilities: deps.workerCapabilities,
        schedules: deps.schedules ? {
          create: (draft) => deps.schedules!.create(draft),
          list: () => deps.schedules!.list(),
          update: (id, patch) => deps.schedules!.update(id, patch),
          cancel: (id) => deps.schedules!.cancel(id),
        } : undefined,
        assistantTools: deps.assistantTools,
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
    deps.policy().semantic === "decision" && gate
      ? gate(events)
      : keepAll(events);

  /** 工作台的规矩：Router 也得知道这些，否则"规矩"只有干活的人知道。 */
  const rules = (): string[] =>
    deps.facts
      ? deps.facts
          .current([{ type: "global" }], 12)
          .map((fact) => fact.statement)
      : [];

  /**
   * 常驻约束：每轮都在场的那几条。
   *
   * 它**不经过检索**——「回答不要客套」不该因为这一轮的事件不相关就不出现。这正是
   * `07-memory.md` 公理 A4 的落地：必须每轮生效的东西不能依赖模型主动去取。
   */
  const standing = (): string[] => {
    const saved = deps.memory
      ? deps.memory.standing(USER_MEMORY_OWNER).map((item) => item.content)
      : [];
    const preferences = deps.personalPreferences?.();
    if (!preferences) return saved;
    const tone: Record<string, string> = {
      friendly: "友好自然",
      balanced: "自然平衡",
      professional: "专业正式",
    };
    const detail: Record<string, string> = {
      concise: "优先简洁，先给结论",
      balanced: "详略适中",
      detailed: "尽量充分展开并解释依据",
    };
    saved.unshift(
      `回复偏好：语气${tone[preferences.tone] ?? tone.balanced}；详略${detail[preferences.detail] ?? detail.balanced}。`,
    );
    if (preferences.instructions.trim())
      saved.unshift(`用户补充的回复偏好：${preferences.instructions.trim()}`);
    if (deps.contextGraph) {
      try {
        const pack = deps.contextGraph.contextPack("ontology-user", {
          maxHops: 2,
          maxAssertions: 16,
          maxTokens: 1800,
        });
        if (pack.assertions.length > 0) saved.push(pack.prompt);
      } catch (error) {
        console.warn("[ontology] 构建 Router 个人上下文失败", error);
      }
    }
    return saved;
  };

  const router = new Router({
    threads,
    ...(deps.faults ? { faults: deps.faults } : {}),
    prefilter: fastPath,
    semantic,
    rules,
    standing,
    deliver: async (text, targets = [], context = { attachments: [] }) => {
      activeReplyTargets = targets;
      activeInputAttachments = context.attachments;
      pendingResponse = null;
      openedLineThisTurn = false;
      try {
        await session.deliver(text);
        if (
          shouldRepairMissingReply(Boolean(pendingResponse), openedLineThisTurn)
        ) {
          await session.deliver(
            "协议修复：请立即调用 reply_to_user 提交至少一个 markdown block。不要输出普通文本。",
          );
        }
        if (!pendingResponse && openedLineThisTurn) {
          deps.streamReply?.({ type: "finish" });
          return;
        }
        const response = pendingResponse as RouterResponse | null;
        if (!response) {
          deps.faults?.recordSafely({
            kind: "router.protocol_error",
            severity: "error",
            subjectType: "router",
            summary: "Router 两轮都没有提交结构化最终回复。",
            detail: {},
          });
          await deps.reply({
            blocks: [
              {
                type: "markdown",
                text: "这次运行没有提交完整的最终结果，请稍后重试。",
              },
            ],
          });
          deps.streamReply?.({ type: "finish" });
          deps.onActivity?.("error");
          return;
        }
        const target = response.replyTarget
          ? activeReplyTargets.find(
              (candidate) => candidate.address === response.replyTarget,
            )
          : undefined;
        if (target && deps.externalReply) {
          await deps.externalReply(
            target,
            formatExternalReplyFromBlocks(response.blocks),
          );
          deps.onActivity?.("completed");
        } else {
          if (target)
            console.warn(
              "[router] 没有外部回复器，目标信道回退到桌面会话",
              target.address,
            );
          await deps.reply(response);
          deps.streamReply?.({ type: "finish" });
          deps.onActivity?.("completed");
        }
      } finally {
        activeReplyTargets = [];
        activeInputAttachments = [];
        pendingResponse = null;
        openedLineThisTurn = false;
      }
    },
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
      const fresh = bodyOf(payload);
      const objective =
        fresh?.trim() || intent.thread.goal || intent.thread.title;
      const result = dispatchLine({
        contract: {
          objective,
          deliverable: objective,
          outputs: [
            { kind: "text", description: "给出完成这条工作线后的简短结论。" },
          ],
          ...(intent.event.source === "im"
            ? attachmentsForPayload(payload)
            : {}),
        },
        title: intent.thread.title,
        threadKey: intent.thread.threadKey,
        workerId: intent.workerId,
        ...(replyTargetFromPayload(payload)
          ? { replyTarget: replyTargetFromPayload(payload) }
          : {}),
      });
      if (!result.ok) {
        console.warn(
          "[router] 直通失败，退回 Slow Path",
          intent.event.id,
          result.reason,
        );
        return false;
      }
      return true;
    },
  });

  return {
    router,
    session,
    tick: () => router.tick(),
    settle: () => session.settle(),
  };
}

/** Convert renderer-only content blocks to a portable external-channel reply. */
export function formatExternalReply(
  text: string,
  content?: readonly ChatContentBlock[],
): string {
  const parts = [withoutDesktopMediaUrls(text.trim())].filter(Boolean);
  for (const block of content ?? []) {
    if (block.type === "approval") {
      parts.push(`需要审批：${block.title}\n${block.body}`);
      continue;
    }
    if (block.type === "workflow") {
      parts.push(
        `${block.kind === "question" ? "需要回复" : "需要确认"}：${block.title}\n${block.body}`,
      );
      continue;
    }
    if (block.type === "ontologyApproval") {
      parts.push(`需要确认：${block.title}\n${block.body}`);
      continue;
    }
    if (block.type === "markdown") {
      if (block.text.trim())
        parts.push(withoutDesktopMediaUrls(block.text.trim()));
      continue;
    }
    const label =
      ("alt" in block && block.alt?.trim()) ||
      block.title?.trim() ||
      block.type;
    if (block.source.type === "url") {
      // Keep the original public URL. The opc-media proxy is local to the
      // desktop renderer and must never be sent to an external IM adapter.
      try {
        const url = new URL(block.source.url);
        if (url.protocol === "https:" || url.protocol === "http:") {
          parts.push(`[${label}](${url.href})`);
        } else {
          parts.push(`[${label}]`);
        }
      } catch {
        parts.push(`[${label}]`);
      }
    } else {
      parts.push(`[${label}] (${block.source.relPath})`);
    }
  }
  return parts.join("\n\n");
}

function formatExternalReplyFromBlocks(
  blocks: readonly ChatContentBlock[],
): string {
  return formatExternalReply("", blocks);
}

function attachmentsForPayload(
  payload: Record<string, unknown>,
): { attachments: ChatAttachmentRef[] } | Record<string, never> {
  const values = payload.attachments;
  if (!Array.isArray(values)) return {};
  const attachments = values.filter((value): value is ChatAttachmentRef => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<ChatAttachmentRef>;
    return (
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.path === "string" &&
      typeof item.size === "number" &&
      (item.source === "file" || item.source === "clipboard")
    );
  });
  return attachments.length > 0 ? { attachments } : {};
}

function withoutDesktopMediaUrls(value: string): string {
  return value.replace(/opc-media:\/\/[^\s)\]>"']+/gi, "[媒体仅在桌面可用]");
}

function replyTargetFromPayload(
  payload: Record<string, unknown>,
): TriggerReplyTarget | null {
  const value = payload.replyTarget;
  if (!value || typeof value !== "object") return null;
  const target = value as Partial<TriggerReplyTarget>;
  if (
    typeof target.adapterId !== "string" ||
    typeof target.source !== "string" ||
    typeof target.address !== "string" ||
    !target.address.trim()
  )
    return null;
  return {
    adapterId: target.adapterId,
    source: target.source as TriggerReplyTarget["source"],
    address: target.address,
    ...(typeof target.messageId === "string"
      ? { messageId: target.messageId }
      : {}),
  };
}

/**
 * Router 的 harness。
 *
 * 和执行体分开一个目录，原因不是洁癖：Router 的注册表里没有 bash、没有文件工具，
 * 而一个 harness 的注册表在打开时就固定了。混在一起，迟早会有一次派活让 Router
 * 拿到执行体的工具。
 */
async function openRouterHarness(
  deps: RouterHostDeps,
  registry: Registry,
): Promise<Harness> {
  const { Harness } = await import("@earendil-works/pi-durable");
  const { NodeExecutionEnv } =
    await import("@earendil-works/pi-durable/env/node");

  const context = await deps.context();
  const models = deps.modelConfig
    ? await deps.modelConfig.runtime.createModels()
    : (await import("@earendil-works/pi-ai/models")).createModels();

  return Harness.open(
    await openRouterStorage(path.join(deps.agentsDir, "router.sqlite")),
    {
      models,
      registry,
      ...(deps.modelConfig
        ? {
            settings: {
              compaction: {
                enabled: deps.modelConfig.getCompaction().enabled,
                reserveTokens: deps.modelConfig.getCompaction().reserveTokens,
                keepRecentTokens:
                  deps.modelConfig.getCompaction().keepRecentTokens,
                backgroundTokens:
                  deps.modelConfig.getCompaction().backgroundTokens,
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
