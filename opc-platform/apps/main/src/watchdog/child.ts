import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ActionName, WatchdogCommand, WatchdogEvent } from './protocol';
import { DEFAULT_CANDIDATES, evaluateTask } from './candidates';
import { readWatchdogPolicy, type WatchdogPolicy } from './policy';
import {
  readOpenEvents,
  readRunningTasks,
  readSnapshot,
  readTask,
  readTrace,
  WatchdogStore,
} from './store';

/**
 * Watchdog 子进程（`11-watchdog-spec.md` W2）。
 *
 * 它**只做三件事**：开两条连接（业务库只读、自己的库读写）、按点体检、
 * 把看到的报给父进程。这一版没有模型、不动手——先证明"主进程卡住时它还活着"
 * 这件事成立，再往上加判断。
 *
 * 为什么是独立进程而不是主进程里的循环：主进程的异常通常是**事件循环被堵住**
 * （一个同步 fs、一次长达几十秒的工具调用）。同一个进程里的定时器，堵住的时候
 * 它也不转。这不是风格问题，是故障域问题。
 *
 * 配置全部走环境变量：`utilityProcess` 的 argv 在不同 Electron 版本上不完全一致，
 * 而环境变量没有这个歧义。
 */

const businessDbPath = process.env.OPC_WATCHDOG_BUSINESS_DB ?? '';
const sessionDbPath = process.env.OPC_WATCHDOG_SESSION_DB ?? '';
const intervalMs = positive(process.env.OPC_WATCHDOG_INTERVAL_MS, 60_000);

/** `process.parentPort` 只存在于 utilityProcess 里，类型没在 Node 的声明里。 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: { data: unknown }) => void): void;
}

/** 每轮带上限：全量同步镜像，超出的由下一轮补上。 */
const INCIDENT_PAGE = 50;
/** 一次看多少个运行中的任务。任务比这多时，**不**据此关掉没看到的发现。 */
const TASK_PAGE = 20;
/** 候选规则（W4）。窗口是结构常数，次数与空闲时长来自规则（W7）。 */
const CANDIDATES = DEFAULT_CANDIDATES;

/**
 * 语义判断（W5）与动作（W6）的冷却在规则里；这里是它们的下限保护值。
 */
const ESCALATE_CONFIDENCE = 0.6;
/** 判断看最近几步。12 步足够看出"重复失败"，又不至于把上下文喂胖。 */
const JUDGE_TRACE_ROWS = 12;
const ESCALATING = new Set(['stalled', 'looping', 'deviating']);
/**
 * 动作白名单（W6）。
 *
 * 现在只有一条：MCP 连不上 → 断开重连。它是**幂等**的，最坏结果是"还是连不上"，
 * 不会改变任何任务的状态。
 *
 * 这里不接受"重试任务""取消任务"：那两件事要幂等语义（外部副作用能不能重放）
 * 和"该不该停"的判断，属于人的决定，不属于观测者。
 */
