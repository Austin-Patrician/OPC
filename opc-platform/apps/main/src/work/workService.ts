import type {
  TaskStatus,
  ToolPolicy,
  LinkType,
  CreateTaskInput,
  CreateTaskResult,
  SubtaskDraft,
  TaskError,
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
import crypto from 'node:crypto';
import path from 'node:path';
import { createSandboxExtension } from '../sandbox/extension';
import { createToolLimitExtension } from '../sandbox/toolLimit';
import type { CompanyDatabase } from '../data/companyDatabase';
import { USER_ID } from '../data/schema';
import { TaskRepository, taskWorkspaceRelPath, type CreateTaskDraft } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import type { AppPaths } from '../env';
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
import { recallOwners, USER_MEMORY_OWNER } from '../memory/owners';
import { SignalStore } from '../memory/signals';
import { subjectOfWorker, type RegistrySubject } from './registrySubject';
import { createDecomposeToolExtension } from './decomposeTool';
import { createDecisionToolExtension } from './decisionTool';
import { createImageToolExtension } from './imageTool';
import { createOcrToolExtension } from './ocrTool';
import { createSpeechToolExtension } from './speechTool';
import { createRememberToolExtension } from '../memory/rememberTool';
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

/** How many manager rework rounds a task may take before it is parked for you. */

/** Which work task each employee is executing right now (for tools that need it). */
const runningTaskByEmployee = new Map<string, string>();

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
  paths: AppPaths;
  /** Injects / updates the task card in the conversation. */
  upsertTaskCard: (task: WorkTask) => void;
  modelConfig?: ModelConfigService;
  images?: ImageService;
  /** Speech recognition / synthesis; each tool is installed only when usable. */
  speech?: SpeechService;
  /** Structured decisions (Jev / System One); absent = no `decide` tool. */
  decisions?: DecisionService;
  memory?: MemoryService;
  facts?: FactService;
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
   * The model-driven brain, when a model is configured. Kept as a field（不是构造
   * 函数里的临时变量）because 你中途改方向要能插进**正在跑**的那个会话，而那个
   * 会话只有 brain 自己认识。
   */
  private readonly modelBrain: HarnessBrain | null;

  constructor(private readonly deps: WorkServiceDeps) {
    this.repository = new TaskRepository(deps.db);
    this.threads = new ThreadRepository(deps.db);
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
        if (task) this.emit(task);
      },
      onResumed: () => undefined,
      onFinished: (taskId, outcome, result) => {
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
        this.repository.addStep(
          taskId,
          `启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
        this.repository.setStatus(taskId, 'failed', { finishedAt: Date.now(), error: String(error) });
        console.error('task run failed', error);
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
   * 你在注意力队列上的两个动作（steering 层）。
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
      return { ok: true, thread };
    }

    if (!latest) return { ok: false, error: '这条工作线上还没有任务，无法返工' };
    const created = this.createTask({
      title: latest.title,
      brief: text ? `${latest.brief}\n\n你的意见：${text}` : `${latest.brief}\n\n你要求重做`,
      deliverableSpec: latest.deliverableSpec,
      assigneeId: latest.assigneeId,
      estTokens: latest.estTokens,
      acceptanceCommand: latest.acceptanceCommand,
      acceptanceTemplate: latest.acceptanceTemplate,
      threadId,
    });
    if (!created.ok) return { ok: false, error: created.error.message };

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
          brief: subtask.brief,
          deliverableSpec: subtask.deliverableSpec,
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
    const draft: CreateTaskDraft = {
      ...input,
      acceptanceTemplate: input.acceptanceTemplate ?? 'http-ok',
      acceptanceCommand:
        input.acceptanceCommand.length > 0
          ? input.acceptanceCommand
          : ['node', '{checks}/verify.mjs'],
    };

    // Every task belongs to a line of work, so a finished task always has somewhere
    // to report to. Today that is one thread per task; a goal that decomposes into
    // several tasks keeps them together because children inherit the parent's id.
    const threadId =
      draft.threadId ??
      this.threads.createThread({ title: draft.title, goal: draft.brief }).id;
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
   * 闸门过了就关单；闸门不存在或没过，就进注意力队列等人——中间不需要一个同事。
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
      this.repository.setStatus(taskId, 'failed', { finishedAt: Date.now(), error: message });
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
            extension: createImageToolExtension({ generate: images.generateBytes }),
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
    for (const runtimeKey of [...this.harnesses.keys()]) {
      await this.evictRuntime(runtimeKey);
    }
  };



  private emit(task: WorkTask): void {
    this.deps.upsertTaskCard(task);
    this.listeners.forEach((listener) => listener(task));
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
    const outcome = threadOutcomeFor(task);
    if (!outcome) return;
    if (this.reportedThreads.get(task.id) === task.status) return;
    this.reportedThreads.set(task.id, task.status);

    const threadId = task.threadId;
    if (!threadId) return;
    this.threads.setState(threadId, outcome.state);

    if (outcome.report) {
      this.threads.addReport({ threadId, ...outcome.report });
      // Spend belongs to the line of work, not only to the person (§8 axis flip).
      if (this.threads.charge(threadId, task.tokensUsed) && !this.warnedThreads.has(threadId)) {
        this.warnedThreads.add(threadId);
        this.threads.addReport({
          threadId,
          level: 'decide',
          title: task.title,
          body: '这条工作线已经超出它自己的额度，继续还是收手？',
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
    const cached = this.harnesses.get(identity.runtimeKey);
    if (cached) return cached;

    const { Harness } = await import('@earendil-works/pi-durable');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');

    const context = await getBackgroundContext();
    const storagePath = path.join(this.deps.paths.agentsDir, `${identity.runtimeKey}.sqlite`);

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
    this.harnesses.set(identity.runtimeKey, entry);
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
