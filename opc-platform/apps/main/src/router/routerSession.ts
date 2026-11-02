import type { Conversation, Harness } from '@earendil-works/pi-durable';
import type { ModelRef } from '@opc/shared/domain';

/**
 * Router 的常驻会话。
 *
 * 这是 v2 里最容易做错的一件事，所以先把话说死：**Router 是一个会话，不是一个
 * 请求处理器**。它有自己的历史、自己的上下文窗口、自己的压缩策略，跨信道、跨
 * 任务地连续（§2「连续」）。如果每一轮都新建会话，老板在 IM 上说过"用方案 A"、
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
}

export class RouterSession {
  private conversation: Conversation | null = null;
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
   * 模型与 thinking 在每轮开始时按当前设置重新配置：老板在设置里换了模型，
   * 下一句就该用新模型，而不是重启应用。
   */
  private async ensure(): Promise<Conversation> {
    if (this.conversation) {
      await this.reconfigure(this.conversation);
      return this.conversation;
    }
    const harness = await this.deps.harness();
    const context = await this.deps.context();
    const conversation = await harness.root(context as never);
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
          thinkingLevel: (this.deps.thinking() ?? 'medium') as never,
          cwd: this.deps.cwd(),
        } as never,
        context as never,
      )
      .catch(() => undefined);
  }

  /**
   * 把一段输入交给 Router。
   *
   * 不 await 生成过程：调用方（调度循环）要立刻返回，好让下一次 tick 继续攒事件。
   * 会话忙的时候 pi 会把这条输入排队，在下一个 boundary 一起处理——那就是批处理。
   */
  deliver = (text: string): void => {
    void this.run(text);
  };

  private async run(text: string): Promise<void> {
    this.pending += 1;
    try {
      const conversation = await this.ensure();
      const context = await this.deps.context();
      const submission = await conversation.submit(
        { type: 'input', content: text },
        context as never,
      );
      const settled = await submission.wait(context as never);
      const ok = settled.status === 'done';
      this.lastError = ok ? null : `Router 一轮未完成（${settled.status}）`;
      if (!ok) console.error('[router]', this.lastError);
      this.deps.onTurn?.({ ok, ...(ok ? {} : { error: this.lastError ?? undefined }) });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      // 不抛：Router 崩了不该让调度循环停摆，事件还在队列里，下一轮会重试。
      console.error('[router] 一轮失败', error);
      this.deps.onTurn?.({ ok: false, error: this.lastError });
    } finally {
      this.pending -= 1;
    }
  }

  /** 等当前所有轮次落定。探针和退出流程用。 */
  settle = async (): Promise<void> => {
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  };
}