const ACTION_POLICY: Record<string, ActionName> = {
  'mcp.connect_failed': 'mcp.reconnect',
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const startedAt = Date.now();
let store: WatchdogStore | null = null;
let business: Database.Database | null = null;
let timer: NodeJS.Timeout | null = null;
let stopping = false;
/** 正在等父进程回答的那一条。发出去之前不再发第二条。 */
let pendingJudge: string | null = null;
/** 正在等结果的维修请求。 */
let pendingAction: string | null = null;
/** 上一轮体检的时刻，用来识别"整机被挂起"（W8）。 */
let lastEvaluationAt = 0;
/** 父进程已断：只记录，不再请求判断与动作。 */
let orphaned = false;
/** 断连后还活多久：足够把当下的证据落下来，又不至于变成永久孤儿进程。 */
const ORPHAN_GRACE_MS = positive(process.env.OPC_WATCHDOG_ORPHAN_MS, 2 * 60_000);

function send(event: WatchdogEvent): void {
  try {
    parentPort?.postMessage(event);
  } catch {
    // 父进程已经走了。它不是我们该处理的问题——下面会随进程退出一起结束。
  }
}

/**
 * 业务库是**只读**打开的，而且不做任何补救（不建表、不迁移）。
 *
 * 读不了就是读不了：schema 由主进程迁移，版本不匹配是要报出来的事实。
 * 一个"顺手修一下"的子进程，比一个读不到东西的子进程危险得多。
 */
function openBusiness(): Database.Database | null {
  if (!businessDbPath) return null;
  try {
    return new Database(businessDbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    send({
      type: 'error',
      message: `业务库读不了：${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

function evaluate(): void {
  if (stopping) return;
  const now = Date.now();
  store?.tick(now, process.pid);

  /**
   * 睡眠/唤醒保护。
   *
   * 机器睡了两小时再醒来时，主进程的心跳当然是"两小时前"的——那不是故障，
   * 是两个人一起被按了暂停键。判据用**它自己的**上一步：如果这一轮距上一轮
   * 远超正常间隔，说明被挂起的是整个系统，这一轮不判心跳。
   */
  const gap = now - lastEvaluationAt;
  const resumedFromSleep = lastEvaluationAt > 0 && gap > Math.max(3 * intervalMs, 120_000);
  lastEvaluationAt = now;

  if (!business) {
    business = openBusiness();
    if (!business) return;
  }

  // 规则每轮现读：设置页保存之后，下一轮就按新值走，不需要重启。
  const policy = policyOf(business);
  store?.setThresholds({
    recheckAfterMs: policy.recheckAfterMs,
    escalateAfterMs: policy.escalateAfterMs,
  });
  // 时间驱动的状态推进：active → rechecking → escalated。没有这一层，
  // "这件事已经存在 20 分钟了"就只写在摘要里，别人还得自己算。
  store?.sweep(now);

  try {
    const snapshot = readSnapshot(business, now, policy.idleTaskMs);

    // 总开关关掉时仍然体检、仍然推进状态（证据不能因为"别吵我"就断掉），
    // 但不再报警、不再花模型调用、不再请求动作。
    if (!policy.enabled) {
      send({ type: 'tick', at: now, snapshot, incidents: store?.recent(INCIDENT_PAGE) ?? [] });
      return;
    }

    // 心跳停 = 主进程不转了。**这是子进程存在的理由**：这一刻主进程已经没法
    // 记录自己，只有这里还醒着，所以证据必须落在自己的库里。
    const heartbeat = snapshot.heartbeat;
    if (heartbeat && heartbeat.state === 'running' && !resumedFromSleep) {
      const ageMs = now - heartbeat.at;
      if (ageMs > policy.staleMainMs) {
        store?.raise(
          {
            kind: 'main_unresponsive',
            subjectType: 'process',
            summary: `主进程心跳已经 ${Math.round(ageMs / 1000)} 秒没有更新（阈值 ${Math.round(
              policy.staleMainMs / 1000,
            )} 秒）。它可能卡在一个同步调用里，或者已经被系统挂起。`,
            detail: { ageMs, instanceId: heartbeat.instanceId, pendingTasks: snapshot.pendingTasks },
          },
          now,
        );
      } else {
        store?.resolve('main_unresponsive', 'process', '', now);
      }
    }

    // W4：候选来自**真实动作流**，不来自"人读的叙述"。旧规则数同一句话，
    // 而"改一行再跑还是失败"每一步的文字都不相同。
    const rules = {
      ...CANDIDATES,
      idleMs: policy.idleTaskMs,
      repeatFailure: policy.repeatFailure,
    };
    const seen = new Set<string>();
    // 游标扫描：这一轮看的是"接着上次往后"的一段，不是永远最旧的 20 个。
    const scan = readRunningTasks(business, TASK_PAGE, store?.readCursor() ?? { updatedAt: 0, id: '' });
    const tasks = scan.tasks;
    store?.writeCursor(scan.next);
    for (const task of tasks) {
      const trace = readTrace(business, task.id, rules.window);
      for (const candidate of evaluateTask(task, trace, now, rules)) {
        store?.raise(
          {
            kind: candidate.kind,
            subjectType: 'task',
            subjectId: candidate.taskId,
            summary: candidate.summary,
            detail: candidate.detail,
          },
          now,
        );
        seen.add(`${candidate.kind}\u0000${candidate.taskId}`);
      }
    }
    // 这一轮没再判出来的，说明它自己好了——关掉记录。
    // 只在"这一轮看全了"的时候关：任务比一页多时，没看到不等于不存在。
    if (scan.wrapped) {
      for (const finding of store?.active() ?? []) {
        if (finding.subjectType !== 'task') continue;
        if (finding.kind !== 'repeat_failure' && finding.kind !== 'no_progress') continue;
        if (seen.has(`${finding.kind}\u0000${finding.subjectId}`)) continue;
        store?.resolve(finding.kind, 'task', finding.subjectId, now);
      }
    }

    // 父进程已经没了（孤儿模式）：还能记录，但没人能做判断、也没人能执行动作。
    if (!orphaned) {
      askForJudgment(now, policy.judgeCooldownMs);
      maybeAct(now, policy.actionCooldownMs);
    }
    noteOpenEvents(now);
    send({
      type: 'tick',
      at: now,
      snapshot,
      incidents: store?.recent(INCIDENT_PAGE) ?? [],
    });
  } catch (error) {
    // 业务库读失败（锁超时、表不存在、schema 变了）不该让循环停下来：
    // 下一轮再试，报错留给父进程。
    send({
      type: 'error',
      message: `体检失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * 问一次模型。
 *
 * 一次只问一条，而且只问**已经判成候选的**：模型不该在健康的任务上花 token。
 * 出题的人是这里——证据（目标 + 候选 + 最近动作）由子进程挑，主进程只管调用。
 */
function askForJudgment(now: number, cooldownMs: number): void {
  if (pendingJudge) return;
  const finding = store?.needsJudgment(now, cooldownMs);
  if (!finding || !business || finding.subjectType !== 'task') return;

  const task = readTask(business, finding.subjectId);
  if (!task) return;

  const trace = readTrace(business, task.id, JUDGE_TRACE_ROWS).map((row) => ({
    seq: row.seq,
    at: row.at,
    name: row.name,
    argsDigest: row.argsDigest,
    ok: row.ok,
  }));

  pendingJudge = randomUUID();
  send({
    type: 'judge',
    requestId: pendingJudge,
    findingId: finding.id,
    payload: {
      taskId: task.id,
      title: task.title,
      goal: task.goal,
      candidate: { kind: finding.kind, summary: finding.summary, detail: finding.detail },
      trace,
    },
  });
}

/**
 * 规则：库里那份为主，环境变量只用于探针覆盖。
 *
 * 顺序是有意的——**库里的是人刚在设置页按过保存的**，环境变量是调试手段；
 * 反过来会让探针的临时值在下次启动时"粘住"成真实配置。
 */
function policyOf(db: Database.Database): WatchdogPolicy {
  const stored = readWatchdogPolicy(db);
  const overlay = (key: keyof WatchdogPolicy, env: string): Partial<WatchdogPolicy> => {
    const value = process.env[env];
    if (!value) return {};
    if (key === 'enabled') return { enabled: value !== '0' };
    if (key === 'repeatFailure') {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? { repeatFailure: parsed } : {};
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? { [key]: parsed } : {};
  };

  return {
    ...stored,
    ...overlay('staleMainMs', 'OPC_WATCHDOG_STALE_MS'),
    ...overlay('recheckAfterMs', 'OPC_WATCHDOG_RECHECK_MS'),
    ...overlay('escalateAfterMs', 'OPC_WATCHDOG_ESCALATE_MS'),
    ...overlay('judgeCooldownMs', 'OPC_WATCHDOG_JUDGE_COOLDOWN_MS'),
    ...overlay('actionCooldownMs', 'OPC_WATCHDOG_ACTION_COOLDOWN_MS'),
    ...overlay('idleTaskMs', 'OPC_WATCHDOG_IDLE_MS'),
    ...overlay('repeatFailure', 'OPC_WATCHDOG_REPEAT_FAILURE'),
  };
}

/**
 * 把"还没人处理的系统故障"变成 incident（W6 的动作来源）。
 *
 * 这一步之前，MCP 连不上只在 `system_event` 里躺着：有记录、没人接。
 * 现在它是一条有主体、有状态的 incident，因此可以被判、被修、被关。
 */
function noteOpenEvents(now: number): void {
  if (!business) return;
  const events = readOpenEvents(business, 10);

  /**
   * 只把**会自愈的那种**事件变成 incident。
   *
   * `router.session_failed`、`process.unclean_exit`、`watchdog.exited` 都是**已经
   * 发生过一次的事实**，没有"是否恢复"可言——把它们变成 incident，只会得到一堆
   * 永远关不掉的条目。incident 的语义是"一个还在持续、可能自己好起来的状况"。
   */
  const conditional = events.filter((event) => event.kind in ACTION_POLICY);
  for (const event of conditional) {
    store?.raise(
      {
        kind: event.kind,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        summary: event.summary,
        detail: { eventId: event.id, at: event.at },
      },
      now,
    );
  }

  // 事件被处理掉了（或本来就不再复现）→ 关掉对应 incident。
  // 只接管有动作那几类：任务级和心跳级由各自的规则管。
  const open = new Set(conditional.map((event) => `${event.kind}\u0000${event.subjectId}`));
  for (const finding of store?.active() ?? []) {
    if (finding.subjectType === 'task' || finding.kind === 'main_unresponsive') continue;
    const conditionalKind = finding.kind in ACTION_POLICY;
    if (conditionalKind && open.has(`${finding.kind}\u0000${finding.subjectId}`)) continue;
    // 非条件类的旧条目（历史性事件、已经退休的 kind）一律关掉：它们没有
    // "还在持续"这层意思，留着只会变成永远关不掉的一行。
    store?.resolve(finding.kind, finding.subjectType, finding.subjectId, now);
  }
}

/**
 * 请求一次维修。
 *
 * `pendingAction` 是单飞的：一次只等一个结果。子进程超时没等到也不会自动重发——
 * 重发由冷却（10 分钟）决定，否则一次断线会变成一串重连。
 */
function maybeAct(now: number, cooldownMs: number): void {
  if (pendingAction) return;
  const finding = store?.needsAction(Object.keys(ACTION_POLICY), now, cooldownMs);
  if (!finding) return;
  const action = ACTION_POLICY[finding.kind];
  if (!action) return;

  pendingAction = randomUUID();
  send({
    type: 'action',
    requestId: pendingAction,
    payload: {
      incidentId: finding.id,
      action,
      reason: finding.summary,
      evidence: finding.detail,
    },
  });
}

function handle(message: unknown): void {
  const command = message as WatchdogCommand | undefined;
  if (!command || typeof command !== 'object') return;

  if (command.type === 'action-result') {
    if (pendingAction === command.requestId) pendingAction = null;
    store?.setActionResult(
      command.incidentId,
      command.action,
      command.ok ? `已执行：${command.message}` : `没成功：${command.message}`,
      Date.now(),
    );
    if (!command.ok) send({ type: 'error', message: `动作没成功：${command.message}` });
    return;
  }

  if (command.type === 'judge-result') {
    if (pendingJudge === command.requestId) pendingJudge = null;
    const now = Date.now();
    if (command.result.ok) {
      const escalate =
        ESCALATING.has(command.result.verdict) && command.result.confidence >= ESCALATE_CONFIDENCE;
      store?.setVerdict(
        command.findingId,
        {
          verdict: command.result.verdict,
          reason: command.result.reason,
          confidence: command.result.confidence,
        },
        now,
        escalate,
      );
    } else {
      // 判不了也是一次"判过"：否则模型不可用的每一轮都会重试。
      store?.markJudged(command.findingId, now);
      send({ type: 'error', message: `判断没做成：${command.result.error}` });
    }
    return;
  }

  if (command.type === 'ping') {
    send({
      type: 'pong',
      at: Date.now(),
      uptimeMs: Date.now() - startedAt,
      lastTickAt: store?.lastTick() ?? null,
      activeFindings: store?.active().length ?? 0,
      judged: store?.judgedCount() ?? 0,
    });
    return;
  }

  if (command.type === 'stop') {
    shutdown(0);
  }
}

function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  try {
    business?.close();
  } catch {
    // 已经在关了；关不干净由进程退出兜底。
  }
  business = null;
  try {
    store?.close();
  } catch {
    // 同上。
  }
  store = null;
  process.exit(code);
}

function main(): void {
  if (!sessionDbPath) {
    send({ type: 'error', message: '没有配置会话库路径，Watchdog 不启动。' });
    process.exit(2);
    return;
  }

  store = WatchdogStore.open(sessionDbPath, {
    recheckAfterMs: positive(process.env.OPC_WATCHDOG_RECHECK_MS, 2 * 60_000),
    escalateAfterMs: positive(process.env.OPC_WATCHDOG_ESCALATE_MS, 15 * 60_000),
  });
  business = openBusiness();

  send({
    type: 'ready',
    pid: process.pid,
    businessDbOpen: business !== null,
    sessionDb: sessionDbPath,
    incidents: store.recent(INCIDENT_PAGE),
  });

  // 先立刻体检一次：主进程刚崩过一轮的话，证据要马上落到自己的库里，
  // 而不是等下一个间隔。
  evaluate();
  timer = setInterval(evaluate, intervalMs);
  timer.unref?.();

  parentPort?.on('message', (message) => handle(message.data));
}

process.on('uncaughtException', (error) => {
  send({ type: 'error', message: `未捕获异常：${error.message}` });
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  send({ type: 'error', message: `未处理的 rejection：${String(reason)}` });
});
// 父进程断开（主应用崩了 / 被强杀）。**不立刻退出**：这一刻正是最需要证据的时候，
// 而它自己的库还写得进去。留一个有界窗口继续记录，然后自己走——
// 无限活着会变成孤儿进程，下一次启动就会有两个 Watchdog。
process.on('disconnect', () => {
  orphaned = true;
  evaluate();
  const timer = setTimeout(() => shutdown(0), ORPHAN_GRACE_MS);
  // 故意**不** unref：这个定时器要维持进程活到窗口结束。
  void timer;
});

try {
  main();
} catch (error) {
  send({ type: 'error', message: `启动失败：${error instanceof Error ? error.message : String(error)}` });
  shutdown(1);
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
