import type { ContextEdit, Conversation, EntryId, Harness } from "@earendil-works/pi-durable";
import type { ModelRef, RouterContextStats } from "@opc/shared/domain";
import { diffCostBreakdown, diffTokenDetails } from "../work/usage";

export const ROUTER_COMPACT_INSTRUCTIONS = [
  "你正在压缩常驻 Personal Agent Router 的控制面上下文。",
  "请仅保留：",
  "1. 用户的明确目标、决定、约束和最新方向变更；",
  "2. 当前活跃或最近可复用的工作线（threadId、核心状态、最新产物/结论）；",
  "3. 尚未解决的问题或待用户确认事项。",
  "请彻底丢弃：已结束/已取消的中间推理、重复的工具查询输出、失败后已改道的尝试过程。",
  "输出简明扼要的结构化中文摘要。",
].join("\n");

const DEFAULT_CONTEXT_WINDOW = 128_000;
const SOFT_COMPACT_TOKEN_CAP = 28_000;
const SOFT_COMPACT_RATIO = 0.35;

/** Thrown when an active Router turn is intentionally preempted or aborted. */
export class RouterInterruptedError extends Error {
  readonly reason: string;

  constructor(reason = "aborted") {
    super(`Router 一轮已中断（${reason}）`);
    this.name = "RouterInterruptedError";
    this.reason = reason;
  }
}

/**
 * Router 的常驻会话。
 *
 * 这是 v2 里最容易做错的一件事，所以先把话说死：**Router 是一个会话，不是一个
 * 请求处理器**。它有自己的历史、自己的上下文窗口、自己的压缩策略，跨信道、跨
 * 任务地连续（§2「连续」）。如果每一轮都新建会话，你在 IM 上说过"用方案 A"、
 * 十分钟后在别处改成"方案 B"，Router 不会知道——那就不叫连续。
 *
 * pi 的 inbox 帮我们做掉了 §2.1 的批处理：会话忙的时候新输入进队列，在下一个
 * boundary 合并成一次 LLM 调用。所以这里**不需要自己攒批**——`deliver` 只管把
 * 输入交上去，攒批是运行时的事。原文 7.2 量过这个效果：事件速率从 1/min 升到
 * 40/min，批大小 1.0→2.8，但单次请求耗时只从 2.5s 涨到 3.9s，单决定分摊的推理
 * 时间反而从 6.4s 降到 1.6s。
 *
 * 同一份 sqlite（`agents/router.sqlite`）落盘，所以进程重启后 Router 记得之前
 * 发生过什么（§6「持久」的一半）。
 */
export interface RouterSessionDeps {
  /** 打开（或复用）`router` 这个 harness。 */
  harness: () => Promise<Harness>;
  /** Discard a harness whose durable session was poisoned by a storage failure. */
  resetHarness?: () => Promise<void>;
  /** pi 的 context：主进程里是后台上下文。 */
  context: () => Promise<unknown>;
  /** Router 用哪个模型。轻量即可（§2.1：常见判断不复杂）。 */
  model: () => ModelRef | null;
  /** Thinking level，跟设置走；Router 不需要很深。 */
  thinking: () => string;
  /** 工作目录。Router 没有文件工具，但 pi 需要一个 cwd。 */
  cwd: () => string;
  /** 观测用：一轮跑完时回报用量。 */
  onTurn?: (info: { ok: boolean; error?: string }) => void;
  onUsage?: (usage: {
    providerId: string;
    modelId: string;
    conversationId: string;
    startedAt: number;
    finishedAt: number;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
    providerCostUsd?: number;
    configuredCostUsd?: number;
    status: "ok" | "interrupted";
  }) => void;
  /** Visible assistant text from pi.live while the Router is generating. */
  onText?: (text: string) => void;
  /** The live document entered a tool round; any plain-text preamble is transient. */
  onToolRound?: () => void;
  /** Current router model's context window size in tokens (used for soft compaction threshold). */
  contextWindow?: () => number;
  /** Called whenever context stats refresh (after turn, prune, compact, or reset). */
  onContextStats?: (stats: RouterContextStats) => void;
}

interface RecordedTurnRange {
  threadIds: Set<string>;
  fromEntryId: EntryId;
  toEntryId: EntryId;
  collapsed: boolean;
}

