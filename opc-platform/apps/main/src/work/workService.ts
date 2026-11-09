import type {
  AttentionLevel,
  TaskStatus,
  ToolPolicy,
  LinkType,
  CreateTaskInput,
  CreateTaskResult,
  TaskContract,
  SubtaskDraft,
  TaskError,
  TaskRecord,
  TaskTrace,
  WorkReport,
  WorkTask,
  WorkThread,
} from '@opc/shared/domain';
import type {
  AgentCapability,
  CapabilityCatalog,
  WorkerStackInput,
  WorkerStackView,
} from '@opc/shared/ipc';
import type { Context } from '@earendil-works/chord/context';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import type { Conversation, Extension, Harness, Registry } from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSandboxExtension } from '../sandbox/extension';
import { createToolLimitExtension } from '../sandbox/toolLimit';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { FaultSink } from '../data/systemEventRepository';
import { messageOf } from '../data/systemEventRepository';
import { USER_ID } from '../data/schema';
import { TaskRepository, taskWorkspaceRelPath, type CreateTaskDraft } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import type { AppPaths } from '../env';
import type { McpServerConfig } from '../mcp/contract';
import { mountMcp, type McpMount } from '../mcp/extension';
import type { DecisionService } from '../models/decisionService';
import type { ImageService } from '../models/imageService';
import type { SpeechService } from '../models/speechService';
import type { MemoryService } from '../memory/memoryService';
import type { FactService } from '../memory/factService';
import { validateDecomposition } from './decomposition';
import type { ModelConfigService } from '../models/modelConfigService';
import { scriptedBrain, type TaskBrain } from './brain';
import { DurableWorkRunner } from './durableWorkRunner';
import { HarnessBrain } from './harnessBrain';
import { OwnerQueue } from './ownerQueue';
import { runtimeIdentityFor, type RuntimeIdentity } from './runtimeIdentity';
import { threadOutcomeFor } from './threadOutcome';
import { createTraceRecorder } from './trace';
import { recallOwners, USER_MEMORY_OWNER } from '../memory/owners';
import { SignalStore } from '../memory/signals';
import { subjectOfWorker, type RegistrySubject } from './registrySubject';
import { createDecomposeToolExtension } from './decomposeTool';
import { createDecisionToolExtension } from './decisionTool';
import { createImageToolExtension } from './imageTool';
import { createOcrToolExtension } from './ocrTool';
import { createSpeechToolExtension } from './speechTool';
import { createRememberToolExtension } from '../memory/rememberTool';
import { buildRecords, type RecordSource } from './records';
import { ensureDir, listWorkspaceFiles } from './workspace';
import { createInvestigateToolExtension } from './investigateTool';
import { AssistantEntry, configure } from '@earendil-works/pi-durable';
import {
  countEscalations,
  createEscalateToolExtension,
  createHandBackToolExtension,
  escalationLevel,
  escalationTag,
} from './escalateTool';
import { buildSubagentPrompt, type SubagentAnswer, type SubagentToolApi } from './subagent';
import { createTraceExtension } from './trace';
import { registerApprovalBridge } from '../mcp/approval';
import { priceUsage } from './usage';
import { registerSandboxWorkspace } from '../sandbox/workspaces';
import { createRecallToolExtension, type RecallOutcome } from './recallTool';
import { bodyOf } from '../router/triage';
import { recallView } from '../router/inline';
import { setWorkTaskServices, WorkTaskDefinition } from './workTaskDefinition';
import {
  EMPTY_TOOL_POLICY,
  filterExtensionTools,
  isExtensionEnabled,
  isToolActive,
  isToolEnabled,
  normalizeToolPolicy,
} from './toolPolicy';
import { resolveWorkerModelRef } from '../models/workerModel';
import type { NetworkClient } from '../network/networkClient';
import type { OcrEngine } from '../ocr/service';
import { RuntimeService } from '../runtime/service';
import type { PiExtensionHost } from '../extensions/host';
import type { PiSkillHost } from '../skills/host';
import { createSkillsExtension } from '../skills/extension';
import type { ContextGraphStore } from '../ontology/types';
import type { BrowserBroker } from '../browser/broker';
import { createBrowserToolExtension } from './browserTool';
import { createDesktopToolExtension } from './desktopTool';
import type { DesktopBroker } from '../desktop/broker';

/** How many manager rework rounds a task may take before it is parked for you. */

/** Which work task each employee is executing right now (for tools that need it). */
const runningTaskByEmployee = new Map<string, string>();

function legacyContract(input: CreateTaskInput): TaskContract {
  const objective = input.brief?.trim() || input.deliverableSpec?.trim() || input.title;
  const deliverable = input.deliverableSpec?.trim() || input.title;
  const command = input.acceptanceCommand?.filter((part) => part.trim().length > 0) ?? [];
  return {
    objective,
    deliverable,
    outputs: [],
    ...(command.length > 0 || input.acceptanceTemplate
      ? { acceptance: { command, ...(input.acceptanceTemplate ? { template: input.acceptanceTemplate } : {}) } }
      : {}),
  };
}

function contractOf(task: Pick<WorkTask, 'contract' | 'brief' | 'deliverableSpec'>): TaskContract {
  return task.contract ?? { objective: task.brief, deliverable: task.deliverableSpec, outputs: [] };
}

function currentTaskIdFor(ownerId: string): string | undefined {
  return runningTaskByEmployee.get(ownerId);
}

interface EmployeeHarness {
  harness: Harness;
  root: Conversation;
  /** Several runtimes can belong to one person once workers exist. */
  ownerId: string;
}


/**
 * One installable capability group.
 *
 * `extension` is present only when the runtime can actually support it. A slot
 * with `available: false` is what the stack page renders greyed out with a
 * reason code, so "why can't this employee draw?" has one answer for both the UI
 * and the registry.
 */
interface ToolSlot {
  name: string;
  /** Core groups cannot be switched off wholesale (their tools still can). */
  essential: boolean;
  available: boolean;
  reason?: string;
  extension?: Extension;
}

export interface WorkServiceDeps {
  db: CompanyDatabase;
  /** Shared thread repository used by the chat/router lifecycle observers. */
  threads?: ThreadRepository;
  /** 系统故障的去处（`system_event`）。没有就只打到控制台。 */
  faults?: FaultSink;
  paths: AppPaths;
  /** Injects / updates the task card in the conversation. */
  upsertTaskCard: (task: WorkTask) => void;
  /** Delivers an interactive approval to the Router chat. */
  onApprovalCard?: (input: { report: WorkReport; task: WorkTask; tool: string; browser?: { action: string; url?: string; preview?: string; sessionId?: string }; desktop?: { action: string; appId?: string; windowId?: string; preview?: string; sessionId?: string } }) => void;
  onApprovalResolved?: (reportId: string, state: 'allowed' | 'denied') => void;
  modelConfig?: ModelConfigService;
  images?: ImageService;
  /** Speech recognition / synthesis; each tool is installed only when usable. */
  speech?: SpeechService;
  /**
   * 接入的 MCP 服务器（`mcp.json` 那一份）。空 = 没有外部能力。
   *
   * 挂载点在建注册表时：pi 的 deferred 工具是**注册表里的东西**，不是运行时凭空长出来的。
   */
  mcp?: () => readonly McpServerConfig[];
  /** Structured decisions (Jev / System One); absent = no `decide` tool. */
  decisions?: DecisionService;
  memory?: MemoryService;
  facts?: FactService;
  contextGraph?: ContextGraphStore;
  /** Colleague messaging (F5); absent = employees cannot talk to each other. */
  /** Proxy policy for spawned commands (acceptance scripts, git/npm). */
  network?: NetworkClient;
  /** Company-wide base environment; absent = build one from `paths` + `network`. */
  runtime?: RuntimeService;
  /** Image → text (OCR) for employees whose model has no vision. */
  ocr?: OcrEngine;
  /**
   * Pi coding-agent extensions found on disk. Absent in probes and tests, which
   * is why every use below is optional.
   */
  piExtensions?: PiExtensionHost;
  /** `SKILL.md` folders found on disk; same optionality as above. */
  piSkills?: PiSkillHost;
  /** Wakes the Router after a worker report is committed. */
  wakeRouter?: () => void;
  /** Optional native browser capability. It is deliberately not an MCP server. */
  browser?: BrowserBroker;
  /** Optional native desktop computer-use capability. */
  desktop?: DesktopBroker;
}

/**
 * Orchestrates work: business state in SQLite, execution in the employee's
 * durable pi task, and a live event stream for the UI.
 *
 * Crash safety is the point of this class: nothing runs as an un-tracked promise,
 * and startup reconciles whatever the previous process left behind.
 */
export class WorkService {
  private readonly repository: TaskRepository;
  private readonly runner: DurableWorkRunner;
  private readonly listeners = new Set<(task: WorkTask) => void>();
  private readonly harnesses = new Map<string, EmployeeHarness>();
  /** Employees whose stack changed while a task was running; evicted when it ends. */
  private readonly dirtyHarnesses = new Set<string>();
  /** Last status each task reported to its thread, so one outcome is not announced twice. */
  private readonly reportedThreads = new Map<string, TaskStatus>();
  /** Threads already warned about their ceiling; the warning is not a metronome. */
  private readonly warnedThreads = new Set<string>();
  /** 一个执行体一条队：同一执行体的任务串行跑（`ownerQueue.ts`）。 */
  private readonly queue: OwnerQueue;
  private readonly runtime: RuntimeService;
  /** Owned here rather than injected: nine construction sites, one dependency. */
  private readonly threads: ThreadRepository;
  /**
   * 偏好信号的收集箱。
   *
   * 返工理由和改方向的 note 是**用户表达偏好最强的两个时刻**，以前都被冲掉了：
   * 前者被拼进下一版任务的 brief，后者只影响那一次重试。收下来是为了让后置的抽取
   * 管线（`memory/extraction.ts`）有机会把它们变成记忆。
   */
  private readonly signals: SignalStore;
  /**
   * 已经交回的线。
   *
   * 交回之后，这条任务的结束**不许**再改线的状态：线已经回到 `open` 等别人接手，
   * 而一次"跑完了/跑挂了"的汇报会把它重新按成 done/failed——那等于交回没发生。
   * 和 `reportedThreads` 一样是进程内的：它记的是"这一次运行里发生过什么"。
   */
  private readonly handedBack = new Set<string>();
  /** 每个执行体看到的 MCP 服务器状态（栈页面据此说"接了几个、哪个没连上"）。 */
  readonly mcpServers = new Map<string, { name: string; tools: number; resources: number; error?: string }[]>();
  /**
   * 每个执行体一份 MCP 挂载。
   *
   * 缓存而不是每次现连：`toolSlots` 会被栈页面、`capabilities`、建注册表三条路调用，
   * 而连接本身是进程级共享的——真正要省的是"每次重新读一遍目录"。
   */
  private readonly mcpMounts = new Map<string, Promise<McpMount>>();
  /**
   * The model-driven brain, when a model is configured. Kept as a field（不是构造
   * 函数里的临时变量）because 你中途改方向要能插进**正在跑**的那个会话，而那个
   * 会话只有 brain 自己认识。
   */
  private readonly modelBrain: HarnessBrain | null;

