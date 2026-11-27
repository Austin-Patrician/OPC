import path from 'node:path';
import type { ChatAttachmentRef, WorkTask } from '@opc/shared/domain';
import type { Context } from '@earendil-works/chord/context';
import type { ModelRef } from '@opc/shared/domain';
import type { ContextEdit, Conversation, ConversationId, Harness } from '@earendil-works/pi-durable';
import { registerSandboxAttachments, registerSandboxWorkspace } from '../sandbox/workspaces';
import type { AcceptanceFeedback, TaskBrain } from './brain';
import { runtimeIdentityFor, type RuntimeIdentity } from './runtimeIdentity';
import { registerTraceRecorder, type TraceRecorder } from './trace';
import { childStatusLabel } from './children';
import {
  buildCrossTurnImageEvictionEdits,
  capWorkerThinkingLevel,
  estimateActiveContextTokens,
  PIVOT_COMPACT_TOKENS,
  WORKER_SOFT_COMPACT_TOKENS,
} from './contextHygiene';
import { calculateTokenCost, diffCostBreakdown, diffTokenDetails } from './usage';
import { normalizeWorkspaceRelPath, stageAttachmentsToWorkspace } from './workspace';

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
  price: (model: ModelRef) => {
    inputUsdPerM: number;
    outputUsdPerM: number;
    cacheReadUsdPerM?: number;
    cacheWriteUsdPerM?: number;
  };
  onTokens: (taskId: string, tokens: number) => void;
  recordUsage?: (usage: {
    taskId: string;
    workerId?: string;
    providerId: string;
    modelId: string;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total: number;
    costUsd?: number;
    providerCostUsd?: number;
    configuredCostUsd?: number;
    costSource?: 'provider' | 'configured' | 'unpriced';
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    conversationId: string;
    status: 'ok' | 'error' | 'aborted' | 'interrupted' | 'unknown';
  }) => void;
  /**
   * 动作流（`09-worker-spec.md` §3.4）。不给就是"这个任务没有轨迹"，
   * 不影响执行——观测的缺陷不能变成一个失败的任务。
   */
  trace?: (taskId: string) => TraceRecorder | null;
  /**
   * 动作级审批（M3）。MCP 的 `beforeTool` 是按扩展装的，而"这条会话在跑哪件活"是按任务
   * 知道的——这条回调是两者之间的桥。不给我就是"这个运行时没有要审批的东西"。
   */
  registerApproval?: (conversationId: unknown, taskId: string, scopeKey?: string) => () => void;
  /** Persistent Living Worker conversation lookup by workerId. */
  workerConversation?: (workerId: string) => { conversationId: string | null; lastCleanEntryId: number | null } | null;
  /** Saves a Living Worker's persistent conversation id and optional clean checkpoint entry id. */
  onWorkerConversation?: (workerId: string, conversationId: string, lastCleanEntryId?: number | null) => void;
  /** Records the conversation tail entry id right before a task turn begins (for clean pivot pruning). */
  onTaskCheckpoint?: (taskId: string, entryId: number | null) => void;
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
  /** Durable task id -> conversation handle within this process. */
  private readonly conversations = new Map<string, Conversation>();

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
  /**
   * 插一句进**正在跑**的那个会话。
   *
   * `label` 是这句话的开场白，默认是"改了方向"——因为绝大多数插话都是这个。但回答
   * 请示不是：它是**对执行体自己那句问话的回复**，用"改了方向"开头会让它以为需求变了，
   * 于是重新做一遍而不是接着做。
   */
  interject = async (
    taskId: string,
    text: string,
    options: { label?: string; kind?: 'steer' | 'answer' } = {},
  ): Promise<boolean> => {
    const conversation = this.live.get(taskId);
    if (!conversation) return false;
    const note = text.trim();
    if (!note) return false;

    const ctx = await this.deps.context();
    const submission = await conversation.submit(
      {
        type: 'input',
        content: `${options.label ?? '用户中途改了方向（优先于原来的说明）：'}${note}`,
        whenBusy: 'steer',
        entry: { kind: 'opc.steering', data: { source: 'user', kind: options.kind ?? 'steer' } },
      },
      ctx,
    );
    // 不等它 settle：steer 只在下一个 boundary 才落位，等它等于等到这一轮跑完。
    void submission.wait(ctx).catch(() => undefined);
    return true;
  };

  /** Immediately aborts an in-flight Worker conversation generation. */
  abortLive = async (taskId: string): Promise<boolean> => {
    const conversation = this.live.get(taskId);
    if (!conversation) return false;
    const ctx = await this.deps.context();
    if (typeof conversation.abort === 'function') {
      await conversation.abort(ctx).catch(() => undefined);
    }
    return true;
  };

  /**
   * Non-destructively prunes an aborted/pivoted turn's entries from a Living Worker's
   * active context using pi-durable ContextEdit, keeping prior clean turns intact.
   */
  pruneAfterCheckpoint = async (
    identity: RuntimeIdentity,
    conversationId: string,
    fromEntryId: number | null,
    tombstone: string,
  ): Promise<number> => {
    const { harness } = await this.deps.harnessFor(identity);
    const ctx = await this.deps.context();
    const numericId = Number(conversationId);
    const convId = (Number.isFinite(numericId) ? numericId : conversationId) as ConversationId;
    const conversation = await harness.conversation(convId, ctx).catch(() => undefined);
    if (!conversation || typeof conversation.context !== 'function') return 0;
    const view = await conversation.context(ctx).catch(() => undefined);
    if (!view) return 0;
    const cutoff = fromEntryId ?? 0;
    const targets = view.entries.filter(
      (entry) =>
        Number(entry.id) > cutoff &&
        entry.kind !== 'pi.system' &&
        entry.kind !== 'pi.system_patch' &&
        entry.kind !== 'pi.compaction' &&
        entry.kind !== 'pi.reset',
    );
    if (targets.length === 0) return 0;
    const edits: ContextEdit[] = targets.map((entry, index) =>
      index === 0
        ? {
            target: entry.id,
            action: 'replace',
            messages: [
              {
                role: 'user',
                content: `[上一轮路线已中止并清理，忽略之前未采纳的尝试：${tombstone}]`,
                timestamp: Date.now(),
              } as never,
            ],
          }
        : { target: entry.id, action: 'omit' },
    );
    await conversation
      .submit(
        {
          type: 'write',
          entry: { kind: 'opc.worker_prune', data: { fromEntryId: cutoff, count: edits.length, at: Date.now() }, edits },
        } as never,
        ctx,
      )
      .catch(() => undefined);
    return edits.length;
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
      providerCostUsd?: number;
      configuredCostUsd?: number;
      costSource?: 'provider' | 'configured' | 'unpriced';
      providerId?: string;
      modelId?: string;
      startedAt?: number;
      finishedAt?: number;
      durationMs?: number;
      conversationId?: string;
      status?: 'ok' | 'error' | 'aborted' | 'interrupted' | 'unknown';
    }) => void;
  }): Promise<{ answer?: string; truncatedNoTools?: boolean; stopReason?: string }> {
    const { task, workspaceDir, durableTaskId, log, feedback, reportUsage } = context;

    const model = this.deps.model(runtimeIdentityFor(task));
    if (!model) throw new Error('未配置默认 LLM');

    const { harness } = await this.deps.harnessFor(runtimeIdentityFor(task));
    const ctx = await this.deps.context();
    const configuredThinking = this.deps.thinking() || 'medium';
    const cappedThinking = capWorkerThinkingLevel(configuredThinking, {
      uncap: process.env.OPC_WORKER_THINKING_UNCAP === '1',
    });
    const effectiveThinkingLevel = feedback?.truncatedNoTools ? 'low' : cappedThinking;

    const callStartedAt = Date.now();
    const before = await harness.usage(ctx);
    let conversation = durableTaskId ? this.conversations.get(durableTaskId) : undefined;
    let reusedWarmConversation = Boolean(conversation);

    // Living Worker: reuse the thread worker's persistent conversation when available.
    if (!conversation && task.workerId && this.deps.workerConversation) {
      const saved = this.deps.workerConversation(task.workerId);
      if (saved?.conversationId && typeof harness.conversation === 'function') {
        const numericId = Number(saved.conversationId);
        const convId = (Number.isFinite(numericId) ? numericId : saved.conversationId) as ConversationId;
        const found = await harness.conversation(convId, ctx).catch(() => undefined);
        if (found) {
          conversation = found;
          reusedWarmConversation = true;
        }
      }
    }

    if (!conversation && durableTaskId && typeof harness.commit === 'function') {
      const existingId = await harness.commit(async (tx) => {
        const page = await tx.scanConversations({ ownerTaskId: durableTaskId as never, order: 'descending' }, 1);
        return page.items[0]?.id;
      }, ctx);
      if (existingId) {
        conversation = await harness.conversation(existingId, ctx);
        if (conversation) reusedWarmConversation = true;
      }
    }
    if (conversation && reusedWarmConversation && typeof conversation.configure === 'function') {
      await conversation
        .configure(
          {
            model: { provider: model.providerId, modelId: model.modelId },
            thinkingLevel: effectiveThinkingLevel as never,
            cwd: workspaceDir,
          } as never,
          ctx,
        )
        .catch(() => undefined);
    }
    if (!conversation) {
      const persistent = Boolean(task.workerId && this.deps.onWorkerConversation);
      conversation = await harness.createConversation(
        {
          ownership: persistent
            ? { kind: 'ownerless' }
            : durableTaskId
              ? { kind: 'task', taskId: durableTaskId as never }
              : { kind: 'ownerless' },
          // cwd is the task workspace: every tool call is rooted there.
          // pi's ModelRef uses `provider`; ours uses `providerId`.
          agent: {
            model: { provider: model.providerId, modelId: model.modelId },
            // Thinking level is a real setting (Settings → LLM), not UI decoration.
            thinkingLevel: effectiveThinkingLevel as never,
            cwd: workspaceDir,
          },
        },
        ctx,
      );
      if (persistent && task.workerId) {
        this.deps.onWorkerConversation?.(task.workerId, String(conversation.id));
      }
    }
    if (durableTaskId) this.conversations.set(durableTaskId, conversation);

    // Record pre-turn checkpoint entry id so a future pivot can cleanly prune this turn.
    // On warm reuse, also evict previous turns' inline tool images and compact oversized pivots.
    if (typeof conversation.context === 'function') {
      let checkpointView = await conversation.context(ctx).catch(() => undefined);
      if (reusedWarmConversation && checkpointView) {
        let contextMutated = false;
        const evictEdits = buildCrossTurnImageEvictionEdits(checkpointView);
        if (evictEdits.length > 0 && typeof conversation.submit === 'function') {
          const eviction = await conversation
            .submit(
              {
                type: 'write',
                entry: {
                  kind: 'opc.image_evict',
                  data: { reason: task.turnMode ?? 'reuse', count: evictEdits.length, at: Date.now() },
                  edits: evictEdits,
                },
              } as never,
              ctx,
            )
            .catch(() => undefined);
          if (eviction && typeof eviction.wait === 'function') {
            await eviction.wait(ctx).catch(() => undefined);
          }
          contextMutated = true;
          log(`已从热上下文卸载上一轮 ${evictEdits.length} 张历史图片以降低请求体积`);
        }

        if (!feedback && typeof conversation.compact === 'function') {
          const estTokens = estimateActiveContextTokens(checkpointView);
          const shouldCompactPivot =
            task.turnMode === 'pivot' &&
            (estTokens >= PIVOT_COMPACT_TOKENS || checkpointView.entries.length >= 24);
          const shouldCompactAppend =
            task.turnMode === 'append' && estTokens >= WORKER_SOFT_COMPACT_TOKENS;
          if (shouldCompactPivot || shouldCompactAppend) {
            const instructions = shouldCompactPivot
              ? '保留已核实的事实/数据、工作区文件路径与核心结论，舍弃旧版被推翻的实现细节与调试过程，以便按新方向轻装重做。'
              : '保留关键结论、当前工作区产物路径和未完成事项，压缩冗长的历史工具输出。';
            try {
              const compactTaskId = await conversation.compact(instructions, ctx);
              if (compactTaskId && typeof harness.waitForTask === 'function') {
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                  harness.waitForTask(compactTaskId, ctx).catch(() => undefined),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 45_000);
                  }),
                ]).finally(() => {
                  if (timer !== undefined) clearTimeout(timer);
                });
              }
              contextMutated = true;
              log(
                shouldCompactPivot
                  ? `转向（pivot）前已自动压缩旧上下文（约 ${estTokens} tokens）`
                  : `上下文已达 ${estTokens} tokens，续跑前已自动压缩历史消息`,
              );
            } catch {
              // Best-effort compaction must never block task execution.
            }
          }
        }

        if (contextMutated) {
          checkpointView = (await conversation.context(ctx).catch(() => undefined)) ?? checkpointView;
        }
      }

      const lastEntry = checkpointView?.entries[checkpointView.entries.length - 1];
      const checkpointId = lastEntry ? Number(lastEntry.id) : null;
      this.deps.onTaskCheckpoint?.(task.id, checkpointId);
    }

    const sourceAttachments = task.contract?.attachments ?? [];
    const { staged, missing } = stageAttachmentsToWorkspace(workspaceDir, sourceAttachments);
    if (staged.length > 0) {
      log(`已将 ${staged.length} 个附件复制到工作区 inputs/`);
    }
    if (missing.length > 0) {
      log(`部分附件未复制：${missing.map((item) => `${item.name}（${item.reason}）`).join('；')}`);
    }

    const promptAttachments: ChatAttachmentRef[] = staged.map((attachment) => ({
      ...attachment,
      path: path.relative(workspaceDir, attachment.path).replaceAll('\\', '/'),
    }));
    const promptTask: WorkTask = task.contract
      ? {
          ...task,
          contract: {
            ...task.contract,
            attachments: promptAttachments,
          },
        }
      : task;

    // Scope sandbox, attachments, trace, and approval registrations by the worker's
    // runtimeKey so concurrent Workers opening separate SQLite DBs with identical
    // autoincrement conversation IDs (e.g. '14') never cross-contaminate.
    const scopeKey = runtimeIdentityFor(task).runtimeKey;
    registerSandboxWorkspace(conversation.id, workspaceDir, scopeKey);
    registerSandboxAttachments(conversation.id, staged, scopeKey);

    // 动作流：从这一刻起，模型每调一个工具都会落一行（`opc.trace` 那个 hook 负责写）。
    // 这里只把"这条会话归哪件任务"挂上去，结束时撤掉。
    let recordedTools = 0;
    const rawRecorder = this.deps.trace?.(task.id) ?? null;
    const recorder: TraceRecorder | null = rawRecorder
      ? {
          taskId: rawRecorder.taskId,
          record(input) {
            if (input.kind === 'tool') recordedTools += 1;
            rawRecorder.record(input);
          },
          ...(rawRecorder.onToolStart
            ? {
                onToolStart(input) {
                  rawRecorder.onToolStart?.(input);
                },
              }
            : {}),
        }
      : null;
    const stopTrace = recorder ? registerTraceRecorder(conversation.id, recorder, scopeKey) : null;
    const stopApproval = this.deps.registerApproval?.(conversation.id, task.id, scopeKey) ?? null;

    log(
      reusedWarmConversation
        ? `复用热上下文继续 pi 循环（${task.turnMode ?? 'append'}）：${model.providerId}/${model.modelId}（工作区 ${workspaceDir}）`
        : `交给 pi 循环：${model.providerId}/${model.modelId}（工作区 ${workspaceDir}）`,
    );
    if (!feedback?.truncatedNoTools && cappedThinking !== configuredThinking.trim().toLowerCase()) {
      log(`全局思考强度为 ${configuredThinking}，Worker 执行循环自动限制为 ${cappedThinking} 以控制多轮工具调用耗时`);
    }
    if (feedback) {
      log(`修复上下文：${feedback.reason}`);
      if (feedback.truncatedNoTools) {
        log('检测到上一轮思考超长被截断，本轮自动降级思考强度为 low');
      }
    }

    const promptContent =
      reusedWarmConversation && feedback
        ? buildRetryFeedbackPrompt(promptTask, feedback)
        : reusedWarmConversation && (task.turnMode === 'append' || task.turnMode === 'pivot') && !feedback
          ? buildDeltaPrompt(promptTask, missing)
          : buildPrompt(promptTask, feedback, missing);

    this.live.set(task.id, conversation);
    try {
      const submission = await conversation.submit(
        { type: 'input', content: promptContent },
        ctx,
      );
      const settled = await submission.wait(ctx);

      const after = await harness.usage(ctx);
      const delta = diffTokenDetails(before, after);
      const costDelta = diffCostBreakdown(before, after);
      const fallbackCost = calculateTokenCost(delta, this.deps.price(model));
      const providerCostUsd =
        costDelta.providerCostUsd > 0 ? costDelta.providerCostUsd : undefined;
      const configuredCostUsd =
        Math.max(costDelta.configuredCostUsd, fallbackCost) || undefined;
      const effectiveCost = providerCostUsd ?? configuredCostUsd ?? 0;
      const costSource: 'provider' | 'configured' | 'unpriced' = providerCostUsd
        ? 'provider'
        : configuredCostUsd
          ? 'configured'
          : 'unpriced';
      const spent = delta.total;
      const finishedAt = Date.now();
      const usageRecord = {
        input: delta.input,
        output: delta.output,
        cacheRead: delta.cacheRead,
        cacheWrite: delta.cacheWrite,
        ...(delta.reasoning > 0 ? { reasoning: delta.reasoning } : {}),
        total: spent,
        ...(effectiveCost > 0 ? { costUsd: effectiveCost } : {}),
        ...(providerCostUsd ? { providerCostUsd } : {}),
        ...(configuredCostUsd ? { configuredCostUsd } : {}),
        costSource,
        providerId: model.providerId,
        modelId: model.modelId,
        startedAt: callStartedAt,
        finishedAt,
        durationMs: finishedAt - callStartedAt,
        conversationId: String(conversation.id),
        status: settled.status === 'done' ? ('ok' as const) : ('interrupted' as const),
      };
      this.deps.recordUsage?.({
        taskId: task.id,
        ...(task.workerId ? { workerId: task.workerId } : {}),
        ...usageRecord,
      });
      const answerEntry =
        settled.status === 'done' && settled.type === 'input'
          ? await conversation.commit((tx) => tx.entry(settled.answer), ctx).catch(() => undefined)
          : undefined;
      const answer = assistantText(answerEntry);
      const stopMeta = assistantStopMeta(answerEntry);
      const truncatedNoTools = stopMeta.stopReason === 'length' && recordedTools === 0;
      if (truncatedNoTools) {
        recorder?.record({
          kind: 'error',
          name: '输出截断',
          ok: false,
          argsDigest: '模型思考或回复超出最大输出限制，未调用任何工具',
        });
      } else if (stopMeta.stopReason === 'error') {
        recorder?.record({
          kind: 'error',
          name: '模型响应异常',
          ok: false,
          argsDigest: stopMeta.errorMessage || 'stopReason=error',
        });
      } else if (settled.status === 'done' && recordedTools === 0) {
        recorder?.record({
          kind: 'decision',
          name: '纯文本回复',
          ok: true,
          argsDigest: answer || '未调用工具直接结束本轮',
        });
      }

      if (spent > 0 || effectiveCost > 0) {
        reportUsage?.(usageRecord);
        log(
          effectiveCost > 0
            ? `模型用量：${spent} tokens · $${effectiveCost.toFixed(4)}`
            : `模型用量：${spent} tokens（未配置价格）`,
        );
        recorder?.record({
          kind: 'usage',
          name: '模型用量',
          ok: true,
          tokens: spent,
          argsDigest: effectiveCost > 0 ? `$${effectiveCost.toFixed(4)}` : '',
        });
      }

      if (settled.status !== 'done') {
        throw new Error(`pi 循环未完成（${settled.status}）`);
      }
      if (task.workerId && this.deps.onWorkerConversation && typeof conversation.context === 'function') {
        const postView = await conversation.context(ctx).catch(() => undefined);
        const tail = postView?.entries[postView.entries.length - 1];
        this.deps.onWorkerConversation(task.workerId, String(conversation.id), tail ? Number(tail.id) : null);
      }
      log('pi 循环结束');
      return {
        ...(answer ? { answer } : {}),
        ...(truncatedNoTools ? { truncatedNoTools: true } : {}),
        ...(stopMeta.stopReason ? { stopReason: stopMeta.stopReason } : {}),
      };
    } catch (error) {
      // 失败也要留痕：这是事后回答"它为什么没干完"唯一的证据。
      recorder?.record({
        kind: 'error',
        name: '执行失败',
        ok: false,
        argsDigest: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // 一定要在这里删：留着它，下一次"插话"会插进一条已经结束的会话。
      this.live.delete(task.id);
      stopTrace?.();
      stopApproval?.();
    }
  }
}

