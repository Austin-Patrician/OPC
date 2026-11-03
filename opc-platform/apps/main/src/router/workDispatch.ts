import type {
  AcceptanceTemplate,
  CreateTaskInput,
  CreateTaskResult,
  WorkerTemplate,
} from '@opc/shared/domain';
import { inferTemplate } from '../work/workerPool';
import { UNVERIFIED_GATE } from '../work/acceptanceGate';
import type { ThreadRepository } from '../data/threadRepository';

/**
 * 把一句话变成一条在跑的工作线。
 *
 * 这是 Router 的 `open_line_of_work` 工具背后的动作，也是双层架构真正落地的地方：
 *
 * - Router 只负责**决定**要做什么，它不知道也不关心执行的细节；
 * - 这里开线、挑执行体、订阅、建任务、**把任务启动起来然后立刻返回**；
 * - 任务跑完由 `WorkService.reportToThread` 写一条汇报，下一轮作为"执行体汇报"
 *   回到 Router 那里。
 *
 * 「立刻返回」是 §4.1 的全双工：Router 调用 `open_line_of_work` 后马上拿到 id，
 * 这一轮推理就结束了；它不需要阻塞等一个可能跑十分钟的活。原文把这个叫做
 * 异步 ReAct Loop——在这里它不是靠 `start()/stop()` 工具实现的，而是因为
 * **派活这个动作本身就是异步的**：跨进程的 durable task。
 */

export interface LineOpenerDeps {
  threads: ThreadRepository;
  createTask: (input: CreateTaskInput) => CreateTaskResult;
  /** 启动执行，不等它结束。 */
  startTask: (taskId: string) => void;
  /**
   * 谁来干。返回执行体（决定工具与模型）以及 worker 行（决定运行时）。
   * `null` = 没人能干。
   */
  resolveWorker: (input: {
    threadId: string;
    template: WorkerTemplate;
    hint: string;
  }) => { ownerId: string; workerId: string } | null;
  estTokens?: number;
}

export interface OpenLineInput {
  goal: string;
  title?: string;
  threadKey?: string | null;
  template?: WorkerTemplate;
  /**
   * 钉住一个已经在这条线上的执行体：直通（§3.2 Fast Path）走这条。
   *
   * 直通的含义是"归属已经确定"，所以不许再挑一次人——按目标重新 `pickWorker`
   * 会从全库重新选，选出来的可能不是盯这条线的那位，于是同一个话题会被两个
   * 互相不知道对方存在的执行体各干一半。找不到这个人就退回正常挑人。
   */
  workerId?: string;
  /** 可执行的验收命令；没有就诚实地说"验不了"。 */
  acceptance?: readonly string[];
}

export type OpenLineResult =
  | { ok: true; threadId: string; workerId: string; taskId: string | null }
  | { ok: false; reason: string };

const DEFAULT_EST_TOKENS = 20_000;

export function createLineOpener(deps: LineOpenerDeps) {
  return (input: OpenLineInput): OpenLineResult => {
    const goal = input.goal.trim();
    if (!goal) return { ok: false, reason: '目标为空，不知道该做什么' };

    // 同一个环境身份上已经有线，就并进去，不开第二条：你在同一个话题里连说
    // 三句话，应该是同一条线的三段上下文，而不是三件互相不知道对方存在的事。
    const existing = input.threadKey ? deps.threads.threadByKey(input.threadKey) : null;
    const thread =
      existing ??
      deps.threads.createThread({
        title: input.title?.trim() || firstLine(goal),
        goal,
        threadKey: input.threadKey ?? null,
      });

    const template = input.template ?? inferTemplate(`${thread.title} ${goal}`);
    // 归属已定的事件（直通）必须还给同一个执行体：`workerId` 存在就沿用它，
    // 不再按目标挑人。它不在这条线上时（线被重建过）才退回正常挑人。
    const pinned = input.workerId ? deps.threads.getWorker(input.workerId) : null;
    const picked =
      pinned && pinned.threadId === thread.id
        ? { ownerId: pinned.ownerId ?? pinned.id, workerId: pinned.id }
        : deps.resolveWorker({
            threadId: thread.id,
            template,
            hint: `${thread.title} ${goal}`,
          });
    if (!picked) {
      return { ok: false, reason: '没有可用的执行体：先在 设置 → 模型 里配一个能跑的模型' };
    }

    // 订阅先于建任务：任务一落地就开始产事件，订阅晚一步就会漏掉开头那几条。
    deps.threads.subscribe(thread.id, picked.workerId);

    const command = (input.acceptance ?? []).filter((part) => part.trim().length > 0);
    const verified = command.length > 0;
    const templateHint = isTemplate(input.template) ? input.template : undefined;

    const created = deps.createTask({
      title: thread.title,
      brief: goal,
      deliverableSpec: goal,
      assigneeId: picked.ownerId,
      workerId: picked.workerId,
      estTokens: deps.estTokens ?? DEFAULT_EST_TOKENS,
      // 没有闸门就说没有闸门：跑还是会跑，但结论只能是"需要人看一眼"，
      // 不假装通过（docs/v2/01-core.md §9）。
      acceptanceCommand: verified ? command : [...UNVERIFIED_GATE],
      acceptanceTemplate: acceptanceTemplateFor(templateHint),
      threadId: thread.id,
    });

    if (!created.ok) {
      return { ok: false, reason: created.error.message };
    }

    deps.threads.setState(thread.id, 'running');
    deps.startTask(created.task.id);
    return { ok: true, threadId: thread.id, workerId: picked.workerId, taskId: created.task.id };
  };
}

/**
 * 验收模板只决定"结果长什么样"；真正的闸门是 `acceptanceCommand` 的退出码。
 * 写代码的活天然以测试退出码为闸门，其余默认按 HTTP/命令成功判定。
 */
function acceptanceTemplateFor(template: WorkerTemplate | undefined): AcceptanceTemplate {
  return template === 'code' ? 'node-test' : 'http-ok';
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 60).trim() || '未命名目标';
}

function isTemplate(value: unknown): value is WorkerTemplate {
  return value === 'code' || value === 'research' || value === 'ops';
}