  constructor(private readonly deps: WorkServiceDeps) {
    this.repository = new TaskRepository(deps.db);
    deps.browser?.setTaskWorkspaceResolver((taskId) => {
      const task = this.repository.getTask(taskId);
      return task ? path.resolve(this.deps.paths.workspaceDir, task.workspaceRelPath) : undefined;
    });
    deps.browser?.setArtifactRegistrar((taskId, absolutePath) => {
      const task = this.repository.getTask(taskId);
      if (!task) return;
      const root = path.resolve(this.deps.paths.workspaceDir, task.workspaceRelPath);
      const resolved = path.resolve(absolutePath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('浏览器产物越过任务工作区');
      if (!fs.existsSync(resolved)) throw new Error('浏览器产物文件不存在');
      this.repository.addArtifact(taskId, path.relative(root, resolved), resolved);
    });
    this.threads = deps.threads ?? new ThreadRepository(deps.db);
    this.signals = new SignalStore(deps.db);

    // One environment for the whole company: every tool call and acceptance
    // command resolves `node` / `python` through this service.
    this.runtime =
      deps.runtime ??
      new RuntimeService(deps.db, {
        userDataDir: deps.paths.userData,
        ...(deps.network ? { network: deps.network } : {}),
      });


    // The real loop: HarnessBrain drives pi's generation/tool tasks. Without a
    // configured model we fall back to the deterministic brain so the app still works.
    this.modelBrain = deps.modelConfig
      ? new HarnessBrain({
          harnessFor: (identity) => this.harnessFor(identity),
          context: () => getBackgroundContext(),
          model: (identity) =>
            resolveWorkerModelRef({
              worker: this.threads.getWorker(identity.runtimeKey),
              modelConfig: deps.modelConfig,
            }),
          thinking: () => deps.modelConfig?.getThinking() ?? 'medium',
          price: (ref) => {
            const provider = deps.modelConfig?.listProviders().find((entry) => entry.id === ref.providerId);
            const model = provider?.models.find((entry) => entry.id === ref.modelId);
            return {
              inputUsdPerM: model?.inputUsdPerM ?? 0,
              outputUsdPerM: model?.outputUsdPerM ?? 0,
            };
          },
          onTokens: (taskId, tokens) => this.repository.addTokens(taskId, tokens),
          // 动作流（W6）：工具调用、失败、用量都落 `task_trace`，Router 不读它。
          trace: (taskId) => createTraceRecorder({ repository: this.repository, taskId }),
          // 动作级审批（M3）：MCP 的 hook 按扩展装，桥按任务挂。
          registerApproval: (conversationId, taskId) =>
            registerApprovalBridge(conversationId, {
              taskId: () => taskId,
              hasPermit: (id, tool) => this.repository.hasMcpPermit(id, tool),
              ask: (input) => this.askForApproval(input),
            }),
        })
      : null;

    this.runner = new DurableWorkRunner({
      repository: this.repository,
      workspaceRoot: deps.paths.workspaceDir,
      checksRoot: path.join(deps.paths.userData, 'checks'),
      harnessFor: (identity) => this.harnessFor(identity),
      context: () => getBackgroundContext(),
      onTaskChanged: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (task) {
          if (task.status === 'running') this.setWorkerRuntimeStatus(task, 'running');
          this.emit(task);
        }
      },
      isApprovalPending: (taskId) => {
        const task = this.repository.getTask(taskId);
        return task?.threadId
          ? this.threads.listReportsOf(task.threadId, 50)
              .some((report) => report.taskId === taskId && report.kind === 'approval' && report.readAt === null)
          : false;
      },
      onResumed: () => undefined,
      onFinished: (taskId, outcome, result) => {
        // Native desktop sessions are task-scoped. Close them as soon as the
        // durable task settles so profiles and accessibility handles do not
        // accumulate until the idle sweeper runs.
        if (this.deps.desktop) void this.deps.desktop.disposeTask(taskId);
        // 放行条属于那条正在跑的活：活收尾了它就没有意义（下一次要重新问）。
        this.repository.clearMcpPermits(taskId);
        const finishedEmployees: string[] = [];
        for (const [ownerId, running] of runningTaskByEmployee) {
          if (running === taskId) {
            runningTaskByEmployee.delete(ownerId);
            finishedEmployees.push(ownerId);
          }
        }
        // A stack change made while this task was running is applied now: the next
        // task must open a harness with the new registry, not keep the old one.
        for (const ownerId of finishedEmployees) {
          if (this.dirtyHarnesses.delete(ownerId)) void this.evictRuntime(ownerId);
        }
        const task = this.repository.getTask(taskId);
        if (task && ['delivered', 'accepted', 'rejected', 'cancelled', 'failed'].includes(task.status)) {
          this.setWorkerRuntimeStatus(task, 'idle');
        }
        // A session that failed at the storage layer is closed for good; keeping it
        // cached would make every later run of this employee fail with "Harness is closed".
        if (outcome === 'faulted' && task) {
          this.harnesses.delete(runtimeIdentityFor(task).runtimeKey);
        }
        const passed = outcome === 'completed' && result?.verdict === 'pass';

        /*
         * 这里本来有一次 `memory.remember`：每通过一次验收就写一条
         * 「任务《X》通过验收。交付物：… 要求：…」，挂在线上，kind = experience。
         *
         * 它被删掉了，因为它是**日志冒充记忆**：内容与 `report` 表里那条一模一样，而
         * 它读起来是"发生过什么"，不是"下次该怎么做"。真实库上这一类攒了 185 条，把
         * 真正的偏好淹在下面——用户看一眼的结论是"脏数据"。
         *
         * 判据回到公理 A1：**记忆的单位不是事实，是被替代掉的决策**。这条记录替代不了
         * 任何决策，它只是一份副本。
         */

        if (!passed && task?.isReview && task.reviewOfTaskId) {
          // The reviewer never produced a verdict: surface it instead of leaving the
          // reviewed task stuck in `review` forever.
          this.repository.setStatus(task.reviewOfTaskId, 'rejected', {
            finishedAt: Date.now(),
            error: `负责人验收未完成（${result?.reason ?? outcome}）`,
          });
          const original = this.repository.getTask(task.reviewOfTaskId);
          if (original) this.emit(original);
        }

        // Last thing, so the status the thread hears about is the settled one.
        this.reportToThread(taskId);
        if (task?.reviewOfTaskId) this.reportToThread(task.reviewOfTaskId);
        this.deps.wakeRouter?.();
      },
    });

    setWorkTaskServices({
      recallMemories: this.deps.memory
        ? async (task) => {
            // 两个作用域就够了：这条线自己的经验，和这个执行体自己的习惯。
            // 中间那一层（部门）早就没了，也不该再有。
            // 三个域并列：这个人的偏好、这条线的经验、这个执行体自己的习惯。
            // 以前只查「这个执行体自己的」，于是 Router 记下的用户偏好，干活的人永远看不到。
            const scopes = [
              { type: 'personal' as const },
              ...(task.threadId ? [{ type: 'thread' as const, id: task.threadId }] : []),
            ];
            const snippets = await this.deps.memory!.retrieve({
              owners: recallOwners({ threadId: task.threadId, workerId: task.assigneeId }),
              query: `${task.title} ${task.brief}`,
              scopes,
              limit: 5,
            });
            // 做事规矩走自己那条通道（`recallProcedural`），这里滤掉——同一条要求
            // 在提示词里出现两遍，模型会当成两条。
            return snippets
              .filter((snippet) => snippet.kind !== 'format' && snippet.kind !== 'workflow')
              .map((snippet) => ({
                kind: snippet.kind,
                content: snippet.content,
                scopeType: snippet.scopeType,
              }));
          }
        : undefined,
      recallOntology: this.deps.contextGraph
        ? (task) => {
            const graph = this.deps.contextGraph!;
            // Materialize stable business ids as graph entities at read time;
            // task/worker tables remain authoritative and this projection is
            // idempotent, bounded, and evidence-backed.
            const user = graph.resolveEntity('ontology-user')!;
            const taskEntity = graph.ensureEntity({ id: `ontology-task-${task.workTaskId}`, entityType: 'Task', canonicalName: task.title, description: task.brief });
            const workerEntity = graph.ensureEntity({ id: `ontology-worker-${task.assigneeId}`, entityType: 'Worker', canonicalName: task.assigneeId });
            const episode = graph.appendEpisode({ sourceType: 'runtime.context', sourceId: task.workTaskId, actor: 'system', content: `${task.title}\n${task.brief}` });
            graph.assertFact({ subjectEntityId: user.id, predicate: 'has_task', objectEntityId: taskEntity.id, valueType: 'entity', sourceEpisodeId: episode.id });
            graph.assertFact({ subjectEntityId: user.id, predicate: 'has_worker', objectEntityId: workerEntity.id, valueType: 'entity', sourceEpisodeId: episode.id });
            graph.assertFact({ subjectEntityId: taskEntity.id, predicate: 'assigned_to', objectEntityId: workerEntity.id, valueType: 'entity', sourceEpisodeId: episode.id });
            return graph.contextPack('ontology-user', {
              query: `${task.title} ${task.brief}`,
              maxHops: 2,
              maxAssertions: 16,
              maxTokens: 1800,
            }).prompt;
          }
        : undefined,
      /**
       * 做事规矩：`format` / `workflow` 那两类记忆。
       *
       * 这条通道不看相关度、不看衰减——**约束不应该按相关度筛**。「结论放前面」在任何
       * 一次产出里都成立，而它和任务标题字面上几乎不重叠，靠检索基本捞不到。学习回路
       * 断的就是这一跳：记忆存下来了，执行体的提示词里没有它，于是第四次还在犯。
       */
      recallProcedural: this.deps.memory
        ? async (task) =>
            this.deps.memory!
              .procedural(
                recallOwners({ threadId: task.threadId, workerId: task.assigneeId }),
              )
              .map((item) => ({ kind: item.kind, content: item.content }))
        : undefined,
      // 常驻约束：和谁在干活无关，它讲的是"这个人要求过什么"。
      recallStanding: this.deps.memory
        ? async () => this.deps.memory!.standing(USER_MEMORY_OWNER).map((item) => ({ content: item.content }))
        : undefined,
      /**
       * 原始记录：这条线上的事件、之前的汇报、之前跑过的任务。
       *
       * 这是 E1 的全部意义。以前执行体只看到 `brief = goal`——Router 用自己的话把目标
       * 重写了一遍，执行体拿到的是转述。转述是有损的，而且当 Router 理解偏了，执行体
       * 是唯一有机会发现的人，却手里没有原文。
       *
       * 只给 ID + 摘要：全文留在库里，`recall` 随时能取。
       */
      recallRecords: (task) =>
        task.threadId ? this.recordsOfThread(task.threadId, task.taskId) : [],
      recallFacts: this.deps.facts
        ? async (task) => {
            // 规定挂在**这条线**上；工作台那一层（global）永远都在，它讲的是这个助手
            // 本身该守的规矩。
            const scopes = [
              { type: 'global' as const },
              ...(task.threadId ? [{ type: 'thread' as const, id: task.threadId }] : []),
            ];
            return this.deps.facts!.current(scopes).map((fact) => ({
              statement: fact.statement,
              scopeType: fact.scopeType,
            }));
          }
        : undefined,
      brain: (process.env.OPC_BRAIN_VARIANT ? scriptedBrain : (this.modelBrain ?? scriptedBrain)) as TaskBrain,
      fallbackBrain: scriptedBrain,
      repository: this.repository,
      recordDurableStep: (taskId, text) => this.recordDurableStep(taskId, text),
      approvalReport: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (!task?.threadId) return null;
        return this.threads.listReportsOf(task.threadId, 50).find(
          (report) => report.taskId === taskId && report.kind === 'approval' && report.readAt === null,
        ) ?? null;
      },
      approvalPending: (taskId, reportId) => {
        if (reportId) {
          const report = this.threads.getReport(reportId);
          return report?.kind === 'approval' && report.readAt === null;
        }
        const task = this.repository.getTask(taskId);
        return task?.threadId
          ? this.threads.listReportsOf(task.threadId, 50)
              .some((report) => report.taskId === taskId && report.kind === 'approval' && report.readAt === null)
          : false;
      },
      onTaskChanged: (taskId) => {
        const task = this.repository.getTask(taskId);
        if (task) this.emit(task);
      },
      network: this.deps.network,
      runtime: this.runtime,
    });