export class RouterSession {
  private conversation: Conversation | null = null;
  /** Share the first root creation across simultaneous deliveries. */
  private opening: Promise<Conversation> | null = null;
  /** 已经交上去、还没 settle 的轮次。用于避免无意义的并发提交。 */
  private pending = 0;
  private lastError: string | null = null;
  private activeTurnBaselineId: EntryId | null = null;
  private activeTurnThreadIds = new Set<string>();
  private readonly turnRanges: RecordedTurnRange[] = [];
  private prunedCount = 0;
  private compacting = false;
  private aborting = false;
  private lastStats: RouterContextStats = {
    estimatedTokens: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    usageRatio: 0,
    entryCount: 0,
    prunedCount: 0,
    busy: false,
    compacting: false,
  };

  constructor(private readonly deps: RouterSessionDeps) {}

  /** Records that the current Router turn interacted with a thread (for later collapse). */
  noteThreadTouched(threadId: string): void {
    if (threadId) this.activeTurnThreadIds.add(threadId);
  }

  /** 有活正在想。tick 看到它为 true 就不必着急。 */
  get busy(): boolean {
    return this.pending > 0;
  }

  get error(): string | null {
    return this.lastError;
  }

  /**
   * 常驻会话只开一次。
   *
   * 模型与 thinking 在每轮开始时按当前设置重新配置：你在设置里换了模型，
   * 下一句就该用新模型，而不是重启应用。
   */
  private async ensure(): Promise<Conversation> {
    if (this.conversation) {
      await this.reconfigure(this.conversation);
      return this.conversation;
    }

    if (!this.opening) this.opening = this.openConversation();
    const opening = this.opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async openConversation(): Promise<Conversation> {
    const harness = await this.deps.harness();
    const context = await this.deps.context();
    let conversation: Conversation;
    try {
      conversation = await harness.root(context as never);
    } catch (error) {
      await this.deps.resetHarness?.();
      throw error;
    }
    this.conversation = conversation;
    await this.reconfigure(conversation);
    return conversation;
  }

  private async reconfigure(conversation: Conversation): Promise<void> {
    const model = this.deps.model();
    if (!model) return;
    const context = await this.deps.context();
    await conversation
      .configure(
        {
          model: { provider: model.providerId, modelId: model.modelId },
          thinkingLevel: (this.deps.thinking() ?? "medium") as never,
          cwd: this.deps.cwd(),
        } as never,
        context as never,
      )
      .catch(() => undefined);
  }

  /**
   * 把一段输入交给 Router。
   *
   * 这里会 await 本轮 settle：只有确认 Router 会话真的接住了输入，调度层才可以把
   * event/report 标记从可重试状态移走。新的事件在本轮期间由 Router 的单飞 tick
   * 留在数据库，当前轮结束后自动触发下一轮；不能为了“立即返回”重新引入静默丢事件。
   */
  deliver = async (text: string): Promise<string> => {
    return this.run(text);
  };

  private async run(text: string): Promise<string> {
    this.pending += 1;
    try {
      const conversation = await this.ensure();
      const context = await this.deps.context();
      const selectedModel = this.deps.model();
      const harness = await this.deps.harness();
      const usageReader =
        typeof harness.usage === "function"
          ? harness.usage.bind(harness)
          : null;
      const usageBefore = usageReader
        ? await usageReader(context as never)
        : null;
      const callStartedAt = Date.now();
      this.activeTurnThreadIds = new Set<string>();
      this.activeTurnBaselineId = await this.tailEntryId(conversation, context);
      // pi-durable already publishes throttled generation partials in pi.live.
      // Watch that document instead of opening a second model request or writing
      // one chat row per token.
      const watch =
        this.deps.onText || this.deps.onToolRound
          ? await conversation.watch(context as never)
          : null;
      // A completed turn can remain in the live document until the next
      // generation begins. Treat that snapshot as the baseline so a new turn
      // never replays the previous answer into the chat.
      let latestText = textFromLive(watch?.value.docs["pi.live"]);
      let toolRoundActive = false;
      // Watch callbacks are asynchronous and `stop()` intentionally does not
      // wait for a callback that is already running. Track the tail explicitly:
      // otherwise a final delta can arrive after `finishRouterStream` and turn
      // the completed message back into a permanently blinking stream.
      let watchCallbackTail = Promise.resolve();
      watch?.start((call) => {
        const process = watchCallbackTail.then(() => {
          if (call.kind !== "value") return;
          const live = call.value.docs["pi.live"];
          if (hasLiveToolRound(live)) {
            if (!toolRoundActive) {
              toolRoundActive = true;
              try {
                this.deps.onToolRound?.();
              } catch (error) {
                console.warn("[router] 工具阶段清理流式回复失败", error);
              }
            }
          } else {
            toolRoundActive = false;
          }
          const next = textFromLive(live);
          if (!next || next === latestText) return;
          latestText = next;
          try {
            this.deps.onText?.(next);
          } catch (error) {
            // Rendering is a best-effort side channel; it must never fail the
            // durable Router submission.
            console.warn("[router] 流式回复推送失败", error);
          }
        });
        // Keep the chain resolved even if a future observer implementation
        // throws outside the guarded rendering callbacks.
        watchCallbackTail = process.catch((error) => {
          console.warn("[router] 处理流式观察更新失败", error);
        });
        return watchCallbackTail;
      });
      const submission = await conversation.submit(
        { type: "input", content: text },
        context as never,
      );
      try {
        const settled = await submission.wait(context as never);
        const ok = settled.status === "done";
        if (usageReader && usageBefore) {
          const usageAfter = await usageReader(context as never);
          const usageDelta = diffTokenDetails(usageBefore, usageAfter);
          const costDelta = diffCostBreakdown(usageBefore, usageAfter);
          this.deps.onUsage?.({
            ...(selectedModel
              ? {
                  providerId: selectedModel.providerId,
                  modelId: selectedModel.modelId,
                }
              : { providerId: "unknown", modelId: "unknown" }),
            conversationId: String(conversation.id),
            startedAt: callStartedAt,
            finishedAt: Date.now(),
            input: usageDelta.input,
            output: usageDelta.output,
            cacheRead: usageDelta.cacheRead,
            cacheWrite: usageDelta.cacheWrite,
            ...(usageDelta.reasoning > 0 ? { reasoning: usageDelta.reasoning } : {}),
            total: usageDelta.total,
            ...(costDelta.providerCostUsd > 0
              ? { providerCostUsd: costDelta.providerCostUsd }
              : {}),
            ...(costDelta.configuredCostUsd > 0
              ? { configuredCostUsd: costDelta.configuredCostUsd }
              : {}),
            status: ok ? "ok" : "interrupted",
          });
        }
        if (!ok) {
          const reason =
            "reason" in settled && typeof settled.reason === "string" && settled.reason.trim()
              ? settled.reason.trim()
              : settled.status;
          if (this.aborting || reason === "aborted") {
            throw new RouterInterruptedError(reason);
          }
          // A submission that settles as failed was not delivered. Throw it back to
          // Router.tick so its routed/announced markers can be rolled back.
          throw new Error(`Router 一轮未完成（${settled.status}: ${reason}）`);
        }
        // The final commit may be folded into the watch while its callback is
        // still queued. Read the watch's current view before stopping it so the
        // host can always commit the complete answer even when no last delta was
        // dispatched.
        const finalText = textFromLive(watch?.value.docs["pi.live"]);
        if (finalText) latestText = finalText;
        this.lastError = null;
        await this.recordCompletedTurnRange(conversation, context);
        this.deps.onTurn?.({ ok: true });
        void this.refreshStatsAndMaybeCompact(conversation, context);
        return latestText;
      } finally {
        this.activeTurnBaselineId = null;
        await watch?.stop();
        // `stop()` prevents new calls but may return while the last callback is
        // still running. Drain it before the host emits the final/clear event.
        await watchCallbackTail;
      }
    } catch (error) {
      if (error instanceof RouterInterruptedError) {
        throw error;
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      // 抛回 Router.tick：tick 会撤销 routed/announced 标记，下一轮才能重试。
      // 调度循环本身仍由 index.ts 的 pushTick 捕获，不会拖垮应用。
      console.error("[router] 一轮失败", error);
      this.deps.onTurn?.({ ok: false, error: this.lastError });
      throw error;
    } finally {
      this.pending -= 1;
    }
  }

  /**
   * Immediately aborts the active Router generation and prunes its partial/dead
   * branch from the active model context using pi-durable ContextEdit (non-destructive).
   */
  abortCurrent = async (reason = "user_interrupt"): Promise<boolean> => {
    const conversation = this.conversation;
    if (!conversation) return false;
    const context = await this.deps.context();
    const baselineId = this.activeTurnBaselineId;
    this.aborting = true;
    try {
      if (typeof conversation.abort === "function") {
        await conversation.abort(context as never).catch(() => undefined);
      }
      if (baselineId !== null) {
        await this.pruneEntriesAfter(
          conversation,
          context,
          baselineId,
          `[已打断并清理该死分支：${reason}]`,
        );
      }
      await this.refreshStats(conversation, context).catch(() => undefined);
      return true;
    } finally {
      this.aborting = false;
    }
  };

  /**
   * Collapses completed/aborted thread turns in Router's active context into a
   * single concise tombstone so finished threads stop polluting the window.
   */
  collapseThreadTurns = async (threadId: string, summary: string): Promise<number> => {
    const conversation = this.conversation;
    if (!conversation || this.pending > 0) return 0;
    const targets = this.turnRanges.filter(
      (range) => !range.collapsed && range.threadIds.size === 1 && range.threadIds.has(threadId),
    );
    if (targets.length === 0) return 0;
    const context = await this.deps.context();
    const view = await this.readContext(conversation, context);
    if (!view) return 0;

    const edits: ContextEdit[] = [];
    let replacedFirst = false;
    const cleanSummary = summary.replace(/\s+/g, " ").trim().slice(0, 160);
    for (const range of targets) {
      for (const entry of view.entries) {
        if (Number(entry.id) <= Number(range.fromEntryId) || Number(entry.id) > Number(range.toEntryId)) {
          continue;
        }
        if (entry.kind === "pi.system" || entry.kind === "pi.system_patch" || entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
          continue;
        }
        if (!replacedFirst) {
          replacedFirst = true;
          edits.push({
            target: entry.id,
            action: "replace",
            messages: [
              {
                role: "user",
                content: `[已完成工作线 ${threadId} 折叠摘要] ${cleanSummary || "已结束"}`,
                timestamp: Date.now(),
              } as never,
            ],
          });
        } else {
          edits.push({ target: entry.id, action: "omit" });
        }
      }
      range.collapsed = true;
    }

    if (edits.length === 0) return 0;
    await this.submitPruneEdits(conversation, context, edits, { reason: "thread_collapse", threadId });
    await this.refreshStats(conversation, context).catch(() => undefined);
    return edits.length;
  };

  /** Returns live Router context window health statistics. */
  contextStats = async (): Promise<RouterContextStats> => {
    const conversation = this.conversation;
    if (!conversation) {
      const windowSize = this.resolveContextWindow();
      return { ...this.lastStats, contextWindow: windowSize, busy: this.busy, compacting: this.compacting };
    }
    const context = await this.deps.context();
    return this.refreshStats(conversation, context);
  };

  /** Runs targeted background compaction on the Router conversation. */
  compactNow = async (instructions = ROUTER_COMPACT_INSTRUCTIONS): Promise<{ ok: boolean; reason?: string }> => {
    if (this.compacting) return { ok: false, reason: "正在压缩上下文" };
    const conversation = await this.ensure();
    if (typeof conversation.compact !== "function") {
      return { ok: false, reason: "当前会话不支持压缩" };
    }
    this.compacting = true;
    try {
      const context = await this.deps.context();
      await conversation.compact(instructions, context as never);
      await this.refreshStats(conversation, context).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.compacting = false;
    }
  };

  /** Resets Router's active context to a fresh focus while preserving a concise handoff. */
  resetTopic = async (handoff?: string): Promise<{ ok: boolean; reason?: string }> => {
    const conversation = await this.ensure();
    if (typeof conversation.reset !== "function") {
      return { ok: false, reason: "当前会话不支持重置焦点" };
    }
    const context = await this.deps.context();
    if (this.busy && typeof conversation.abort === "function") {
      await conversation.abort(context as never).catch(() => undefined);
    }
    await conversation.reset(
      handoff?.trim() || "用户主动清理了当前对话上下文并开启新的焦点。之前的历史记录已归档，如需查证可按需使用 recall 或 recall_memory。",
      context as never,
    );
    this.turnRanges.length = 0;
    await this.refreshStats(conversation, context).catch(() => undefined);
    return { ok: true };
  };

  /** 等当前所有轮次落定。探针和退出流程用。 */
  settle = async (): Promise<void> => {
    while (this.pending > 0)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };

  // ── context hygiene internals ──────────────────────────────────────────

  private resolveContextWindow(): number {
    const configured = this.deps.contextWindow?.();
    return configured && configured > 0 ? configured : DEFAULT_CONTEXT_WINDOW;
  }

  private async readContext(conversation: Conversation, context: unknown) {
    if (typeof conversation.context !== "function") return null;
    try {
      return await conversation.context(context as never);
    } catch {
      return null;
    }
  }

  private async tailEntryId(conversation: Conversation, context: unknown): Promise<EntryId | null> {
    const view = await this.readContext(conversation, context);
    const last = view?.entries[view.entries.length - 1];
    return last ? last.id : null;
  }

  private async recordCompletedTurnRange(conversation: Conversation, context: unknown): Promise<void> {
    if (this.activeTurnBaselineId === null || this.activeTurnThreadIds.size === 0) return;
    const endId = await this.tailEntryId(conversation, context);
    if (endId === null || Number(endId) <= Number(this.activeTurnBaselineId)) return;
    this.turnRanges.push({
      threadIds: new Set(this.activeTurnThreadIds),
      fromEntryId: this.activeTurnBaselineId,
      toEntryId: endId,
      collapsed: false,
    });
    if (this.turnRanges.length > 60) this.turnRanges.shift();
  }

  private async pruneEntriesAfter(
    conversation: Conversation,
    context: unknown,
    baselineId: EntryId,
    tombstone: string,
  ): Promise<number> {
    const view = await this.readContext(conversation, context);
    if (!view) return 0;
    const targets = view.entries.filter(
      (entry) =>
        Number(entry.id) > Number(baselineId) &&
        entry.kind !== "pi.system" &&
        entry.kind !== "pi.system_patch" &&
        entry.kind !== "pi.compaction" &&
        entry.kind !== "pi.reset",
    );
    if (targets.length === 0) return 0;
    const edits: ContextEdit[] = targets.map((entry, index) =>
      index === 0
        ? {
            target: entry.id,
            action: "replace",
            messages: [
              {
                role: "user",
                content: tombstone,
                timestamp: Date.now(),
              } as never,
            ],
          }
        : { target: entry.id, action: "omit" },
    );
    await this.submitPruneEdits(conversation, context, edits, { reason: "interrupt_prune" });
    return edits.length;
  }

  private async submitPruneEdits(
    conversation: Conversation,
    context: unknown,
    edits: readonly ContextEdit[],
    meta: Record<string, string>,
  ): Promise<void> {
    if (edits.length === 0 || typeof conversation.submit !== "function") return;
    try {
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "opc.prune",
            data: { ...meta, count: edits.length, at: Date.now() },
            edits,
          },
        } as never,
        context as never,
      );
      this.prunedCount += edits.length;
    } catch (error) {
      console.warn("[router] ContextEdit prune failed", error);
    }
  }

  private async refreshStats(conversation: Conversation, context: unknown): Promise<RouterContextStats> {
    const view = await this.readContext(conversation, context);
    const contextWindow = this.resolveContextWindow();
    const estimatedTokens = view ? estimateMessagesTokens(view.messages) : 0;
    const stats: RouterContextStats = {
      estimatedTokens,
      contextWindow,
      usageRatio: contextWindow > 0 ? Math.min(1, estimatedTokens / contextWindow) : 0,
      entryCount: view?.entries.length ?? 0,
      prunedCount: this.prunedCount,
      busy: this.busy,
      compacting: this.compacting,
    };
    this.lastStats = stats;
    this.deps.onContextStats?.(stats);
    return stats;
  }

  private async refreshStatsAndMaybeCompact(conversation: Conversation, context: unknown): Promise<void> {
    try {
      const stats = await this.refreshStats(conversation, context);
      const softThreshold = Math.min(
        SOFT_COMPACT_TOKEN_CAP,
        Math.floor(stats.contextWindow * SOFT_COMPACT_RATIO),
      );
      if (stats.estimatedTokens >= softThreshold && !this.compacting) {
        void this.compactNow(ROUTER_COMPACT_INSTRUCTIONS);
      }
    } catch {
      // Best-effort telemetry & soft compaction.
    }
  }
}

