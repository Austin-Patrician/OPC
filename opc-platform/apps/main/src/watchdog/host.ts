import { existsSync } from 'node:fs';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { FaultSink } from '../data/systemEventRepository';
import { messageOf } from '../data/systemEventRepository';
import type { IncidentMirrorInput, WatchdogIncident } from '../data/watchdogIncidentRepository';
import type { ActionPayload, JudgePayload, JudgeResult, WatchdogEvent, WatchdogPong } from './protocol';

/**
 * 父进程这一侧的 Watchdog：把它启动起来、看着它、问它一句话、关掉它。
 *
 * 这一层的存在意义不是"管理子进程"，而是**把故障域的边界画清楚**：
 * 子进程崩了，主应用继续跑；主进程卡住，子进程照转。两边唯一的耦合是
 * 那四条消息（`protocol.ts`），没有共享内存、没有共享事件循环。
 *
 * 重启策略留到 W8：这一版崩了只记录事实，不在崩溃循环里反复 fork——
 * 一个每两秒崩溃一次的子进程会把日志和磁盘写满，而它本来只是观测工具。
 */

export interface WatchdogHostOptions {
  /** 业务库文件（子进程只读打开）。 */
  businessDb: string;
  /** 子进程自己的库（会话历史 + 观察记录）。 */
  sessionDb: string;
  faults?: FaultSink;
  /** incident 镜像（业务库）。没有就只留在子进程自己的库里。 */
  incidents?: {
    sync(rows: readonly IncidentMirrorInput[]): {
      written: number;
      escalated: readonly WatchdogIncident[];
    };
    markAnnounced(ids: readonly string[]): void;
    markAnnounceAttempt(ids: readonly string[]): void;
  };
  /**
   * 一条 incident **刚升级为 escalated** 时调一次。
   *
   * 这是它唯一的用户可见出口：旧的主进程 Watchdog 退休后，"这条线可能卡住了"
   * 这句话必须还有人说出来。判据是状态迁移，不是内存里的"报过了"。
   */
  onEscalated?: (incident: WatchdogIncident) => void;
  /**
   * 语义判断（W5）。子进程出题、主进程作答：模型凭据只在主进程解密。
   * 没有它就是"只做程序层"——子进程会照常发现、记录、结案，只是没有语义结论。
   */
  judge?: (payload: JudgePayload) => Promise<JudgeResult>;
  /**
   * 执行一项白名单动作（W6）。**实现在主进程**：子进程只请求，不碰业务状态。
   * 返回 `ok:false` 时，子进程会把原因记在 incident 上，但不会把它当已恢复。
   */
  performAction?: (payload: ActionPayload) => Promise<{ ok: boolean; message: string }>;
  intervalMs?: number;
  /** 覆盖入口文件路径；默认取与主 bundle 同目录的 `watchdog.js`。 */
  entry?: string;
}

export class WatchdogHost {
  private child: UtilityProcess | null = null;
  private intentionalStop = false;
  private readyWaiters: ((ok: boolean) => void)[] = [];
  private pongWaiters: { resolve: (pong: WatchdogPong | null) => void; timer: NodeJS.Timeout }[] = [];
  /** 重启时间戳，用来按窗口限流。 */
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private reportedUnresponsive = false;

  constructor(private readonly options: WatchdogHostOptions) {}

  /** 十分钟内最多三次：一个反复崩溃的观测者不该把磁盘写满。 */
  private static readonly RESTART_WINDOW_MS = 10 * 60_000;
  private static readonly MAX_RESTARTS = 3;