/**
 * 一次尝试的提示词。导出是因为它是**契约**：你改的方向、工作台规定、验收反馈各自
 * 以什么顺序、什么口吻进到执行体眼前，是这套系统对外承诺的一部分，值得单独测。
 */
export function buildPrompt(
  task: WorkTask,
  feedback?: AcceptanceFeedback,
  missingAttachments: ReadonlyArray<{ name: string; path: string; reason: string }> = [],
): string {
  const contract = task.contract ?? {
    objective: task.brief,
    deliverable: task.deliverableSpec,
    outputs: [],
  };
  const objectiveText = contract.objective.trim();
  const briefText = task.brief.trim();
  const deliverableText = contract.deliverable.trim();
  const lines = [
    `你要完成下面的交付契约。可以自由选择工具、文件和最终回答来完成，不要为了满足系统要求创建无关文件。`,
    '',
    `任务：${task.title}`,
    ...(objectiveText && objectiveText !== briefText ? [`目标：${contract.objective}`] : []),
    ...(briefText ? [`说明：${task.brief}`] : []),
    ...(deliverableText && deliverableText !== objectiveText && deliverableText !== briefText
      ? [`交付物：${contract.deliverable}`]
      : []),
    '输出：',
  ];

  for (const output of contract.outputs) {
    lines.push(
      output.kind === 'file'
        ? `- 文件 ${normalizeWorkspaceRelPath(output.path)}：${output.description}`
        : `- 文本回答：${output.description}`,
    );
  }

  if (contract.attachments?.length) {
    lines.push('', '本次任务已由系统复制到你工作区 inputs/ 目录的附件（请直接用工作区相对路径读取，不要去访问用户原始外部路径或让用户手动拖拽）：');
    for (const attachment of contract.attachments) {
      lines.push(`- ${attachment.name} · ${attachment.size} bytes · ${attachment.path}`);
    }
    lines.push('如读取或处理失败请如实汇报具体原因，不要猜测内容。');
  }
  if (missingAttachments.length > 0) {
    lines.push('', '注意：以下附件未能复制到工作区（请如实向用户说明具体原因，不要猜测内容）：');
    for (const item of missingAttachments) {
      lines.push(`- ${item.name}：${item.reason}`);
    }
  }

  // 原始记录（§3.3）：给 ID + 摘要，全文用 recall 取。排在"要求"之前、说明之后——
  // 它是对这份说明的**证据**，不是又一条要求。
  if (task.records && task.records.length > 0) {
    lines.push('', '这件事的原始记录（要看全文就 recall <id>）：');
    for (const record of task.records) {
      lines.push(`- ${record.kind} ${record.id} · ${record.title}`);
      // 摘要本身是多行的（头 + 略去多少 + 尾），缩进两格才不会被当成并列条目。
      for (const line of record.excerpt.split('\n')) lines.push(`  ${line}`);
    }
  }

  /*
   * 子任务的产出（团队收口）。排在原始记录之后、"要求"之前：它们是**已经做完的那部分
   * 活**，不是又一条要求，也不是背景——父的交付物要把它们合成进去。
   *
   * 最后那句提醒是给这一层用的：子任务各自有工作目录，父读不到里面的东西（沙箱只放行
   * 它自己那个可写根）。不说清楚，模型会以为自己能 `cat` 到，然后花几步撞墙。
   */
  if (task.children && task.children.length > 0) {
    lines.push('', '子任务的产出（你是这条线的收口人，交付物要把它们合进去）：');
    for (const child of task.children) {
      lines.push(`- ${child.title} · ${child.id} · ${childStatusLabel(child.status)}`);
      if (child.artifacts.length > 0) lines.push(`  产物：${child.artifacts.join('、')}`);
      if (child.reason) lines.push(`  结论：${child.reason}`);
      if (child.verdict === null) lines.push('  （没有闸门能判它对不对——别当它已经对了。）');
    }
    lines.push(
      '  需要看某一份的内容就用 recall 取；它们的文件不在你的工作目录里，别照着重新做一遍。',
    );
  }

  lines.push(
    '',
    `要求：`,
    '1. 按当前目标与输出要求完成交付；在同一工作区内可以增量迭代并保留先前有用产物。',
    '2. 用 bash 做**离线**检查（例如 `node --check server.js`）；**不要**启动长驻服务、不要访问网络——',
    '   沙箱会阻断出网，而系统会在沙箱外用真实验收脚本启动并判定。',
    '3. 确认无误后立即结束；如果要求文本回答，把结论放在最终回答里。',
    '4. 若声明了文件输出，请直接写入对应工作区相对路径；写较大文件或脚本时请分步落盘，避免在单次思考中输出过长导致截断。',
    '5. 最短路径直出：若当前工具清单已有专用生成工具（如 generate_image / generate_video / text_to_speech），直接一步传入目标工作区相对路径（如 output/xxx.png）生成即可；落盘成功后立即结束汇报，不要再 read 大图自检，也不要写额外脚本重复核验或格式转换。',
    '6. 工具边界与止损：可用工具仅限当前已挂载工具与 tool_search；严禁用 bash 翻查 OPC 程序目录、数据库或扫描本机端口去寻找工具。若缺少所需能力或同一方向连续失败 2 次，立即如实汇报或改换思路，禁止无意义空转。',
    '7. 合并批量调用、禁止串行空转：彼此独立的多个文件写入（write）、生图（generate_image）或检查命令务必在同一回合并发调用或合并进单个 bash 脚本，禁止把多个文件拆成多轮逐个 write；若确需视觉自检多页成品（如 PPT/PDF 预览），先用脚本把多页拼成 1 张 1600px 宽的 JPEG 拼图再 read 1 次，禁止逐页反复 read 多张高分辨率 PNG。',
  );

  /*
   * 他回答了你请示的问题。单独一段、排在"改方向"之前：这是**对你那句问话的回复**，
   * 不是你换了需求。混在一起模型会重新做一遍，而它该做的是接着做。
   */
  const answers = (task.steering ?? []).filter((entry) => entry.kind === 'answer');
  if (answers.length > 0) {
    lines.push('', '他回答了你请示的问题（照这个做，不要再问一遍）：');
    for (const entry of answers) lines.push(`- ${entry.note}`);
  }

  // 你改的方向排在"要求"之后：它是后说的，而且与原说明冲突时以它为准。
  const steers = (task.steering ?? []).filter((entry) => entry.kind !== 'answer');
  if (steers.length > 0) {
    lines.push('', '用户在做这件事的过程中改了方向（**与上面的说明冲突时，以这里为准**）：');
    for (const entry of steers) lines.push(`- ${entry.note}`);
  }

  if (task.memoryCore?.trim()) {
    lines.push('', '用户环境、习惯与长期铁律（必须遵守）：', task.memoryCore.trim());
  }

  if (task.memoryPlaybook && task.memoryPlaybook.length > 0) {
    lines.push('', '历史避坑提醒（动手前务必先核对，避免重复踩坑）：');
    for (const tip of task.memoryPlaybook) lines.push(`- ${tip}`);
  }

  if (task.facts && task.facts.length > 0) {
    lines.push('', '工作台的规定（必须遵守，优先级高于你的习惯）：');
    for (const fact of task.facts) lines.push(`- ${fact.statement}`);
  }

  if (task.memoryTopics && task.memoryTopics.length > 0) {
    lines.push('', '相关专题与背景知识：');
    for (const topic of task.memoryTopics) lines.push(`- ${topic}`);
  }

  if (feedback) {
    lines.push('', `注意：上一版没有通过系统验收（第 ${feedback.attempt} 次）：${feedback.reason}`);
    if (feedback.truncatedNoTools) {
      lines.push('重要提示：上一轮思考超长触及输出上限被截断且未调用任何工具。请不要在思考中草拟整篇代码或文本，先调用工具探索/分步写入文件。');
    }
    if (feedback.existingFiles && feedback.existingFiles.length > 0) {
      lines.push(`当前工作区已检测到以下文件（若已生成但路径不符可直接移动/重命名）：${feedback.existingFiles.join('、')}`);
    }
    if (feedback.evidence.command[0] !== 'opc') {
      lines.push(
        `退出码：${feedback.evidence.exitCode ?? 'null'}`,
        `stdout：${feedback.evidence.stdoutTail || '(空)'}`,
        `stderr：${feedback.evidence.stderrTail || '(空)'}`,
      );
    }
    lines.push('请修复问题后重新验证。');
  }

  return lines.join('\n');
}