    /**
     * 一个执行体一条队（`ownerQueue.ts`）。
     *
     * 入队时**不**判 `refuseToStart`：它查的是"有没有模型、前置任务完成没有"，
     * 而排队本身可能要等上几分钟，等轮到自己时那个前置可能已经跑完了。判在开跑
     * 那一瞬间才对。
     */
    this.queue = new OwnerQueue({
      run: (taskId) => {
        if (this.refuseToStart(taskId)) return Promise.resolve();
        const task = this.repository.getTask(taskId);
        if (task) runningTaskByEmployee.set(task.assigneeId, taskId);
        return this.runner.run(taskId);
      },
      onError: (taskId, error) => {
        if (this.deps.desktop) void this.deps.desktop.disposeTask(taskId);
        // 记账这一步本身可能失败（库已经关了、盘满了），而它失败不该再抛一次：
        // 一次没记上的失败会以 unhandled rejection 结束整个进程，而真正的问题是
        // 原来那个 error——它就在下面这行里。
        try {
          this.repository.addStep(
            taskId,
            `启动失败：${error instanceof Error ? error.message : String(error)}`,
          );
          this.repository.setStatus(taskId, 'failed', { finishedAt: Date.now(), error: String(error) });
          const failed = this.repository.getTask(taskId);
          if (failed) {
            // `runner.run()` marks the worker running before opening its harness.
            // If that bootstrap throws, there is no durable `onFinished` callback
            // to return the roster to idle, so settle it here with the task row.
            this.setWorkerRuntimeStatus(failed, 'idle');
            this.emit(failed);
          }
        } catch (recordError) {
          console.error('记失败这一步也失败了', recordError);
        }
        console.error('task run failed', error);
        // 任务跑挂是 Watchdog 最该知道的一类事：它现在能从库里读到，
        // 而不是只能从某一行日志里被偶然发现。
        this.deps.faults?.recordSafely({
          kind: 'work.run_failed',
          severity: 'error',
          subjectType: 'task',
          subjectId: taskId,
          summary: `任务启动/运行失败：${messageOf(error)}`,
          detail: { taskId },
        });
      },
    });
  }

  listTasks = (limit?: number): WorkTask[] => this.repository.listTasks(limit);

  /** 未结束的活：Watchdog 每分钟体检一次的对象。 */
  listPending = (): WorkTask[] => this.repository.listPending();

  /** Everything, newest first — the issue list needs the whole set, not a page. */
  listAllTasks = (limit = 500): WorkTask[] => this.repository.listTasks(limit);

  /** One-time backfill for rows created before issue keys existed. */
  backfillIssueKeys = (): number => this.repository.ensureIssueKeys();

  linkTasks = (fromId: string, toId: string, type: LinkType = 'blocks'): WorkTask => {
    this.repository.link(fromId, toId, type);
    return this.repository.getTask(toId) as WorkTask;
  };

  unlinkTasks = (fromId: string, toId: string, type: LinkType = 'blocks'): WorkTask => {
    this.repository.unlink(fromId, toId, type);
    return this.repository.getTask(toId) as WorkTask;
  };

  /** Edits the issue fields you owns (priority / labels / due date). */
  setIssueMeta = (
    taskId: string,
    patch: { priority?: WorkTask['priority']; labels?: string[]; dueAt?: number | null },
  ): WorkTask => {
    this.repository.setIssueMeta(taskId, patch);
    const updated = this.repository.getTask(taskId) as WorkTask;
    this.emit(updated);
    return updated;
  };

  getTask = (taskId: string): WorkTask | undefined => this.repository.getTask(taskId);

  listSubtasks = (taskId: string): WorkTask[] => this.repository.listChildren(taskId);

  /**
   * 动作流（`09-worker-spec.md` W6）。
   *
   * 界面与 `recall task:<id>` 读它；**Router 的调度不读**——过程进 Router 的输入，
   * 就等于让 Router 变成日志消费者。默认 40 条够答"它现在在干什么"。
   */
  listTrace = (taskId: string, limit = 40): TaskTrace[] =>
    this.repository.listTrace(taskId, limit);

  listReviews = (taskId: string): WorkTask[] => this.repository.listReviews(taskId);

  /**
   * Third and last acceptance: you. Only a task the system and the manager
   * both passed can be signed off, so you is judging a finished deliverable.
   */
  userDecision = (taskId: string, decision: 'approve' | 'reject', reason?: string): WorkTask => {
    const task = this.repository.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'accepted') throw new Error(`当前状态不能终审：${task.status}`);

    const approve = decision === 'approve';
    const note = reason?.trim() || (approve ? '你确认交付' : '你否决');
    this.repository.addAcceptance(
      taskId,
      {
        verdict: approve ? 'pass' : 'fail',
        reason: `你终审：${note}`,
        evidence: { command: [USER_ID, decision], exitCode: approve ? 0 : 1, stdoutTail: note, stderrTail: '', durationMs: 0 },
      },
      USER_ID,
    );
    this.repository.setStatus(taskId, approve ? 'delivered' : 'rejected', {
      finishedAt: Date.now(),
      error: approve ? null : `你否决：${note}`,
    });
    const updated = this.repository.getTask(taskId) as WorkTask;
    this.emit(updated);
    // You just settled it: the line of work hears the final answer, not the
    // interim "awaiting sign-off" one.
    this.reportedThreads.delete(taskId);
    this.reportToThread(taskId);
    return updated;
  };

  /**
   * 你在活还没干完时改方向（§8.2「随时介入」在双层架构里的落点）。
   *
   * 两件事一起做，因为它们覆盖的是两个不同的时刻：
   *
   * - **正在跑**的活：把话插进它的会话（pi 的 inbox，`steer` 模式，下一个 boundary
   *   生效），这一轮就能看到；
   * - **还没开跑 / 要重试**的活：写进 `task.steering`。`produce` 每次尝试都重新读
   *   任务，所以下一轮一定带上。
   *
   * 两条都覆盖不到的情形只有一种：这条线上的活已经到终态。那时该做的是开一条新线，
   * 而不是改一条已经收尾的线——所以这里如实拒绝，让 Router 去 open_line。
   */
  steerThread = async (
    threadId: string,
    note: string,
  ): Promise<{ ok: boolean; reason?: string; live: number; queued: number }> => {
    const text = note.trim();
    if (!text) return { ok: false, reason: '改方向总得说清楚改什么', live: 0, queued: 0 };

    const thread = this.threads.getThread(threadId);
    if (!thread) return { ok: false, reason: `未知工作线：${threadId}`, live: 0, queued: 0 };

    const open = this.repository.listPending().filter((task) => task.threadId === threadId);
    if (open.length === 0) {
      // 说清楚"为什么改不了"，而不是一句通用的拒绝：你下一步该做什么，取决于
      // 这条活停在哪——还在排队、在等验收、还是已经收尾了。
      const latest = this.repository.latestForThread(threadId);
      const reason =
        latest && (latest.status === 'review' || latest.status === 'delivered')
          ? `这条线上的活正在等验收（${latest.status}）：要改方向就让它重做，别在验收里改`
          : latest
            ? `这条线上的活已经收尾了（${latest.status}），改方向要从新的一条线开始`
            : '这条线上还没有任务：先开一条线，再改它的方向';
      return { ok: false, reason, live: 0, queued: 0 };
    }

    // 中途改方向同样是"原来的方向错了"的直接证据——和返工理由一起进收集箱。
    this.signals.record({ origin: 'steering', threadId, text });

    let live = 0;
    for (const task of open) {
      this.repository.addSteering(task.id, text);
      // 时间线上留一行：你会想知道这句话到底有没有被带到。
      this.repository.addStep(task.id, `你改方向：${text}`);
      if (this.modelBrain && (await this.modelBrain.interject(task.id, text))) live += 1;
    }
    this.threads.touch(threadId);
    return { ok: true, live, queued: open.length - live };
  };

  /**
   * 它要做一件可能造成后果的事（M3）。
   *
   * 和 `escalateFor` 是同一张桌子上的两句话，但不是同一句：那个问的是"我该怎么做"，
   * 这个问的是"我能不能做"。所以它落 `kind: 'approval'`，收件动词是**允许 / 不允许**，
   * 而不是回答一句话。
   *
   * 等级一律 `decide`：拦住一次已经够贵了（它得换个做法或者停在那儿），再降级就等于
   * 让人永远看不到自己被拦住过。
   */
  askForApproval = (input: { taskId: string; tool: string; title: string; browser?: { action: string; url?: string; preview?: string; sessionId?: string }; desktop?: { action: string; appId?: string; windowId?: string; preview?: string; sessionId?: string } }): void => {
    const task = this.repository.getTask(input.taskId);
    if (!task?.threadId) return;
    this.repository.addStep(task.id, `要你点头：${input.title}`);

    // 同一件活、同一个工具只问一次：问第二遍是噪音（和 escalate 那条规则同一个理由）。
    // 按 `subject` 判，不按标题：标题是写给人看的那句话。
    const already = this.threads.pendingApproval(task.id, input.tool);
    if (already) return;

    const report = this.threads.addReport({
      threadId: task.threadId,
      // The report is retained for audit and card recovery, but approvals are
      // delivered through the Router chat instead of the attention queue.
      level: 'silent',
      title: `要你点头：${input.title}`,
      body: [
        `它要调 ${input.tool}，这类工具会改动东西或者伸到外面去。`,
        `（${task.title} · ${task.id}）`,
        `允许之后，这件活里这个工具不再问你；换一件活会重新问。`,
      ].join('\n'),
      taskId: task.id,
      // 放行要落回到**这个工具**上，所以它必须是一列，不是标题里的一段话。
      subject: input.tool,
      kind: 'approval',
    });
    this.threads.setState(task.threadId, 'waiting');
    try {
      this.deps.onApprovalCard?.({ report, task, tool: input.tool, ...(input.browser ? { browser: input.browser } : {}), ...(input.desktop ? { desktop: input.desktop } : {}) });
    } catch (error) {
      // A renderer/chat delivery problem must not turn a valid approval pause
      // into a failed task. The report remains available for recovery.
      console.warn('approval card delivery failed', error);
    }
    const updated = this.repository.getTask(task.id);
    if (updated) this.emit(updated);
  };

  /**
   * 回答执行体的请示（W3）。
   *
   * 在这之前它没有收件动词：请示落到队列里，和"活干完了请你验收"长得一模一样，而你能
   * 按的只有**认可**（把活标成通过）和**返工**（重开一件活）。两个都回答不了一句问句。
   *
   * 回答必须回到**问它的那件活**上，而且要覆盖两种时刻：
   *
   * - 还在跑：插进它正在跑的那个会话，这一轮就能看到（`interject`）；
   * - 还没开跑 / 要重试：写进 `task.steering`，下一次尝试一定带上；
   * - **已经收尾**：答案不能烂在地里——开一件新的活带上它（等价于"带着意见再做一次"）。
   */
  answerFor = async (input: {
    reportId: string;
    text: string;
    /** 审批行才有意义：允不允许。`question` 行不看它。 */
    allow?: boolean;
  }): Promise<
    { ok: true; delivered: 'live' | 'next-attempt' | 'new-task' } | { ok: false; error: string }
  > => {
    const text = input.text.trim();
    // 审批行可以只点「允许」不写字；请示行必须有内容。
    if (!text && input.allow === undefined) return { ok: false, error: '回答不能是空的' };

    const report = this.threads.getReport(input.reportId);
    if (!report) return { ok: false, error: `找不到这条请示：${input.reportId}` };
    if (report.kind === 'report') {
      return { ok: false, error: '这条是汇报不是请示：要表态就用认可或返工' };
    }
    if (!report.taskId) return { ok: false, error: '这条请示没记下是哪件活问的' };

    const task = this.repository.getTask(report.taskId);
    if (!task) return { ok: false, error: '问这个问题的那件活已经不在了' };

    if (report.kind === 'approval') {
      if (!report.subject) return { ok: false, error: '这条审批没记下是哪个工具' };
      return this.resolveApproval({ report, task, tool: report.subject, text, allow: input.allow === true });
    }

    const question = report.title.replace(/^请示：/, '');
    this.threads.markReportRead(report.id);

    if (task.status !== 'open' && task.status !== 'running') {
      const threadId = task.threadId;
      if (!threadId) return { ok: false, error: '这条请示不在任何工作线上' };
      const created = this.decideThread(threadId, 'rework', `你回答了他请示的问题：${text}`);
      return created.ok
        ? { ok: true, delivered: 'new-task' }
        : { ok: false, error: created.error };
    }

    const note = `回答（我问的「${question}」）：${text}`;
    this.repository.addSteering(task.id, note, 'answer');
    this.repository.addStep(task.id, `你回答了请示：${text}`);
    const live =
      this.modelBrain !== null &&
      (await this.modelBrain.interject(
        task.id,
        `「${question}」——${text}`,
        { label: '他回答了你请示的问题（照这个做，不要再问一遍）：', kind: 'answer' },
      ));

    // 它不再"在等人做决定"了。
    if (task.threadId) this.threads.setState(task.threadId, 'running');
    const updated = this.repository.getTask(task.id);
    if (updated) this.emit(updated);
    return { ok: true, delivered: live ? 'live' : 'next-attempt' };
  };

  /**
   * 你点了「允许」或「不允许」（M3）。
   *
   * 允许 = 落一张放行条（这件活 × 这个工具），并把这句话插进它正在跑的那个会话——
   * 它被拦下时已经换了做法，不告诉它就等于放行条没人用。不允许 = 只告诉它别再试，
   * 不落条：它该做的是换路子或者停下来，而不是过一会儿再问一遍。
   */
  private async resolveApproval(input: {
    report: WorkReport;
    task: WorkTask;
    tool: string;
    text: string;
    allow: boolean;
  }): Promise<
    { ok: true; delivered: 'live' | 'next-attempt' | 'new-task' } | { ok: false; error: string }
  > {
    const { report, task, tool, text, allow } = input;
    if (report.readAt !== null) {
      // A card can outlive the report resolution (for example after a renderer
      // reload or a duplicate click). Treat the operation as idempotent, but
      // still notify the chat so the stale card is removed instead of appearing
      // to ignore the user's click.
      this.deps.onApprovalResolved?.(report.id, allow ? 'allowed' : 'denied');
      return { ok: true, delivered: 'next-attempt' };
    }

    if (task.status !== 'open' && task.status !== 'running') {
      // Legacy data may contain an approval whose task already settled. Keep
      // the original line and execution body when creating the only necessary
      // compatibility continuation; normal approvals never take this path.
      this.threads.markReportRead(report.id);
      this.deps.onApprovalResolved?.(report.id, allow ? 'allowed' : 'denied');
      const note = allow
        ? `放行（${tool}）：${text || '可以'}`
        : `不放行（${tool}）：${text || '不许'}`;
      const created = this.createTask({
        title: task.title,
        contract: {
          ...contractOf(task),
          objective: `${contractOf(task).objective}\n\n${note}`,
        },
        assigneeId: task.assigneeId,
        estTokens: task.estTokens,
        acceptanceCommand: task.acceptanceCommand,
        acceptanceTemplate: task.acceptanceTemplate,
        threadId: task.threadId ?? undefined,
        workerId: task.workerId,
      });
      if (!created.ok) return { ok: false, error: created.error.message };
      if (allow) this.repository.grantMcpPermit(created.task.id, tool);
      this.repository.addSteering(created.task.id, note, 'answer');
      this.repository.addStep(created.task.id, allow ? `你允许了：${tool}` : `你不允许：${tool}`);
      if (created.task.threadId) this.threads.setState(created.task.threadId, 'running');
      this.runTask(created.task.id);
      return { ok: true, delivered: 'new-task' };
    }

    if (allow) this.repository.grantMcpPermit(task.id, tool);
    this.threads.markReportRead(report.id);
    this.deps.onApprovalResolved?.(report.id, allow ? 'allowed' : 'denied');

    const note = allow
      ? `放行（${tool}）：${text || '可以'}`
      : `不放行（${tool}）：${text || '不许'}`;
    this.repository.addSteering(task.id, note, 'answer');
    this.repository.addStep(task.id, allow ? `你允许了：${tool}` : `你不允许：${tool}`);

    const live =
      this.modelBrain !== null &&
      (await this.modelBrain.interject(
        task.id,
        allow ? `${tool} 已经放行，可以重试了。` : `${tool} 没有放行，别再试它。`,
        {
          label: allow ? '他允许了这一步：' : '他没允许这一步：',
          kind: 'answer',
        },
      ));
    if (task.threadId) this.threads.setState(task.threadId, 'running');
    const updated = this.repository.getTask(task.id);
    if (updated) this.emit(updated);
    return { ok: true, delivered: live ? 'live' : 'next-attempt' };
  };

  /**
   * 你在对话报告卡片上的两个动作（steering 层）。
   *
   * `approve` —— 认可。这活只有人能判，所以认可就是终审：任务记成你通过，
   * 工作线关掉。`rework` —— 不满意，带着意见再做一次：**新建一个任务**而不是
   * 重开旧的，因为旧任务的预算已结算、验收记录已定案，重开会让账本和验收历史
   * 互相矛盾。
   */
  decideThread = (
    threadId: string,
    decision: 'approve' | 'rework',
    note?: string,
    reportId?: string,
  ): { ok: true; thread: WorkThread } | { ok: false; error: string } => {
    const latest = this.repository.latestForThread(threadId);
    const text = note?.trim() || '';

    if (decision === 'approve') {
      // `userDecision` only accepts a task awaiting judgement; a thread whose task
      // is already delivered just needs closing.
      if (latest?.status === 'accepted') {
        this.userDecision(latest.id, 'approve', text || undefined);
      } else {
        this.threads.setState(threadId, 'done');
      }
      const thread = this.threads.getThread(threadId);
      if (!thread) return { ok: false, error: `未知工作线：${threadId}` };
      if (reportId) {
        const report = this.threads.getReport(reportId);
        // `decide` is idempotent for cards restored from an older transcript;
        // mark again so the chat callback also removes a stale pending card.
        if (report) this.threads.markReportRead(reportId);
      }
      return { ok: true, thread };
    }

    if (!latest) return { ok: false, error: '这条工作线上还没有任务，无法返工' };
    const created = this.createTask({
      title: latest.title,
      contract: {
        ...contractOf(latest),
        objective: text ? `${contractOf(latest).objective}\n\n你的意见：${text}` : `${contractOf(latest).objective}\n\n你要求重做`,
      },
      assigneeId: latest.assigneeId,
      estTokens: latest.estTokens,
      acceptanceCommand: latest.acceptanceCommand,
      acceptanceTemplate: latest.acceptanceTemplate,
      threadId,
      workerId: latest.workerId,
    });
    if (!created.ok) return { ok: false, error: created.error.message };
    if (reportId) {
      const report = this.threads.getReport(reportId);
      if (report) this.threads.markReportRead(reportId);
    }

    // 收集器要立刻收下，不能等：这句话就是"这版不对，应该是 X"，是整条链路上最干净的
    // 偏好证据。处理是后置的（抽取管线），收是同步的。
    this.signals.record({ origin: 'rework', threadId, text });

    this.threads.setState(threadId, 'running');
    this.runTask(created.task.id);
    const thread = this.threads.getThread(threadId);
    if (!thread) return { ok: false, error: `未知工作线：${threadId}` };
    return { ok: true, thread };
  };

  /**
   * Manager decomposition. Children are ordinary tasks, so they run through the
   * same pi loop and acceptance as anything you dispatches.
   */
  decompose = (
    parentTaskId: string,
    requesterId: string,
    subtasks: readonly SubtaskDraft[],
  ): { ok: true; created: WorkTask[] } | { ok: false; error: TaskError } => {
    const parent = this.repository.getTask(parentTaskId);
    if (!parent) return { ok: false, error: { code: 'DECOMPOSE_EMPTY', message: '未知父任务' } };
    if (parent.assigneeId !== requesterId) {
      return { ok: false, error: { code: 'DECOMPOSE_SELF', message: '只有负责人能拆解自己的任务' } };
    }

    const assignable = this.assignableTo(requesterId);
    const refusal = validateDecomposition({
      parent,
      requesterId,
      subtasks,
      assignable,
      parentRemainingTokens: Math.max(0, parent.estTokens - parent.tokensUsed),
    });
    if (refusal) return { ok: false, error: refusal };

    const created: WorkTask[] = [];
    for (const subtask of subtasks) {
      const childId = `task-${crypto.randomUUID()}`;

      const childWorker = parent.threadId
        ? this.ensureWorker(parent.threadId, subtask.assigneeId)
        : null;
      const child = this.repository.createTask(
        {
          title: subtask.title,
          contract: subtask.contract,
          assigneeId: subtask.assigneeId,
          estTokens: subtask.estTokens,
          acceptanceCommand: ['node', '{checks}/verify.mjs'],
          acceptanceTemplate: subtask.acceptanceTemplate ?? 'http-ok',
          // Same line of work as the parent: a goal decomposed into five tasks is
          // still one thing to you, and must be recallable as one thread.
          ...(parent.threadId ? { threadId: parent.threadId } : {}),
          ...(childWorker ? { workerId: childWorker.id } : {}),
        },
        taskWorkspaceRelPath(childId),
        childId,
        { parentTaskId: parent.id, depth: parent.depth + 1 },
      );
      this.emit(child);
      created.push(child);
      // A decomposed subtask is dispatched just like user work: it must progress
      // without another manual click.
      this.runTask(child.id);
    }

    this.repository.addStep(parent.id, `拆解为 ${created.length} 个子任务`);
    this.emit(this.repository.getTask(parent.id) as WorkTask);
    return { ok: true, created };
  };

  /**
   * Reservation happens before the row exists: refusing a task must cost nothing
   * and must not leave an orphan task you thinks is running.
   */
  /**
   * A configured-but-unusable default LLM used to make the harness wait on the
   * network until the task timed out ("stuck in 进行中" with no explanation).
   * Refuse up front with a message you can act on.
   */
  private assertModelUsable(): void {
    const config = this.deps.modelConfig;
    if (!config) return;
    const llm = config.getDefaults().llm;
    // 没配模型就不装成"有人在干活"：脚本化执行只留给探针（它们显式设 OPC_BRAIN_VARIANT）。
    // 真实使用里先把模型配好（设置 → 模型），否则任务直接失败并说明原因，而不是让一个
    // 写死 hello-world 的替身把任务"干完"。
    if (!llm && !process.env.OPC_BRAIN_VARIANT) {
      throw new Error(
        '未配置默认模型：到 设置 → 模型 选一个 LLM 后再执行（演练可设 OPC_BRAIN_VARIANT=ok）',
      );
    }
    if (!llm) return; // 探针模式：脚本化大脑离线可跑
    const provider = config.listProviders().find((entry) => entry.id === llm.providerId);
    if (!provider) throw new Error(`默认模型指向不存在的 provider：${llm.providerId}`);
    if (!provider.hasKey) {
      throw new Error(`默认模型 ${provider.name} / ${llm.modelId} 没有可用的 API Key，任务未启动`);
    }
  }

  createTask = (input: CreateTaskInput): CreateTaskResult => {
    const taskId = `task-${crypto.randomUUID()}`;
    const workspaceRelPath = taskWorkspaceRelPath(taskId);
    const contract = input.contract ?? legacyContract(input);
    const draft: CreateTaskDraft = {
      ...input,
      contract,
      acceptanceTemplate: contract.acceptance?.template ?? input.acceptanceTemplate ?? 'http-ok',
      acceptanceCommand:
        (contract.acceptance?.command ?? input.acceptanceCommand ?? []).length > 0
          ? (contract.acceptance?.command ?? input.acceptanceCommand ?? [])
          : ['node', '{checks}/verify.mjs'],
    };
    const normalizedContract = draft.contract ?? legacyContract(input);

    // Every task belongs to a line of work, so a finished task always has somewhere
    // to report to. Today that is one thread per task; a goal that decomposes into
    // several tasks keeps them together because children inherit the parent's id.
    const threadId =
      draft.threadId ??
      this.threads.createThread({ title: draft.title, goal: normalizedContract.objective }).id;
    draft.threadId = threadId;
    // The dispatcher may already have chosen an execution body (workerPool); it
    // wins over the default "one worker per person per thread". A worker from a
    // different line of work is ignored rather than trusted.
    const chosen = draft.workerId ? this.threads.getWorker(draft.workerId) : null;
    draft.workerId =
      chosen && chosen.threadId === threadId
        ? chosen.id
        : this.ensureWorker(threadId, draft.assigneeId).id;

    let task: WorkTask;
    try {
      task = this.repository.createTask(draft, workspaceRelPath, taskId);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'ASSIGNEE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    this.emit(task);
    return { ok: true, task };
  };

  /*
   * 这里原本是「二级验收」：系统验收过了，再交给这个人的经理看一遍 verdict.json。
   *
   * v2 里没有经理，这条链也就没有了。三层验收的边界写死在 docs/v2/01-core.md §9：
   * ① Watchdog 判"还在不在往前走" ② 可执行闸门（退出码）③ 人的确认。
   * 闸门过了就关单；闸门不存在或没过，就通过对话报告卡片交给用户——中间不需要一个同事。
   */

  /**
   * Reasons a task must not start: no usable model, or an unfinished blocker.
   * Both fail the task with a readable message instead of leaving it hanging —
   * "stuck in 进行中" is the worst state a ledger can show.
   */
  private refuseToStart(taskId: string): boolean {
    try {
      this.assertModelUsable();
      if (this.repository.isBlocked(taskId)) {
        const blockers = this.repository.getTask(taskId)?.blockedBy ?? [];
        throw new Error(
          `还有未完成的前置任务：${blockers.map((link) => link.issueKey ?? link.title).join('、')}`,
        );
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.addStep(taskId, message);
      this.repository.setStatus(taskId, 'failed', {
        finishedAt: Date.now(),
        error: message,
        // §3.7：这类失败**不消耗尝试也不该重试**——没模型、前置没做完，
        // 再跑一百次也是同一个结果。分类让它不再伪装成"跑挂了"。
        errorKind: 'blocked',
      });
      const failed = this.repository.getTask(taskId);
      if (failed) this.emit(failed);
      return true;
    }
  }

  /**
   * 这个任务是不是已经有 run 在跑（或排在队里）。
   *
   * 判的是队列而不是单个字段：同一个执行体的两个任务必须**串行**，而一个字段只能
   * 记住其中一个。原因见 `ownerQueue.ts`——并发写同一个 sqlite 会话会把 harness 毒化。
   */
  private isRunning(taskId: string): boolean {
    return this.queue.isRunning(taskId) || this.repository.getTask(taskId)?.status === 'running';
  }

  /** 这个执行体现在跑着什么，还有几个在等。界面用它说"忙"。 */
  queueSnapshot(ownerId: string): { running: string | null; waiting: number } {
    return {
      running: this.queue.activeTask(ownerId) ?? null,
      waiting: this.queue.waitingFor(ownerId).length,
    };
  }

  /** Fire-and-forget: the UI follows `subscribe()`. */
  runTask = (taskId: string): void => {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    if (this.isRunning(taskId)) return;
    this.queue.enqueue(task.assigneeId, taskId);
  };

  runTaskAndWait = async (taskId: string): Promise<WorkTask> => {
    const task = this.repository.getTask(taskId) as WorkTask;
    if (this.isRunning(taskId)) return task;
    await this.queue.enqueueAndWait(task.assigneeId, taskId);
    return this.repository.getTask(taskId) as WorkTask;
  };

  subscribe = (listener: (task: WorkTask) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Startup: resume interrupted durable tasks, then fail anything that is stuck.
   *
   * 预算删掉之后这里不再有"回收预留"这一步：没有预留，就没有需要回收的东西。
   */
  recover = async (): Promise<void> => {
    try {
      await this.runner.resumeInterrupted();
    } catch (error) {
      console.error('resume failed', error);
      // 「状态恢复失败」正是文章 §6 点名的那类基础设施故障：它意味着有活被
      // 落下了，而主流程不会再提它第二次。
      this.deps.faults?.recordSafely({
        kind: 'work.resume_failed',
        severity: 'error',
        subjectType: 'process',
        summary: `启动恢复失败：${messageOf(error)}。可能有任务停在中断状态。`,
      });
    }
    this.sweepStaleRunning();
  };

  /**
   * Second line of defence: a row still marked `running` that nothing is working on
   * (no durable task, or no activity for 10 minutes) is failed, so its reservation
   * can be reclaimed. Covers builds from before durable execution existed.
   */
  sweepStaleRunning = (): number => {
    const cutoff = Date.now() - 10 * 60_000;
    let swept = 0;

    for (const task of this.repository.listRunning()) {
      if (task.updatedAt && task.updatedAt > cutoff) continue;
      const durableId = this.repository.getDurableTaskId(task.id);
      this.repository.addStep(task.id, '启动对账：任务长时间无进展，标记失败');
      this.repository.setStatus(task.id, 'failed', {
        finishedAt: Date.now(),
        error: durableId ? '恢复超时' : '缺少 durable 记录',
      });
      swept += 1;
    }

    return swept;
  };

  dispose = async (): Promise<void> => {
    this.listeners.clear();
    const context = await getBackgroundContext();
    for (const entry of this.harnesses.values()) {
      await entry.harness.close(context).catch(() => undefined);
    }
    this.harnesses.clear();
    for (const [workerId, opening] of this.mcpMounts) {
      this.mcpMounts.delete(workerId);
      await opening.then((mount) => mount.close()).catch(() => undefined);
      this.mcpServers.delete(workerId);
    }
  };

  /**
   * The capability catalogue shown on the 「技能与工具」 page.
   *
   * Every row is read from the same `buildRegistry()` the worker installs, so a
   * tool that runtime conditions exclude (no image provider, no speech model, no
   * subordinates) cannot appear here. `skills` rides along as metadata: it is an
   * archive tag and is never injected into the prompt.
   */
  capabilities = async (): Promise<CapabilityCatalog> => {
    const agents: AgentCapability[] = [];
    for (const worker of this.threads.listAllWorkers()) {
      const snapshot = (await this.buildRegistry(subjectOfWorker(worker))).snapshot();
      const model = resolveWorkerModelRef({ worker, modelConfig: this.deps.modelConfig });
      agents.push({
        workerId: worker.id,
        name: worker.name,
        template: worker.template,
        status: worker.status,
        model: model ? labelOf(this.deps.modelConfig, model) : '',
        skills: worker.skills,
        extensions: snapshot.installed().map((extension) => ({
          name: extension.name,
          tools: (extension.tools ?? []).map((tool) => tool.name),
          hooks: extension.hooks?.length ?? 0,
          tasks: extension.tasks?.length ?? 0,
          sections: extension.sections?.length ?? 0,
        })),
        tools: snapshot.tools().map(({ extension, tool }) => ({
          name: tool.name,
          description: tool.description,
          extension: extension.name,
          deferred: tool.deferred === true,
        })),
      });
    }

    agents.sort((left, right) => left.name.localeCompare(right.name));
    return { generatedAt: Date.now(), agents };
  };

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Every capability group this employee could be given, with availability.
   *
   * This is the one catalogue: `buildRegistry` installs from it and the stack
   * page renders it. Reasons are codes, not sentences, so both locales can
   * explain the same missing provider without the main process translating.
   */
  /** 这个执行体的 MCP 挂载；没有配置就是 null。 */
  private async mcpMountFor(workerId: string): Promise<McpMount | null> {
    const servers = this.deps.mcp?.() ?? [];
    if (servers.length === 0) return null;

    const cached = this.mcpMounts.get(workerId);
    if (cached) return cached;

    const opening = mountMcp({ servers, userDataDir: this.deps.paths.userData });
    this.mcpMounts.set(workerId, opening);
    try {
      const mount = await opening;
      for (const server of mount.servers) {
        if (!server.error) continue;
        console.warn(`[mcp] ${server.name} 没连上：${server.error}`);
        this.deps.faults?.recordSafely({
          kind: 'mcp.connect_failed',
          severity: 'warning',
          subjectType: 'mcp',
          subjectId: server.name,
          summary: `MCP 服务器 ${server.name} 没连上：${server.error}`,
          detail: { server: server.name },
        });
      }
      this.mcpServers.set(workerId, mount.servers);
      // 一个都没连上就别占着一个槽：它会让界面显示"有 MCP"，而实际什么都没有。
      if (!mount.extension) {
        this.mcpMounts.delete(workerId);
        return null;
      }
      return mount;
    } catch (error) {
      this.mcpMounts.delete(workerId);
      console.warn('[mcp] 挂载失败', error);
      return null;
    }
  }

  private async toolSlots(subject: RegistrySubject): Promise<ToolSlot[]> {
    const personId = subject.ownerId ?? subject.id;
    // §2.2：工具集是执行体自己的属性。`employee` 那一路只是迁移期兜底。
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;

    const { createCodingTools } = await import('@earendil-works/pi-durable/tools');
    const slots: ToolSlot[] = [
      {
        name: 'coding-tools',
        essential: true,
        available: true,
        extension: createCodingTools(),
      },
    ];

    // The agent can draw, but only when a usable image provider exists.
    const images = this.deps.images;
    slots.push(
      images?.isAvailable()
        ? {
            name: 'opc.image',
            essential: false,
            available: true,
            extension: createImageToolExtension({
              generate: images.generateBytes,
              capabilities: images.getCapabilities,
            }),
          }
        : { name: 'opc.image', essential: false, available: false, reason: 'no-image-provider' },
    );

    // Speech: each half is installed only when a model is enabled, so the model
    // never sees a tool that can only fail.
    const speech = this.deps.speech;
    const transcribe = speech?.isAsrAvailable() ? speech.transcribe : undefined;
    const synthesize = speech?.isTtsAvailable() ? speech.synthesize : undefined;
    if (transcribe || synthesize) {
      slots.push({
        name: 'opc.speech',
        essential: false,
        available: true,
        extension: createSpeechToolExtension({
          transcribe,
          synthesize,
          defaultRoot: this.deps.paths.workspaceDir,
        }),
      });
    } else {
      slots.push({ name: 'opc.speech', essential: false, available: false, reason: 'no-speech-model' });
    }

    // Structured decisions replace a chat model with a bounded classifier. Like
    // speech, the tool exists only when a decision model is enabled and keyed, so
    // the agent never sees a tool whose first call can only fail.
    const decisions = this.deps.decisions;
    if (decisions?.isAvailable()) {
      slots.push({
        name: 'opc.decision',
        essential: false,
        available: true,
        extension: createDecisionToolExtension({ classify: decisions.classify }),
      });
    } else {
      slots.push({
        name: 'opc.decision',
        essential: false,
        available: false,
        reason: 'no-decision-model',
      });
    }

    // Text out of pictures for models without vision. Two independent gates: the
    // your switch (设置 → 运行时) and the models actually being on disk. An
    // installed tool that can only fail is worse than an absent one.
    const ocr = this.deps.ocr;
    if (ocr && (ocr.settings?.().enabled ?? true) && (ocr.assetsReady?.() ?? true)) {
      slots.push({
        name: 'opc.ocr',
        essential: false,
        available: true,
        extension: createOcrToolExtension({ ocr, defaultRoot: this.deps.paths.workspaceDir }),
      });
    } else {
      const reason =
        ocr && (ocr.settings?.().enabled ?? true) ? 'ocr-models-missing' : 'ocr-disabled';
      slots.push({ name: 'opc.ocr', essential: false, available: false, reason });
    }

    // Every employee can keep a lesson for its future self.
    const memory = this.deps.memory;
    if (memory) {
      slots.push({
        name: 'opc.memory',
        essential: false,
        available: true,
        extension: createRememberToolExtension({
          ownerId: personId,
          taskId: () => currentTaskIdFor(personId),
          remember: async ({ content, kind }) => {
            // 记在**当前这条工作线**上：同一条线索的下一个执行体能读到，
            // 换一条线就看不到——这正是"记忆跟着事走"的意思。
            const taskId = currentTaskIdFor(personId);
            const threadId = taskId ? this.repository.getTask(taskId)?.threadId : undefined;
            return memory.remember({
              // 同上：线级的记忆属于那条线，不属于此刻干活的这个执行体。
              ownerId: threadId ?? personId,
              kind,
              content,
              scope: threadId ? { type: 'thread', id: threadId } : { type: 'personal' },
              sourceType: 'task',
              sourceId: taskId,
            });
          },
        }),
      });
    } else {
      slots.push({ name: 'opc.memory', essential: false, available: false, reason: 'memory-disabled' });
    }

    // 原始记录（§3.3）：顺着 ID 回到源头，而不是只相信 Router 的转述。
    // 只读、永远可用——它查的是库，不是外部服务，所以没有"装了却只能失败"的问题。
    slots.push({
      name: 'opc.recall',
      essential: false,
      available: true,
      extension: createRecallToolExtension({
        taskId: () => currentTaskIdFor(personId),
        recall: (input) => this.recallRecord(input),
      }),
    });

    // 子代理（原文 §2.2）：把一段思考交给一个干净的上下文。
    // 没有模型就不装——它自己也跑不起来，装了只会让模型第一次调用就撞墙。
    slots.push(
      this.modelBrain
        ? {
            name: 'opc.investigate',
            essential: false,
            available: true,
            extension: createInvestigateToolExtension({
              taskId: () => currentTaskIdFor(personId),
              run: (input, api, context) => this.runSubagent(input, api, context),
              log: (taskId, text) => {
                this.repository.addStep(taskId, text);
                const task = this.repository.getTask(taskId);
                if (task) this.emit(task);
              },
            }),
          }
        : { name: 'opc.investigate', essential: false, available: false, reason: 'no-llm' },
    );

    // 请示与交回（E3）：执行体以前只有终局的嘴——卡住只能猜，或者失败。
    slots.push({
      name: 'opc.escalate',
      essential: false,
      available: true,
      extension: createEscalateToolExtension({
        taskId: () => currentTaskIdFor(personId),
        escalate: (input) => this.escalateFor(input),
      }),
    });
    slots.push({
      name: 'opc.handback',
      essential: false,
      available: true,
      extension: createHandBackToolExtension({
        taskId: () => currentTaskIdFor(personId),
        handBack: (input) => this.handBackFor(input),
      }),
    });

    // 拆解的前提是"还有别的执行体可派"。只有一个时工具根本不装；
    // 有两个以上时，谁都可以把活交给别人——这里已经没有汇报线了。
    const assignable = this.assignableTo(subject.id);
    if (assignable.length > 0) {
      slots.push({
        name: 'opc.decompose',
        essential: false,
        available: true,
        extension: createDecomposeToolExtension({
          requesterId: personId,
          parentTaskId: () => currentTaskIdFor(personId),
          decompose: (parentId, requesterId, subtasks) =>
            this.decompose(parentId, requesterId, subtasks),
        }),
      });
    } else {
      slots.push({ name: 'opc.decompose', essential: false, available: false, reason: 'sole-executor' });
    }

    // Skills (`~/.agents/skills`). One extension that contributes a prompt
    // section plus `read_skill`, so the whole set is one switch in the dossier
    // and one line per skill in the system prompt.
    const skills = this.deps.piSkills;
    if (skills) {
      const enabled = skills.enabled();
      // Advertising a skill the model cannot open would be a trap: the section
      // and the tool have to be on or off together.
      const canRead = isToolEnabled(policy, 'read_skill');
      slots.push(
        enabled.length > 0 && canRead
          ? {
              name: 'opc.skills',
              essential: false,
              available: true,
              extension: createSkillsExtension({ skills: () => skills.enabled() }),
            }
          : { name: 'opc.skills', essential: false, available: false, reason: 'no-skills' },
      );
    }

    // Pi extensions the user turned on in 技能与工具. They install last, so the
    // sandbox and the tool limit still see every call they make, and a disabled
    // one simply never appears here (its code was never imported).
    const external = this.deps.piExtensions;
    if (external) {
      await external.ensureLoaded();
      for (const entry of external.slots()) {
        slots.push({
          name: entry.name,
          essential: false,
          available: true,
          extension: entry.extension,
        });
      }
    }

    // 外部能力（MCP）：和别的扩展**一样是一个槽**，所以它能被按执行体关掉，
    // 也能用 `mcp__github__*` 这样一条规则关掉一个服务器的全部工具。
    const mcp = await this.mcpMountFor(subject.id);
    slots.push(
      mcp?.extension
        ? { name: 'opc.mcp', essential: false, available: true, extension: mcp.extension }
        : { name: 'opc.mcp', essential: false, available: false, reason: 'no-mcp-servers' },
    );

    const browser = this.deps.browser;
    const browserAvailable = browser?.status().healthy === true && browser.settings().enabled === true;
    slots.push(
      browserAvailable && browser
        ? {
            name: 'opc.browser',
            essential: false,
            available: true,
            extension: createBrowserToolExtension({
              broker: browser,
              taskId: () => currentTaskIdFor(personId),
              workerId: subject.id,
              userId: personId,
              workspace: () => {
                const taskId = currentTaskIdFor(personId);
                const task = taskId ? this.repository.getTask(taskId) : undefined;
                return task ? path.resolve(this.deps.paths.workspaceDir, task.workspaceRelPath) : undefined;
              },
              authorize: (tool, title, metadata) => {
                const taskId = currentTaskIdFor(personId);
                if (!taskId) return false;
                if (this.repository.hasMcpPermit(taskId, tool)) return true;
                this.askForApproval({ taskId, tool, title, ...(metadata ? { browser: metadata } : {}) });
                return false;
              },
            }),
          }
        : { name: 'opc.browser', essential: false, available: false, reason: 'browser-not-installed-or-disabled' },
    );

    const desktop = this.deps.desktop;
    const desktopAvailable = desktop?.status().healthy === true && desktop.settings(personId).enabled === true;
    slots.push(
      desktopAvailable && desktop
        ? {
            name: 'opc.desktop',
            essential: false,
            available: true,
            extension: createDesktopToolExtension({
              broker: desktop,
              taskId: () => currentTaskIdFor(personId),
              workerId: subject.id,
              userId: personId,
              authorize: (tool, title, metadata) => {
                const taskId = currentTaskIdFor(personId);
                if (!taskId) return false;
                if (this.repository.hasMcpPermit(taskId, tool)) return true;
                this.askForApproval({ taskId, tool, title, ...(metadata ? { desktop: metadata } : {}) });
                return false;
              },
            }),
          }
        : { name: 'opc.desktop', essential: false, available: false, reason: 'desktop-not-installed-or-disabled' },
    );

    return slots;
  }

  /**
   * Builds the extension registry for one employee.
   *
   * This is the single source of truth for "what can this agent do": the harness
   * opens with this registry, and the capability/stack pages read the same slots.
   * Conditions and the employee's deny-list live here on purpose, so no page can
   * describe a tool the model does not get.
   */
  private async buildRegistry(subject: RegistrySubject): Promise<Registry> {
    const slots = await this.toolSlots(subject);
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;

    // The registry carries our durable task definition: without it a resumed
    // task is "blocked: missing_task".
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'opc.work', tasks: [WorkTaskDefinition] }));
    // 动作流（W6）：工具调用 → `task_trace`。装在这里而不是每个工具里，
    // 因为它是"所有调用的旁听者"，不该由哪个工具自己负责。
    registry.install(createTraceExtension());

    /*
     * 外部能力（MCP）走槽位装（见 `toolSlots`），所以策略对它一样生效。
     *
     * 这里只做一件额外的事：把"服务器换了工具"的热更新指向**这一个**注册表——
     * 注册表会重建（换栈、改配置），而挂载是复用的。
     */
    const mcp = await this.mcpMountFor(subject.id);
    if (mcp) {
      mcp.refreshTarget = (extension) => registry.install(filterExtensionTools(extension, policy));
    }

    const install = (slot: ToolSlot) => {
      if (!slot.available || !slot.extension) return;
      if (!slot.essential && !isExtensionEnabled(policy, slot.name)) return;
      registry.install(filterExtensionTools(slot.extension, policy));
    };

    // Coding tools first; the sandbox is installed after them so it sees every
    // call, and `beforeTool` is the single choke point for path policy.
    for (const slot of slots) if (slot.essential) install(slot);
    registry.install(
      createSandboxExtension({ readOnlyRoots: () => this.runtime.sandboxRoots() }),
    );
    registry.install(createToolLimitExtension());
    for (const slot of slots) if (!slot.essential) install(slot);

    // Deferred tools are deliberately kept out of the model's initial tool list,
    // but they still need one universal discovery entry point.  This must be
    // derived from the installed extension catalogue rather than from an MCP
    // server name: any future deferred extension gets the same capability.
    const hasDeferredTools = slots.some((slot) => {
      if (!slot.available || !slot.extension) return false;
      if (!slot.essential && !isExtensionEnabled(policy, slot.name)) return false;
      return (slot.extension.tools ?? []).some(
        (tool) => tool.deferred === true && isToolEnabled(policy, tool.name),
      );
    });
    // `tool_search` is itself a model-facing capability, so the worker policy
    // must be able to turn it off just like any other tool.  Without this
    // guard, disabling the last deferred tool (or explicitly denying
    // `tool_search`) would still leave a misleading empty discovery tool in
    // the model's menu.
    if (
      hasDeferredTools &&
      isExtensionEnabled(policy, 'tool-search') &&
      isToolEnabled(policy, 'tool_search')
    ) {
      registry.install(createToolSearchExtension());
    }

    return registry;
  }

  /**
   * 一个**执行体**的模型与工具策略，以及运行时现在能装什么。
   *
   * 按 worker 而不是按人查：§2.2 说 Worker 挂载完整的执行工具，那么"它装了哪些、
   * 还差什么"就是它自己的问题。一条线可以有多个执行体，它们本来就可以不一样。
   */
  stack = async (workerId: string): Promise<WorkerStackView> => {
    const worker = this.threads.getWorker(workerId);
    if (!worker) throw new Error(`未知执行体：${workerId}`);

    const subject = subjectOfWorker(worker);
    const policy = subject.policy ?? EMPTY_TOOL_POLICY;
    const slots = await this.toolSlots(subject);
    const pinned =
      worker.modelProvider && worker.modelId
        ? { providerId: worker.modelProvider, modelId: worker.modelId }
        : null;
    return {
      workerId,
      name: worker.name,
      model: pinned,
      modelLabel: pinned ? labelOf(this.deps.modelConfig, pinned) : '',
      defaultModel: this.deps.modelConfig?.getDefaults().llm ?? null,
      policy,
      extensions: slots.map((slot) => {
        const enabled =
          slot.available && (slot.essential || isExtensionEnabled(policy, slot.name));
        return {
          name: slot.name,
          essential: slot.essential,
          available: slot.available,
          ...(slot.reason ? { reason: slot.reason } : {}),
          enabled,
          tools: (slot.extension?.tools ?? []).map((tool) => ({
            name: tool.name,
            label: tool.name,
            available: slot.available,
            enabled: enabled && isToolActive(policy, slot.name, tool.name),
          })),
        };
      }),
    };
  };

  /**
   * 改执行体的模型 / 工具策略，并丢掉缓存的 harness，让下一个任务立刻用新的。
   *
   * 工具装在 harness 的注册表里、开库时固定；模型是每个任务解析的，所以只有
   * 注册表需要重建。
   */
  setStack = async (workerId: string, input: WorkerStackInput): Promise<WorkerStackView> => {
    const worker = this.threads.getWorker(workerId);
    if (!worker) throw new Error(`未知执行体：${workerId}`);

    const slots = await this.toolSlots(subjectOfWorker(worker));
    const knownExtensions = new Map(slots.map((slot) => [slot.name, slot]));

    let policy: ToolPolicy | undefined;
    if (input.policy) {
      policy = normalizeToolPolicy(input.policy);
      const unknown = policy.disabledExtensions.filter((name) => !knownExtensions.has(name));
      if (unknown.length > 0) throw new Error(`未知的扩展：${unknown.join('、')}`);
      const essential = policy.disabledExtensions.filter(
        (name) => knownExtensions.get(name)?.essential,
      );
      if (essential.length > 0) throw new Error(`核心扩展不能关闭：${essential.join('、')}`);
      // Tool names are deliberately not validated: a deny-list entry for a tool
      // whose provider is temporarily unavailable must survive, not make the
      // whole save fail when you changes something else.
    }

    if (input.model) {
      const provider = this.deps.modelConfig
        ?.listProviders()
        .find((entry) => entry.id === input.model?.providerId);
      const model = provider?.models.find((entry) => entry.id === input.model?.modelId);
      if (!provider || !model) throw new Error('模型不存在或未配置');
      if (model.capability !== 'chat') throw new Error('执行体只能配置对话模型');
      if (model.chatEnabled === false) throw new Error('该模型未启用对话能力');
    }

    if (policy) this.threads.setWorkerPolicy(workerId, JSON.stringify(policy));
    if (input.model !== undefined) {
      this.threads.setWorkerModel(
        workerId,
        input.model?.providerId ?? null,
        input.model?.modelId ?? null,
      );
    }

    await this.evictRuntime(workerId);
    return this.stack(workerId);
  };

  /** 关掉一个执行体的运行时。注册表在开库时固定，改工具集必须重开。 */
  private async evictRuntime(workerId: string): Promise<void> {
    // 挂载也要丢：注册表要重建，而挂载是"这个执行体看到的那份目录"——留着它，
    // 设置页改完 `mcp.json` 之后新的服务器不会出现。
    const mountOpening = this.mcpMounts.get(workerId);
    this.mcpMounts.delete(workerId);
    this.mcpServers.delete(workerId);
    if (mountOpening) {
      try {
        // Unsubscribe from tools/list_changed before discarding the mount.  A
        // plain map clear would leave the old connection's listener alive and
        // let a stale MCP directory repopulate a newly built registry.
        await (await mountOpening).close();
      } catch (error) {
        console.warn('关闭执行体 MCP 挂载失败（栈已变更）', error);
      }
    }
    const entry = this.harnesses.get(workerId);
    if (!entry) return;
    this.harnesses.delete(workerId);
    const context = await getBackgroundContext();
    try {
      await entry.harness.close(context);
    } catch (error) {
      console.warn('关闭执行体 harness 失败（栈已变更）', error);
    }
  }

  /**
   * Drops every cached harness after a company-wide capability change (an
   * external Pi extension was enabled or disabled). Registries are fixed at open
   * time, so without this the change would only apply after a restart.
   */
  invalidateAllHarnesses = async (): Promise<void> => {
    // A mount can be created by the capability/stack pages before any harness
    // exists.  Include mount-only keys and close every mount so a newly saved
    // server cannot reuse a stale directory or listener until restart.
    const runtimeKeys = new Set([...this.harnesses.keys(), ...this.mcpMounts.keys()]);
    for (const runtimeKey of runtimeKeys) {
      await this.evictRuntime(runtimeKey);
    }
  };



  private emit(task: WorkTask): void {
    this.deps.upsertTaskCard(task);
    this.listeners.forEach((listener) => listener(task));
  }

  /** Keep the worker roster truthful while the task ledger remains authoritative. */
  private setWorkerRuntimeStatus(task: WorkTask, status: 'idle' | 'running'): void {
    const workerId = task.workerId;
    if (!workerId) return;
    const worker = this.threads.getWorker(workerId);
    if (!worker || worker.status === status) return;
    try {
      this.threads.setWorkerStatus(workerId, status);
    } catch (error) {
      // Runtime presentation must never make a durable task fail.
      console.warn('[work] worker runtime status update failed', error);
    }
  }

  /**
   * 请示：把一句"我定不了"投到线上（E3）。
   *
   * 等级由宿主决定，不由模型决定：**同一件事问第二次就不再插队**。第一次是 `decide`
   * ——他会放下手上的事；第二次是 `notify`——你看得见，但它不插队。一个执行体在同一件
   * 事上请示两次，说明它不该接这件事。
   *
   * 它落一条 `report`，不是落一条进度。进度走步骤流：每一步都汇报，Router 就变成日志
   * 消费者了（§3.2 只接收两种东西：没有归属的新事件，和要开口的汇报）。
   */
  escalateFor = (input: {
    taskId: string;
    question: string;
    tried: string;
    suggestion: string;
    /** 这件事叫什么。同一件事问第二次才降级；换一件事照样打断人。 */
    subject?: string;
  }): { level: 'decide' | 'notify' } => {
    const task = this.repository.getTask(input.taskId);
    if (!task?.threadId) throw new Error('这条任务不在任何工作线上，没有可请示的地方');

    // 数的是**同一件事**问过几次，不是这条任务问过几次（W-G5）。
    const previous = countEscalations(task.steps, input.subject);
    // 静默线上的请示也不插队：这条线本来就是我自作主张开的，不能反过来向他要决定。
    const speculative = this.threads.getThread(task.threadId)?.speculative === true;
    const level = speculative ? 'notify' : escalationLevel(previous);
    const tag = escalationTag(input.subject);
    this.repository.addStep(input.taskId, `请示${tag}：${input.question}`);

    const body = [
      input.question,
      input.tried ? `试过：${input.tried}` : '',
      input.suggestion ? `建议：${input.suggestion}` : '',
      `（${task.title} · ${task.id}）`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
    this.threads.addReport({
      threadId: task.threadId,
      level,
      title: `请示：${input.question}`,
      body,
      // 回答要落到**问这个问题的那件活**上，不能落到"这条线上最近的一件"。
      taskId: task.id,
      kind: 'question',
    });
    // 在等人做决定，这条线就不再是"在跑"。
    if (level === 'decide') this.threads.setState(task.threadId, 'waiting');

    const updated = this.repository.getTask(input.taskId);
    if (updated) this.emit(updated);
    return { level };
  };

  /**
   * 交回：这条线不该由我做（原文 §3.2）。
   *
   * 三件事：退订（后续事件不再直通给它）、线回到 `open`（等别人接或等人重新分派）、
   * 留一条 `decide` 说明原因。**它不是失败**——失败要花掉一次尝试和一笔预算，而"这不是
   * 我该做的"是一次成功的判断。
   */
  handBackFor = (input: { taskId: string; reason: string }): { ok: boolean; reason?: string } => {
    const task = this.repository.getTask(input.taskId);
    if (!task) return { ok: false, reason: '未知任务' };
    if (!task.threadId) return { ok: false, reason: '这条任务不在任何工作线上' };

    this.threads.unsubscribe(task.threadId, task.workerId ?? task.assigneeId);
    this.threads.setState(task.threadId, 'open');
    this.handedBack.add(task.id);
    this.repository.addStep(task.id, `交回：${input.reason}`);
    this.threads.addReport({
      threadId: task.threadId,
      level: 'decide',
      title: task.title,
      body: `我把这件事交回了：${input.reason}\n（${task.id}）`,
      taskId: task.id,
    });

    const updated = this.repository.getTask(task.id);
    if (updated) this.emit(updated);
    return { ok: true };
  };

  /**
   * 子代理真的跑一次（原文 §2.2）。
   *
   * 三件事决定了它的形状：
   *
   * 1. **它有自己的会话、自己的上下文**，但**共用父执行体的 harness**（也就是同一份
   *    registry）：它是这个人派出去的手，不是另一个人。
   * 2. **它的 cwd 是临时目录，沙箱只放行那一个可写根**。父任务的工作目录对它只读——
   *    这一条不靠提示词，靠沙箱：验收只认父目录里的产物，子代理要是能往里写，父就失去
   *    了"我交出的是什么"的确定性。
   * 3. **账记在父任务上**。账目里不该出现"没有任务的支出"，否则线级预算说不清"这件事
   *    值不值"。
   */
  private async runSubagent(
    request: {
      taskId: string;
      question: string;
      expects: string;
    },
    api: SubagentToolApi,
    ctx: Context,
  ): Promise<SubagentAnswer> {
    const task = this.repository.getTask(request.taskId);
    if (!task) throw new Error('父任务不见了');
    if (!this.deps.modelConfig) throw new Error('没有配置模型');

    const identity = runtimeIdentityFor(task);
    const model = resolveWorkerModelRef({
      worker: this.threads.getWorker(identity.runtimeKey),
      modelConfig: this.deps.modelConfig,
    });
    if (!model) throw new Error('执行体没有可用的模型');

    const workspaceDir = path.resolve(this.deps.paths.workspaceDir, task.workspaceRelPath);
    const scratchDir = path.join(
      this.deps.paths.userData,
      'scratch',
      task.id,
      `sub-${crypto.randomUUID().slice(0, 8)}`,
    );
    ensureDir(scratchDir);

    const { harness } = await this.harnessFor(identity);
    const before = await harness.usage(ctx);

    /*
     * 子会话**归这个工具调用所有**，和父会话在同一个 harness 里。
     *
     * 以前它跑在另一份存储（`<workerId>--sub.sqlite`）上，理由是"工具里等另一轮
     * generation，同一个 harness 的调度顺序不确定"。那条理由没有依据——平台自己的
     * 示例就是这个形状，而 `workSubagentProbe` 用真模型跑通过（工具里建会话、提交、
     * 等它答完、把答案带回父）。
     *
     * 归它所有买来三样手写不出来的东西：**中止顺着所有权传下去**、**重启认得出是
     * 同一个子会话**（`scanConversations({ownerTaskId})`）、**界面能挂上去看它在
     * 干什么**（`api.details`）。
     */
    const childId = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({
        ownership: { kind: 'task', taskId: api.taskId },
      });
      // 子会话**继承父的 agent**（同一套工具、同一个模型），这里只改三样：
      // 模型（执行体可能pinned 了自己的）、思考档位、和它的世界（临时目录）。
      await configure(tx, created.id, {
        model: { provider: model.providerId, modelId: model.modelId },
        thinkingLevel: (this.deps.modelConfig!.getThinking() ?? 'medium') as never,
        cwd: scratchDir,
      });
      return created.id;
    }, ctx);

    // 沙箱只放行一个可写根。父任务的工作目录不在里面，所以"写不进去"是执行出来的，
    // 不是叮嘱出来的（读仍然放行）。
    registerSandboxWorkspace(childId, scratchDir);
    // UI 顺着这条 details 找得到子会话：不写它，界面上就只有一个"查了一下"的黑盒。
    await api.details({ conversationId: String(childId) }, ctx);

    const handle = await api.conversation(childId, ctx);
    if (!handle) throw new Error('拿不到子会话的句柄');

    const submission = await handle.submit(
      {
        type: 'input',
        content: buildSubagentPrompt({
          ...request,
          deliverableSpec: task.deliverableSpec,
          workspaceDir,
          scratchDir,
          constraints: this.constraintsFor(task),
        }),
        // 重启之后同一个 requestId 找得到同一次提交，不会问第二遍。
        requestId: `subagent:${api.taskId}`,
      },
      ctx,
    );
    const settled = await submission.wait(ctx);

    const after = await harness.usage(ctx);
    const price = this.pricingFor(model);
    const { tokens, costUsd } = priceUsage(before, after, price);
    if (tokens > 0) this.repository.addTokens(task.id, tokens);
    if (costUsd > 0) this.repository.addCost(task.id, costUsd);

    if (settled.type !== 'input' || settled.status !== 'done') {
      throw new Error(`子代理未完成（${settled.type === 'input' ? settled.status : settled.type}）`);
    }

    // 答案是它这一轮的**结果条目**，不是"最后一条消息"：`settled.answer` 是具体
    // 那一条的 id，所以这里没有猜。以前约定 `answer.md`，那是在用一个文件协议补
    // 一件平台本来就给了的事。
    const answerEntry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);

    return {
      answer: textOfEntry(answerEntry),
      written: listWorkspaceFiles(scratchDir).map((file) => file.relPath),
      tokens,
      costUsd,
    };
  }

  /**
   * 子代理要继承的**约束**（不是历史）。
   *
   * 用户对输出的要求对子输出同样成立，所以常驻约束、做事规矩、工作台规定都带上；
   * 父的对话历史一概不给——隔离正是它有价值的原因。
   */
  private constraintsFor(task: WorkTask): string[] {
    const memory = this.deps.memory;
    const rules: string[] = [];
    if (memory) {
      for (const rule of memory.standing(USER_MEMORY_OWNER)) rules.push(rule.content);
      for (const rule of memory.procedural(
        recallOwners({ threadId: task.threadId, workerId: task.assigneeId }),
      )) {
        rules.push(rule.content);
      }
    }
    if (this.deps.facts) {
      const scopes = [
        { type: 'global' as const },
        ...(task.threadId ? [{ type: 'thread' as const, id: task.threadId }] : []),
      ];
      for (const fact of this.deps.facts.current(scopes)) rules.push(fact.statement);
    }
    return rules;
  }

  private pricingFor(model: { providerId: string; modelId: string }): {
    inputUsdPerM: number;
    outputUsdPerM: number;
  } {
    const provider = this.deps.modelConfig?.listProviders().find((entry) => entry.id === model.providerId);
    const found = provider?.models.find((entry) => entry.id === model.modelId);
    return { inputUsdPerM: found?.inputUsdPerM ?? 0, outputUsdPerM: found?.outputUsdPerM ?? 0 };
  }

  /**
   * 这条线上的原始记录，按时间排，取最近几条。
   *
   * 三样东西，各有各的用途：**事件**是这件事的来由（用户原话、CI 输出、PR 评论）；
   * **汇报**是之前几轮的结果（干成过什么、哪里没过）；**任务**是这条线跑过几回、
   * 每次要求什么。
   *
   * 当前这条任务自己不进去——它是"背景"，不是"背景里的自己"。
   */
  recordsOfThread(threadId: string, currentTaskId = ''): TaskRecord[] {
    const sources: RecordSource[] = [];

    for (const event of this.threads.listEventsOf(threadId, 6)) {
      sources.push({
        kind: 'event',
        id: event.id,
        title: `${event.source}/${event.kind}`,
        body: bodyOf(event.payload),
        at: event.createdAt,
      });
    }

    for (const report of this.threads.listReportsOf(threadId, 4)) {
      sources.push({
        kind: 'report',
        id: report.id,
        title: `${report.level} · ${report.title}`,
        body: report.body,
        at: report.createdAt,
      });
    }

    for (const task of this.repository.listByThread(threadId, 4)) {
      if (task.id === currentTaskId) continue;
      sources.push({
        kind: 'task',
        id: task.id,
        title: `${task.status} · ${task.title}`,
        body: `${task.brief}\n交付物：${task.deliverableSpec}`,
        at: task.createdAt,
      });
    }

    return buildRecords(sources);
  }

  /**
   * `recall` 的读侧：按 id 取这一条线上的一条记录的全文。
   *
   * 作用域在这里守住——不是模型说查什么就查什么。`out-of-scope` 和 `not-found`
   * 分开报：前者是边界（它该知道边界在哪），后者是打错了。
   */
  recallRecord(input: { taskId: string; id: string; page: number }): RecallOutcome {
    const task = this.repository.getTask(input.taskId);
    if (!task?.threadId) return { found: false, reason: 'no-task' };
    const threadId = task.threadId;

    const event = this.threads.getEvent(input.id);
    if (event) {
      if (event.threadId !== threadId) return { found: false, reason: 'out-of-scope' };
      return {
        found: true,
        text: recallView(bodyOf(event.payload), event.id, input.page),
      };
    }

    const report = this.threads.getReport(input.id);
    if (report) {
      if (report.threadId !== threadId) return { found: false, reason: 'out-of-scope' };
      return {
        found: true,
        text: recallView(`${report.title}\n\n${report.body}`, report.id, input.page),
      };
    }

    const other = this.repository.getTask(input.id);
    if (other) {
      if (other.threadId !== threadId) return { found: false, reason: 'out-of-scope' };
      return {
        found: true,
        text: recallView(
          `${other.title}\n\n${other.brief}\n\n交付物：${other.deliverableSpec}`,
          other.id,
          input.page,
        ),
      };
    }

    return { found: false, reason: 'not-found' };
  }

  /**
   * Tells the task's line of work what happened, and how loudly.
   *
   * Called at every point a task can reach an outcome — the run finishing, the
   * manager's verdict, the your own decision — and de-duplicated by status, so
   * a task that goes accepted → review → accepted reports once, at the end.
   */
  private reportToThread(taskId: string): void {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    // 交回过的任务不再改线的状态：线已经回到 open 等别人接手，一条"跑完了"会把它按回去。
    if (this.handedBack.has(task.id)) return;
    const thread = task.threadId ? this.threads.getThread(task.threadId) : null;
    const outcome = threadOutcomeFor(task, { speculative: thread?.speculative === true });
    if (!outcome) return;
    if (this.reportedThreads.get(task.id) === task.status) return;
    this.reportedThreads.set(task.id, task.status);

    const threadId = task.threadId;
    if (!threadId) return;

    /*
     * 一条线的状态由它的**根任务**决定，不由子任务决定。
     *
     * 以前是任何任务跑完都改线状态，于是"谁先跑完谁说了算"：父还在等子，线已经是
     * `done` 了；子再失败，线又变 `failed`——而你看到的是最后写进去的那一条，还以为
     * 整件事挂了。团队只有一个收口人，那个人是根任务。
     */
    const isChild = Boolean(task.parentTaskId);
    if (!isChild) this.threads.setState(threadId, outcome.state);

    if (outcome.report) {
      this.threads.addReport({
        threadId,
        ...outcome.report,
        taskId: task.id,
        result: {
          taskId: task.id,
          status: task.status === 'accepted' || task.status === 'delivered'
            ? 'accepted'
            : task.status === 'rejected'
              ? 'rejected'
              : task.status === 'failed'
                ? 'failed'
                : 'waiting',
          conclusion: outcome.report.body,
          artifacts: task.artifacts,
          acceptance: task.acceptance ?? null,
          evidence: (task.records ?? []).map((record) => ({
            kind: record.kind === 'event' ? ('source' as const) : ('record' as const),
            label: record.title,
            refId: record.id,
            excerpt: record.excerpt,
          })),
        },
        // 子任务的终局一律只留记录：它该由父先消化（父知道全局，你只知道这一条），
        // 不该赶在父汇总之前占用你的一次注意。
        ...(isChild ? { level: 'silent' as AttentionLevel } : {}),
      });
      // Spend belongs to the line of work, not only to the person (§8 axis flip).
      if (this.threads.charge(threadId, task.tokensUsed) && !this.warnedThreads.has(threadId)) {
        this.warnedThreads.add(threadId);
        this.threads.addReport({
          threadId,
          // 静默线超预算也只说一次、且不插队：它是我自己开的，不该让他替我焦虑。
          level: thread?.speculative ? 'notify' : 'decide',
          title: task.title,
          body: '这条工作线已经超出它自己的额度，继续还是收手？',
          taskId: task.id,
        });
      }
    }
  }

  /**
   * 运行时主体：优先是这个执行体本身；旧任务还没有 worker 行时，用一个不含
   * `ownerId` 的通用主体（没有同事、没有可拆的活、策略为空）。
   */
  private subjectFor(identity: RuntimeIdentity): RegistrySubject {
    const worker = this.threads.getWorker(identity.runtimeKey);
    if (worker) return subjectOfWorker(worker);
    return { id: identity.ownerId, name: identity.ownerId, template: 'research', skills: [] };
  }

  /**
   * Who may take a subtask from this execution body: every other live worker.
   *
   * Reporting lines are gone from this decision on purpose — with one worker there
   * is nobody to hand work to, and with peers there is no reason to route it
   * through a manager that no longer exists.
   */
  private assignableTo(workerId: string): { id: string }[] {
    return this.threads
      .listAllWorkers()
      .filter((worker) => worker.id !== workerId)
      .map((worker) => ({ id: worker.id }));
  }

  /**
   * The execution body for (thread, executor), created on first use.
   *
   * Idempotent by design: a thread with five tasks from the same executor gets one
   * worker, so its context is built once instead of five times. When the dispatcher
   * hands us a live worker id (the seeded default executor), its name / template /
   * skills / model are carried onto the thread-scoped copy.
   */
  private ensureWorker(threadId: string, executorId: string) {
    const existing = this.threads.getWorker(executorId);
    if (existing?.threadId === threadId) return existing;

    // The model is pinned here, at creation: a line of work keeps the runtime it
    // started with, so a later change of the company default does not silently
    // swap the brain under unfinished work.
    const model = resolveWorkerModelRef({
      worker: existing,
      modelConfig: this.deps.modelConfig,
    });
    return this.threads.ensureWorker({
      threadId,
      ownerId: executorId,
      name: existing?.name ?? executorId,
      ...(existing ? { template: existing.template, skills: existing.skills } : {}),
      ...(model ? { modelProvider: model.providerId, modelId: model.modelId } : {}),
    });
  }

  private async recordDurableStep(taskId: string, text: string): Promise<void> {
    try {
      const task = this.repository.getTask(taskId);
      if (!task) return;
      const entry = await this.harnessFor(runtimeIdentityFor(task));
      await entry.root.submit(
        {
          type: 'write',
          entry: { kind: 'work.step', data: { taskId, text, at: Date.now() } },
        },
        await getBackgroundContext(),
      );
    } catch (error) {
      // The transcript is an audit trail, not the source of truth.
      console.warn('durable step not recorded', error);
    }
  }

  /**
   * Opens (or reuses) the runtime for one execution body.
   *
   * `runtimeKey` names the sqlite file and the cache slot; `ownerId` decides
   * the tool registry and model. They are the same value until a task carries a
   * worker id, which is why old data keeps its existing `agents/<employee>.sqlite`.
   */
  private async harnessFor(identity: RuntimeIdentity): Promise<EmployeeHarness> {
    const cacheKey = identity.runtimeKey;
    const cached = this.harnesses.get(cacheKey);
    if (cached) return cached;

    const { Harness } = await import('@earendil-works/pi-durable');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');

    const context = await getBackgroundContext();
    const storagePath = path.join(this.deps.paths.agentsDir, `${cacheKey}.sqlite`);

    const subject = this.subjectFor(identity);
    const registry = await this.buildRegistry(subject);

    const models = this.deps.modelConfig
      ? await this.deps.modelConfig.runtime.createModels()
      : (await import('@earendil-works/pi-ai/models')).createModels();

    const harness = await Harness.open(
      await openNodeSqliteStorage(storagePath),
      {
        models,
        registry,
        // Compaction thresholds come from Settings → 工作区与压缩, so they follow
        // the selected model's context window instead of a hard-coded number.
        settings: this.deps.modelConfig
          ? {
              compaction: {
                enabled: this.deps.modelConfig.getCompaction().enabled,
                reserveTokens: this.deps.modelConfig.getCompaction().reserveTokens,
                keepRecentTokens: this.deps.modelConfig.getCompaction().keepRecentTokens,
                backgroundTokens: this.deps.modelConfig.getCompaction().backgroundTokens,
              },
            }
          : undefined,
        // Every tool call runs with the conversation's cwd as the workspace root
        // and the company base environment on its PATH.
        env: ({ cwd }) =>
          new NodeExecutionEnv({
            cwd: cwd ?? this.deps.paths.workspaceDir,
            shellEnv: this.runtime.envFor(),
          }),
      },
      context,
    );
    const root = await harness.root(context);
    const entry = { harness, root, ownerId: identity.ownerId };
    this.harnesses.set(cacheKey, entry);
    return entry;
  }
}