  /** 启动。重复调用是安全的：已经起来就不再做第二次。 */
  start(): void {
    if (this.child) return;
    const entry = this.entryPath();
    this.intentionalStop = false;

    try {
      this.child = utilityProcess.fork(entry, [], {
        serviceName: 'opc-watchdog',
        stdio: 'pipe',
        env: {
          ...process.env,
          OPC_WATCHDOG_BUSINESS_DB: this.options.businessDb,
          OPC_WATCHDOG_SESSION_DB: this.options.sessionDb,
          ...(this.options.intervalMs
            ? { OPC_WATCHDOG_INTERVAL_MS: String(this.options.intervalMs) }
            : {}),
        },
      });
    } catch (error) {
      this.child = null;
      this.settleReady(false);
      this.options.faults?.recordSafely({
        kind: 'watchdog.spawn_failed',
        severity: 'warning',
        subjectType: 'process',
        summary: `Watchdog 子进程起不来：${messageOf(error)}`,
      });
      // 起不来也要走退避：入口路径错、native 模块缺失都可能是一次性的
      // （比如打包后第一次启动时文件还没解包完）。
      this.scheduleRestart();
      return;
    }

    this.child.on('message', (message: unknown) => this.receive(message as WatchdogEvent));
    this.child.on('exit', (code: number) => this.exited(code));
    // stderr 不吞：子进程自己的报错是排查的唯一线索。
    this.child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[watchdog] ${chunk.toString().trimEnd()}\n`);
    });
    this.watchLiveness();
  }

  /**
   * 入口在哪：打包之后它可能被 `asarUnpack` 到 `app.asar.unpacked` 下。
   * 两条都试，因为 `__dirname` 在 asar 里读起来和磁盘上没有区别。
   */
  private entryPath(): string {
    if (this.options.entry) return this.options.entry;
    const packed = path.join(__dirname, 'watchdog.js');
    const unpacked = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'watchdog.js');
    return existsSync(packed) ? packed : unpacked;
  }

  /**
   * 父进程这一侧的存活检查：每分钟问一次"你还转吗"。
   *
   * 这与"子进程还活着吗"（进程存在）不是一回事——它卡在某个同步调用里时进程还在。
   * 只在连续失败时记一条，恢复之后可以再记一次。
   */
  private watchLiveness(): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => {
      if (!this.child) return;
      void this.ping(5_000).then((pong) => {
        if (pong) {
          this.reportedUnresponsive = false;
          return;
        }
        if (this.reportedUnresponsive) return;
        this.reportedUnresponsive = true;
        this.options.faults?.recordSafely({
          kind: 'watchdog.unresponsive',
          severity: 'warning',
          subjectType: 'process',
          summary: 'Watchdog 子进程还活着，但没有回应存活检查——它可能卡住了。',
        });
      });
    }, 60_000);
    this.livenessTimer.unref?.();
  }

  /** 等它报到。超时返回 false——调用方（探针）据此判断"没起来"。 */
  whenReady(timeoutMs = 5_000): Promise<boolean> {
    if (!this.child) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.readyWaiters.push(done);
    });
  }

  /**
   * 它还活着吗。
   *
   * 这是 W2 唯一需要父进程主动问的事：等 W4 接上诊断之后，真正有分量的是
   * 子进程自己写的发现，而不是这一次往返。
   */
  /** 仅供探针：模拟一次非正常退出，用来验证重启与限流。 */
  crashForProbe(): void {
    this.child?.kill();
  }

  /** 供探针：当前子进程的 pid（没有就是 null）。 */
  pidForProbe(): number | null {
    return this.child?.pid ?? null;
  }

  ping(timeoutMs = 2_000): Promise<WatchdogPong | null> {
    const child = this.child;
    if (!child) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (pong: WatchdogPong | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pongWaiters = this.pongWaiters.filter((waiter) => waiter.resolve !== finish);
        resolve(pong);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.pongWaiters.push({ resolve: finish, timer });
      try {
        child.postMessage({ type: 'ping' });
      } catch {
        finish(null);
      }
    });
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 它没理我们：直接杀。留着会更糟——下次启动会看到两个 Watchdog。
        child.kill();
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.postMessage({ type: 'stop' });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.child = null;
  }

  private receive(message: WatchdogEvent): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      // 业务库打不开 = 它看得见的东西是零。仍然让它跑（下一轮会重试打开），
      // 但不能对调用方说"准备好了"——那会让探针与日志都说谎。
      if (!message.businessDbOpen) {
        this.options.faults?.recordSafely({
          kind: 'watchdog.business_db_unavailable',
          severity: 'warning',
          subjectType: 'process',
          summary: 'Watchdog 起来了，但业务库打不开：这一段它看不到任何任务与故障。',
        });
      }
      this.syncIncidents(message.incidents);
      this.settleReady(message.businessDbOpen);
      return;
    }
    if (message.type === 'pong') {
      for (const waiter of this.pongWaiters) waiter.resolve(message);
      this.pongWaiters = [];
      return;
    }
    if (message.type === 'error') {
      // 子进程报了自己的问题，但**不记成系统故障**：它还没到"主系统出毛病"
      // 这个级别。它在自己的库里也有一份，等 W3 变成 incident 再说。
      console.warn('[watchdog]', message.message);
      return;
    }
    if (message.type === 'judge') {
      void this.judge(message.requestId, message.findingId, message.payload);
      return;
    }
    if (message.type === 'action') {
      void this.performAction(message.requestId, message.payload);
      return;
    }
    // `tick`：子进程每轮把 incident 全量带上来，这里刷镜像。
    this.syncIncidents(message.incidents);
  }

  /**
   * 执行一项动作并把结果回给子进程。
   *
   * 失败也回：子进程在等这个 requestId，不回它就永远挂着一个 pending，
   * 冷却也就永远不开始。
   */
  private async performAction(requestId: string, payload: ActionPayload): Promise<void> {
    const child = this.child;
    if (!child) return;
    let result: { ok: boolean; message: string };
    try {
      result = this.options.performAction
        ? await this.options.performAction(payload)
        : { ok: false, message: '没有配置动作执行器' };
    } catch (error) {
      result = { ok: false, message: messageOf(error) };
    }
    try {
      child.postMessage({
        type: 'action-result',
        requestId,
        incidentId: payload.incidentId,
        action: payload.action,
        ok: result.ok,
        message: result.message,
      } as never);
    } catch {
      // 子进程已经走了；动作本身已经落库，不会丢。
    }
  }

  /**
   * 一次语义判断。子进程只出题，模型调用与凭据留在主进程（见 `protocol.ts`）。
   *
   * 失败也要回一条 `judge-result`：子进程在等这个 requestId，不回就是永远挂着
   * 一个 pending——它的冷却计时也就永远不开始。
   */
  private async judge(
    requestId: string,
    findingId: string,
    payload: JudgePayload,
  ): Promise<void> {
    const child = this.child;
    if (!child) return;
    let result: JudgeResult;
    try {
      result = this.options.judge
        ? await this.options.judge(payload)
        : { ok: false, error: '没有配置判断模型' };
    } catch (error) {
      result = { ok: false, error: messageOf(error) };
    }
    try {
      child.postMessage({ type: 'judge-result', requestId, findingId, result } as never);    } catch {
      // 子进程已经走了；它下次启动会重新问。
    }
  }

  /**
   * 刷镜像。失败只记一条警告：镜像坏了不该让子进程的消息通道失效，
   * 下一轮 tick 会把同一页再送一遍。
   */
  private syncIncidents(incidents: readonly IncidentMirrorInput[]): void {
    if (!this.options.incidents || incidents.length === 0) return;
    try {
      const result = this.options.incidents.sync(incidents);
      const announced: string[] = [];
      const failed: string[] = [];
      for (const incident of result.escalated) {
        try {
          this.options.onEscalated?.(incident);
          announced.push(incident.id);
        } catch (error) {
          failed.push(incident.id);
          console.warn('[watchdog] 升级通知没发出去', messageOf(error));
        }
      }
      // 成功与失败分开记：成功的以后再也不会打扰，失的下轮还会再试（有上限）。
      this.options.incidents.markAnnounced(announced);
      this.options.incidents.markAnnounceAttempt(failed);
    } catch (error) {
      console.warn('[watchdog] incident 镜像没刷上', messageOf(error));
    }
  }

  private settleReady(ok: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter(ok);
  }

  private exited(code: number): void {
    this.child = null;
    this.settleReady(false);
    for (const waiter of this.pongWaiters) waiter.resolve(null);
    this.pongWaiters = [];
    if (this.intentionalStop) return;

    // 非正常退出是主进程**能观察到**的一件事：它说明观测者本身出了问题。
    this.options.faults?.recordSafely({
      kind: 'watchdog.exited',
      severity: 'warning',
      subjectType: 'process',
      summary: `Watchdog 子进程意外退出（code ${code}），这一段没有人在看。`,
      detail: { code },
    });
    this.scheduleRestart();
  }

  /**
   * 退避重启，带窗口上限。
   *
   * 为什么不是"立刻重启、无限次"：一个每两秒崩溃一次的子进程会把日志和磁盘写满，
   * 而它本来只是观测工具。三次之后放弃，并**留下一条记录**——比安静地空转好。
   */
  private scheduleRestart(): void {
    if (this.restartTimer || this.intentionalStop) return;

    const now = Date.now();
    this.restarts = this.restarts.filter(
      (at) => now - at < WatchdogHost.RESTART_WINDOW_MS,
    );
    if (this.restarts.length >= WatchdogHost.MAX_RESTARTS) {
      this.options.faults?.recordSafely({
        kind: 'watchdog.restart_given_up',
        severity: 'error',
        subjectType: 'process',
        summary: `Watchdog 在 ${Math.round(WatchdogHost.RESTART_WINDOW_MS / 60_000)} 分钟内已经重启 ${this.restarts.length} 次，不再重试。这一段没有人在看。`,
        detail: { restarts: this.restarts.length },
      });
      return;
    }

    const delay = [1_000, 5_000, 30_000][this.restarts.length] ?? 30_000;
    this.restarts.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}