/**
 * Concise retry prompt used when reusing an already-populated conversation (`attempt >= 2`),
 * avoiding re-injecting the entire cold-start contract, records, and memory pack.
 */
export function buildRetryFeedbackPrompt(task: WorkTask, feedback: AcceptanceFeedback): string {
  const contract = task.contract ?? {
    objective: task.brief,
    deliverable: task.deliverableSpec,
    outputs: [],
  };
  const lines = [
    `上一轮（第 ${feedback.attempt} 次尝试）未通过系统验收：${feedback.reason}`,
  ];
  if (feedback.truncatedNoTools) {
    lines.push(
      '',
      '纠偏提醒：上一轮模型思考过长触及输出上限被截断，未调用任何工具。请简短思考，立即调用工具分步写入文件或检查工作区，不要在思考中草拟整篇脚本或内容。',
    );
  }
  if (contract.outputs.length > 0) {
    lines.push('', '契约要求最终交付：');
    for (const output of contract.outputs) {
      lines.push(
        output.kind === 'file'
          ? `- 文件 ${normalizeWorkspaceRelPath(output.path)}：${output.description}`
          : `- 文本回答：${output.description}`,
      );
    }
  }
  if (feedback.existingFiles && feedback.existingFiles.length > 0) {
    lines.push('', `当前工作区已检测到的文件：${feedback.existingFiles.join('、')}`);
    lines.push('如果最终产物已在上述文件中但路径/文件名与契约不一致，可直接移动或复制到声明路径，无需从头重做。');
  }
  if (feedback.evidence.command[0] !== 'opc') {
    lines.push(
      '',
      `验收命令退出码：${feedback.evidence.exitCode ?? 'null'}`,
      `stdout：${feedback.evidence.stdoutTail || '(空)'}`,
      `stderr：${feedback.evidence.stderrTail || '(空)'}`,
    );
  }
  lines.push('', '请直接修复上述问题并在验证无误后立即结束。');
  return lines.join('\n');
}