/**
 * 一个模型引用怎么显示给人看。
 *
 * 从目录里现读而不是存一个标签：provider 改过名、模型下过线时，存下来的标签会
 * 一直骗人。查不到就返回空，让界面显示"—"而不是一个过期名字。
 */
function labelOf(
  config: { listProviders(): { models: { id: string; name?: string }[] }[] } | undefined,
  ref: { providerId: string; modelId: string },
): string {
  const model = config
    ?.listProviders()
    .flatMap((provider) => provider.models)
    .find((entry) => entry.id === ref.modelId);
  return model?.name || model?.id || ref.modelId;
}

/** Loaded once: pi-durable is ESM-only, the main bundle is CJS. */
let contextPromise: Promise<Context> | null = null;

function getBackgroundContext(): Promise<Context> {
  contextPromise ??= import('@earendil-works/chord/context').then((module) => module.BACKGROUND_CONTEXT);
  return contextPromise;
}

/**
 * 一条 assistant 条目里的文字。
 *
 * 形状随 provider 略有差别（有的给 content 块数组，有的直接给字符串），所以只认
 * `content` 里的 text 块——认不出来的部分宁可不给，也不把 JSON 倒进父的上下文。
 */
function textOfEntry(entry: unknown): string {
  const messages = (entry as { model?: unknown[] } | undefined)?.model ?? [];
  const texts: string[] = [];
  for (const message of messages as { content?: unknown }[]) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; text?: unknown }[]) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('\n').trim();
}