/** Rough conservative token estimator (~3 chars per token for mixed CJK/English). */
export function estimateMessagesTokens(messages: readonly unknown[]): number {
  let chars = 0;
  for (const message of messages) {
    try {
      chars += JSON.stringify(message).length;
    } catch {
      chars += 64;
    }
  }
  return Math.ceil(chars / 3);
}

/** Extract only user-facing text; thinking and tool-call arguments stay hidden. */
export function textFromLive(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const generation = (value as { generation?: unknown }).generation;
  if (!generation || typeof generation !== "object") return "";
  const message = (generation as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text?: unknown } =>
      Boolean(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text",
      ),
    )
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** pi.live represents a tool round either with `tools` slots or a tool-call
 * block in the in-flight assistant message. Support both shapes because the
 * slot is committed a little later than the streamed assistant preamble. */
export function hasLiveToolRound(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const live = value as { tools?: unknown; generation?: unknown };
  if (Array.isArray(live.tools) && live.tools.length > 0) return true;
  if (!live.generation || typeof live.generation !== "object") return false;
  const message = (live.generation as { message?: unknown }).message;
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some((block) =>
      Boolean(
        block &&
        typeof block === "object" &&
        ["toolCall", "tool_use", "tool_use_call"].includes(
          String((block as { type?: unknown }).type),
        ),
      ),
    )
  );
}
