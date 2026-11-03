import type { WorkTask } from '@opc/shared/domain';
import type { Context } from '@earendil-works/chord/context';
import type { ModelRef } from '@opc/shared/domain';
import type { Harness, Conversation } from '@earendil-works/pi-durable';

interface UsageLike {
  models?: Record<string, { input: number; output: number; cost?: { total?: number } }>;
}
import { registerSandboxWorkspace } from '../sandbox/workspaces';
import type { AcceptanceFeedback, TaskBrain } from './brain';
import { runtimeIdentityFor, type RuntimeIdentity } from './runtimeIdentity';

export interface HarnessBrainDeps {
  /** The runtime this task runs in (keyed by worker, not by person). */
  harnessFor: (identity: RuntimeIdentity) => Promise<{ harness: Harness }>;
  context: () => Promise<Context>;
  /**
   * The model this runtime runs with: the execution body's own, otherwise the
   * person's, otherwise the company default.
   */
  model: (identity: RuntimeIdentity) => ModelRef | null;
  thinking: () => string;
  /** USD per 1M tokens for the selected model. */
  price: (model: ModelRef) => { inputUsdPerM: number; outputUsdPerM: number };
  onTokens: (taskId: string, tokens: number) => void;
}

/**
 * The real agent loop, delegated to pi.
 *
 * We do NOT re-implement "model → tool → model": submitting an input to a
 * conversation that has tools installed makes the Harness run it as durable
 * `pi.generation` / `pi.tool` tasks, with checkpoints, replay policy and usage
 * accounting. Our job is only to give it a workspace, a model and a goal.
 */
export class HarnessBrain implements TaskBrain {
  readonly name = 'pi-agent';
  readonly maxAttempts = Number(process.env.OPC_MAX_ATTEMPTS ?? 3);

  /**
   * 正在跑的会话，按任务记着。
   *
   * 存在的唯一理由是「你中途改方向」：改方向要**现在**生效，而不是等这一轮跑完
   * ——跑到一半才发现方向错了，等它跑完就白跑了。会话一结束就从表里去掉，所以
   * 这张表永远是"正在跑的"，不是缓存。
   */
  private readonly live = new Map<string, Conversation>();

  constructor(private readonly deps: HarnessBrainDeps) {}

  /**
   * 把一句话插进正在跑的活。
   *
   * `whenBusy: 'steer'` 是运行时自带的能力（pi 的 inbox）：会话忙的时候这句话排进
   * `pi.inbox`，在下一个 boundary（一次工具调用结束）被放进上下文，不需要我们去打断
   * generation。§4.1 的"全双工"在这里是白拿的。
   *
   * 返回 `false` 表示这条活此刻没有在跑的会话——那就只能走持久化那条路（写进
   * `task.steering`，下一次尝试读到）。
   */
  interject = async (taskId: string, text: string): Promise<boolean> => {
    const conversation = this.live.get(taskId);
    if (!conversation) return false;
    const note = text.trim();
    if (!note) return false;

    const ctx = await this.deps.context();
    const submission = await conversation.submit(
      {
        type: 'input',
        content: `用户中途改了方向（优先于原来的说明）：${note}`,
        whenBusy: 'steer',
        entry: { kind: 'opc.steering', data: { source: 'user' } },
      },
      ctx,
    );
    // 不等它 settle：steer 只在下一个 boundary 才落位，等它等于等到这一轮跑完。
    void submission.wait(ctx).catch(() => undefined);
    return true;
  };

  async execute(context: {
    task: WorkTask;
    workspaceDir: string;
    durableTaskId?: string;
    log: (text: string) => void;
    feedback?: AcceptanceFeedback;
    reportUsage?: (usage: {
      input: number;
      output: number;
      total: number;
      costUsd?: number;
    }) => void;
  }): Promise<void> {
    const { task, workspaceDir, durableTaskId, log, feedback, reportUsage } = context;

    const model = this.deps.model(runtimeIdentityFor(task));
    if (!model) throw new Error('未配置默认 LLM');

    const { harness } = await this.deps.harnessFor(runtimeIdentityFor(task));
    const ctx = await this.deps.context();

    const before = await harness.usage(ctx);
    const conversation = await harness.createConversation(
      {
        ownership: durableTaskId
          ? { kind: 'task', taskId: durableTaskId as never }
          : { kind: 'ownerless' },
        // cwd is the task workspace: every tool call is rooted there.
        // pi's ModelRef uses `provider`; ours uses `providerId`.
        agent: {
          model: { provider: model.providerId, modelId: model.modelId },
          // Thinking level is a real setting (Settings → LLM), not UI decoration.
          thinkingLevel: (this.deps.thinking() ?? 'medium') as never,
          cwd: workspaceDir,
        },
      },
      ctx,
    );

    // The sandbox hook needs to know which directory this conversation may touch.
    registerSandboxWorkspace(conversation.id, workspaceDir);

    log(`交给 pi 循环：${model.providerId}/${model.modelId}（工作区 ${workspaceDir}）`);
    if (feedback) log(`修复上下文：${feedback.reason}`);

    this.live.set(task.id, conversation);
    try {
      const submission = await conversation.submit(
        { type: 'input', content: buildPrompt(task, feedback) },
        ctx,
      );
      const settled = await submission.wait(ctx);

      const after = await harness.usage(ctx);
      // pi reports tokens; money is our own arithmetic against the configured price,
      // so a provider without a pricing table still yields a predictable 0.
      const delta = diffUsage(before, after);
      const spent = delta.input + delta.output;
      const price = this.deps.price(model);
      // pi already applies cache rates and context tiers; only fall back to plain
      // arithmetic when it reports no cost (e.g. a provider without prices).
      const piCost = diffCost(before, after);
      const costUsd =
        piCost > 0
          ? piCost
          : (delta.input / 1_000_000) * price.inputUsdPerM +
            (delta.output / 1_000_000) * price.outputUsdPerM;
      if (spent > 0 || costUsd > 0) {
        reportUsage?.({ input: 0, output: 0, total: spent, costUsd });
        log(
          costUsd > 0
            ? `模型用量：${spent} tokens · $${costUsd.toFixed(4)}`
            : `模型用量：${spent} tokens（未配置价格）`,
        );
      }

      if (settled.status !== 'done') {
        throw new Error(`pi 循环未完成（${settled.status}）`);
      }
    } finally {
      // 一定要在这里删：留着它，下一次"插话"会插进一条已经结束的会话。
      this.live.delete(task.id);
    }
    log('pi 循环结束');
  }
}

