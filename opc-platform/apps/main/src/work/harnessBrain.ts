import type { WorkTask } from '@opc/shared/domain';
import type { Context } from '@earendil-works/chord/context';
import type { ModelRef } from '@opc/shared/domain';
import type { Harness } from '@earendil-works/pi-durable';

interface UsageLike {
  models?: Record<string, { input: number; output: number; cost?: { total?: number } }>;
}
import { registerSandboxWorkspace } from '../sandbox/workspaces';
import type { AcceptanceFeedback, TaskBrain } from './brain';

export interface HarnessBrainDeps {
  /** Employee harness with coding tools + the configured model. */
  harnessFor: (employeeId: string) => Promise<{ harness: Harness }>;
  context: () => Promise<Context>;
  /** The employee's own model when configured, otherwise the company default. */
  model: (employeeId: string) => ModelRef | null;
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

  constructor(private readonly deps: HarnessBrainDeps) {}

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

    const model = this.deps.model(task.assigneeId);
    if (!model) throw new Error('未配置默认 LLM');

    const { harness } = await this.deps.harnessFor(task.assigneeId);
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
    log('pi 循环结束');
  }
}

function buildPrompt(task: WorkTask, feedback?: AcceptanceFeedback): string {
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

  if (task.facts && task.facts.length > 0) {
    lines.push('', '公司与部门规定（必须遵守，优先级高于你的习惯）：');
    for (const fact of task.facts) lines.push(`- ${fact.statement}`);
  }

  if (task.memories && task.memories.length > 0) {
    lines.push('', '你想起的相关经验（按相关度排序，可直接使用）：');
    for (const memory of task.memories) lines.push(`- ${memory.content}`);
  }

  // 岗位职责 comes from the job template (shared by everyone in the seat); persona is
  // how this particular person works on top of it. The job part is read live, so
  // editing the template applies to the next task instead of the next hire.
  const charter = [task.jobDescription, task.persona]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (charter.length > 0) {
    lines.unshift(`你的岗位职责（来自组织档案，必须遵守）：${charter.join('\n')}`, '');
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