/**
 * Concise delta prompt used when a Living Worker resumes an existing warm conversation
 * (`turnMode: 'append' | 'pivot'`). Avoids repeating full cold-start boilerplate.
 */
export function buildDeltaPrompt(
  task: WorkTask,
  missingAttachments: ReadonlyArray<{ name: string; path: string; reason: string }> = [],
): string {
  const contract = task.contract ?? {
    objective: task.brief,
    deliverable: task.deliverableSpec,
    outputs: [],
  };
  const header =
    task.turnMode === 'pivot'
      ? '用户调整了方向（已清理上一轮跑偏尝试，请保留工作区中仍有用的部分并按新方向继续）：'
      : '用户基于你当前的工作区和成果提出了增量要求（直接在此基础上修改/追加即可，无需从头推倒）：';
  const lines = [
    header,
    '',
    `新指令：${contract.objective}`,
    ...(contract.deliverable && contract.deliverable !== contract.objective ? [`期望交付：${contract.deliverable}`] : []),
  ];
  if (contract.outputs.length > 0) {
    lines.push('更新后的输出要求：');
    for (const output of contract.outputs) {
      lines.push(
        output.kind === 'file'
          ? `- 文件 ${output.path}：${output.description}`
          : `- 文本回答：${output.description}`,
      );
    }
  }
  if (contract.attachments?.length) {
    lines.push('', '本次任务工作区 inputs/ 目录中已就绪的附件（请直接用工作区相对路径读取，不要访问外部路径或让用户手动拖拽）：');
    for (const attachment of contract.attachments) {
      lines.push(`- ${attachment.name} · ${attachment.size} bytes · ${attachment.path}`);
    }
  }
  if (missingAttachments.length > 0) {
    lines.push('', '注意：以下附件未能复制到工作区（请如实向用户说明具体原因）：');
    for (const item of missingAttachments) {
      lines.push(`- ${item.name}：${item.reason}`);
    }
  }
  if (task.memoryPlaybook && task.memoryPlaybook.length > 0) {
    lines.push('', '历史避坑提醒（本次增量修改也请留意）：');
    for (const tip of task.memoryPlaybook) lines.push(`- ${tip}`);
  }
  lines.push(
    '',
    '按最短路径完成改动：多个独立 write / generate_image 请同回合并发调用或合并进单次 bash；专用生成工具落盘后无需 read 大图或重复核验。若确需视觉自检多页预览，先用脚本拼成 1 张 1600px 宽的 JPEG 拼图再调用 1 次 read，禁止逐页反复 read 高分辨率 PNG；最后简洁说明结果。',
  );
  return lines.join('\n');
}

function assistantText(entry: { model?: readonly unknown[] } | undefined): string {
  if (!entry?.model) return '';
  const parts: string[] = [];
  for (const message of entry.model) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) parts.push(text.trim());
      }
    }
  }
  return parts.join('\n').trim();
}

function assistantStopMeta(entry: { model?: readonly unknown[] } | undefined): {
  stopReason?: string;
  errorMessage?: string;
} {
  if (!entry?.model) return {};
  for (const message of entry.model) {
    if (typeof message !== 'object' || message === null) continue;
    const item = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (item.role === 'assistant') {
      return {
        ...(typeof item.stopReason === 'string' ? { stopReason: item.stopReason } : {}),
        ...(typeof item.errorMessage === 'string' ? { errorMessage: item.errorMessage } : {}),
      };
    }
  }
  return {};
}
