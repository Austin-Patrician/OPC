/**
 * 一个执行体，同一时刻只跑一个任务。
 *
 * 这不是调度优化，是**正确性**：执行体的 harness 背后是一份 sqlite 会话，两轮 run
 * 并发写同一个库会直接把会话毒化（`Session failed after a storage error`），之后这个
 * 执行体的每一次运行都会失败。
 *
 * 上一版只有 `Map<owner, taskId>` 一个字段，第二个任务启动时把第一个的记录覆盖掉，
 * 于是 `isRunning` 判不出"它其实还在跑"，两个 run 真的会同时发生。单人单任务的机器上
 * 看不出来——测试也是这样绿着的。
 *
 * v2 把派活的入口从"人打一次字"变成"一来一串事件"（§3.2 直通），这条队列就成了必需
 * 的东西：同一份 PR 的 5 条评论必须**一个接一个**进同一个执行体，而不是 5 个 run 抢
 * 同一份库。排队是执行体自己的事——Router 已经不再参与派活（§3.3），它连这件事发生过
 * 都不会知道。
 *
 * 队列只在内存里。进程重启时没跑完的任务仍然是 `open`/`running`，由
 * `recover()` 里的 durable resume 接手——队列不承担持久化，那是任务表的职责。
 */

export interface OwnerQueueDeps {
  /**
   * 真的去跑。等它 settle，队列才往前走一步。
   *
   * 返回 `Promise` 而不是 `void`：队列靠它知道"这一轮真的结束了"。跑多久都可以，
   * 队列不会超时——超时是 Watchdog 的事（§6），不是排队的事。
   */
  run: (taskId: string) => Promise<unknown>;
  /** 跑的时候出错了。队列不因此停下：下一个任务照旧开跑。 */
  onError?: (taskId: string, error: unknown) => void;
}

export class OwnerQueue {
  /** ownerId → 正在跑的那个任务。最多一个。 */
  private readonly active = new Map<string, string>();
  /** ownerId → 还没开跑的任务，先进先出。 */
  private readonly waiting = new Map<string, string[]>();
  /** taskId → 等它跑完的人。`runTaskAndWait` 与测试用它。 */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: OwnerQueueDeps) {}

  /**
   * 排进这个执行体的队尾。
   *
   * 已经在跑或已经在排队的不重复入队——派活是可以重试的（IPC 点两下、探针再推
   * 一次），重试不该让同一件事干两遍。
   */
  enqueue(ownerId: string, taskId: string): void {
    if (this.isRunning(taskId)) return;
    const queue = this.waiting.get(ownerId);
    if (queue) queue.push(taskId);
    else this.waiting.set(ownerId, [taskId]);
    this.drain(ownerId);
  }

  /**
   * 排队并等它跑完。
   *
   * 先挂 waiter 再入队：入队会同步地尝试开跑，而一个极快的任务可能在我们挂上
   * 之前就结束了——那会让等待永远不返回。
   */
  async enqueueAndWait(ownerId: string, taskId: string): Promise<void> {
    const done = this.whenDone(taskId);
    this.enqueue(ownerId, taskId);
    return done;
  }

  /** 这个任务在不在这个执行体的队列里（跑着也算）。 */
  isRunning(taskId: string): boolean {
    for (const running of this.active.values()) {
      if (running === taskId) return true;
    }
    for (const queue of this.waiting.values()) {
      if (queue.includes(taskId)) return true;
    }
    return false;
  }

  /** 这个执行体现在有活在手上。 */
  isBusy(ownerId: string): boolean {
    return this.active.has(ownerId);
  }

  activeTask(ownerId: string): string | undefined {
    return this.active.get(ownerId);
  }

  waitingFor(ownerId: string): readonly string[] {
    return this.waiting.get(ownerId) ?? [];
  }

  /** 还在排队的任务总数，给界面显示"还有几个在等"。 */
  get queued(): number {
    let total = 0;
    for (const queue of this.waiting.values()) total += queue.length;
    return total;
  }

  /** 等这个任务跑完。它已经结束过的话永远不返回——调用方先用 `isRunning` 判。 */
  whenDone(taskId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const set = this.waiters.get(taskId) ?? new Set<() => void>();
      set.add(resolve);
      this.waiters.set(taskId, set);
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private drain(ownerId: string): void {
    // 有人正在跑：等它结束时会再调一次 drain。
    if (this.active.has(ownerId)) return;

    const queue = this.waiting.get(ownerId);
    const next = queue?.shift();
    if (!queue || next === undefined) {
      this.waiting.delete(ownerId);
      return;
    }
    if (queue.length === 0) this.waiting.delete(ownerId);
    this.active.set(ownerId, next);

    const finish = (error?: unknown): void => {
      // 只有在"还是我"的时候才清：中途被别的东西改过就让它自己收尾。
      if (this.active.get(ownerId) === next) this.active.delete(ownerId);
      if (error !== undefined) this.deps.onError?.(next, error);
      this.settle(next);
      this.drain(ownerId);
    };

    let running: Promise<unknown>;
    try {
      running = this.deps.run(next);
    } catch (error) {
      finish(error);
      return;
    }
    void running.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  }

  private settle(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const resolve of set) resolve();
  }
}