/**
 * 一次尝试的提示词。导出是因为它是**契约**：你改的方向、工作台规定、验收反馈各自
 * 以什么顺序、什么口吻进到执行体眼前，是这套系统对外承诺的一部分，值得单独测。
 */
export function buildPrompt(task: WorkTask, feedback?: AcceptanceFeedback): string {
  const lines = [
    `你在工作目录里完成一个任务，必须真的用工具创建文件，不要只回复说明。`,
    '',
    `任务：${task.title}`,
    `说明：${task.brief}`,
    `交付物：${task.deliverableSpec}`,
    '',
    `要求：`,
    '1. 用 write 工具创建所需文件（相对当前工作目录）。',
    '2. 用 bash 做**离线**检查（例如 `node --check server.js`）；**不要**启动长驻服务、不要访问网络——',
    '   沙箱会阻断出网，而系统会在沙箱外用真实验收脚本启动并判定。',
    '3. 确认无误后立即结束，不要输出大段解释。',
  ];

  // 你改的方向排在"要求"之后：它是后说的，而且与原说明冲突时以它为准。
  if (task.steering && task.steering.length > 0) {
    lines.push('', '用户在做这件事的过程中改了方向（**与上面的说明冲突时，以这里为准**）：');
    for (const entry of task.steering) lines.push(`- ${entry.note}`);
  }

  // 用户亲口要求过、一直有效的那些。排在"工作台的规定"之前：前者是他刚说的，
  // 后者是配置里的默认值，冲突时听刚说的那个人。
  if (task.standing && task.standing.length > 0) {
    lines.push('', '用户要求过、一直有效（必须遵守）：');
    for (const rule of task.standing) lines.push(`- ${rule.content}`);
  }

  // 用户要求过的格式与流程。它排在"相关经验"之前、"工作台的规定"之后：这是他对**输出**
  // 的要求，比我们默认的习惯优先。
  if (task.procedural && task.procedural.length > 0) {
    lines.push('', '用户要求过的做事规矩（必须遵守）：');
    for (const rule of task.procedural) lines.push(`- ${rule.content}`);
  }

  if (task.facts && task.facts.length > 0) {
    lines.push('', '工作台的规定（必须遵守，优先级高于你的习惯）：');
    for (const fact of task.facts) lines.push(`- ${fact.statement}`);
  }

  if (task.memories && task.memories.length > 0) {
    lines.push('', '你想起的相关经验（按相关度排序，可直接使用）：');
    for (const memory of task.memories) lines.push(`- ${memory.content}`);
  }

  if (feedback) {
    lines.push(
      '',
      `注意：上一版没有通过系统验收（第 ${feedback.attempt} 次）。`,
      `退出码：${feedback.evidence.exitCode ?? 'null'}`,
      `stdout：${feedback.evidence.stdoutTail || '(空)'}`,
      `stderr：${feedback.evidence.stderrTail || '(空)'}`,
      '请修复问题后重新验证。',
    );
  }

  return lines.join('\n');
}

/** Harness usage is cumulative per provider/model; charge only the delta. */
function diffCost(before: UsageLike, after: UsageLike): number {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce((total, entry) => total + (entry.cost?.total ?? 0), 0);
  return Math.max(0, sum(after) - sum(before));
}

function diffUsage(before: UsageLike, after: UsageLike): { input: number; output: number } {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce(
      (total, entry) => ({ input: total.input + entry.input, output: total.output + entry.output }),
      { input: 0, output: 0 },
    );
  const from = sum(before);
  const to = sum(after);
  return {
    input: Math.max(0, to.input - from.input),
    output: Math.max(0, to.output - from.output),
  };
}
