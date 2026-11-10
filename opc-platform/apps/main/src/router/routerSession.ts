import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { ModelRef } from "@opc/shared/domain";
import { diffCost, diffUsage } from "../work/usage";

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
    configuredCostUsd?: number;
    status: "ok" | "interrupted";
  }) => void;
  /** Visible assistant text from pi.live while the Router is generating. */
  onText?: (text: string) => void;
  /** The live document entered a tool round; any plain-text preamble is transient. */
  onToolRound?: () => void;
}

export class RouterSession {
  private conversation: Conversation | null = null;
  /** Share the first root creation across simultaneous deliveries. */
  private opening: Promise<Conversation> | null = null;
  /** 已经交上去、还没 settle 的轮次。用于避免无意义的并发提交。 */
  private pending = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: RouterSessionDeps) {}

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
          const usageDelta = diffUsage(usageBefore, usageAfter);
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
            ...usageDelta,
            ...(diffCost(usageBefore, usageAfter) > 0
              ? { configuredCostUsd: diffCost(usageBefore, usageAfter) }
              : {}),
            status: ok ? "ok" : "interrupted",
          });
        }
        if (!ok) {
          // A submission that settles as failed was not delivered. Throw it back to
          // Router.tick so its routed/announced markers can be rolled back.
          throw new Error(`Router 一轮未完成（${settled.status}）`);
        }
        // The final commit may be folded into the watch while its callback is
        // still queued. Read the watch's current view before stopping it so the
        // host can always commit the complete answer even when no last delta was
        // dispatched.
        const finalText = textFromLive(watch?.value.docs["pi.live"]);
        if (finalText) latestText = finalText;
        this.lastError = null;
        this.deps.onTurn?.({ ok: true });
        return latestText;
      } finally {
        await watch?.stop();
        // `stop()` prevents new calls but may return while the last callback is
        // still running. Drain it before the host emits the final/clear event.
        await watchCallbackTail;
      }
    } catch (error) {
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

  /** 等当前所有轮次落定。探针和退出流程用。 */
  settle = async (): Promise<void> => {
    while (this.pending > 0)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
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
