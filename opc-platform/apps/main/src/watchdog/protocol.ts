import type { Judgment, StoredFinding, WatchdogSnapshot } from './store';

/**
 * 父进程 ↔ Watchdog 子进程之间**唯一**的对话。
 *
 * 只有这几种消息，而且是单向的：子进程报告它看到了什么、想判哪一条；
 * 父进程回答判断结果，也只能问"你还活着吗"和"停"。
 *
 * 为什么判断由父进程执行（W5 的一个明确取舍）：**凭据只在主进程解密**
 * （safeStorage）。把明文密钥送进第二个进程，能买到的只是"主进程卡住时还能做
 * 语义判断"；而真正需要活过主进程故障的是**发现与记录**，那两件事已经在子进程里，
 * 不依赖模型。等真要做"判断也要活过主进程"，那是另一条决策（给子进程一份
 * 权限受限的凭据），不靠顺手多传一个环境变量解决。
 */

export type WatchdogCommand =
  | { type: 'ping' }
  | { type: 'stop' }
  | { type: 'judge-result'; requestId: string; findingId: string; result: JudgeResult }
  | {
      type: 'action-result';
      requestId: string;
      incidentId: string;
      action: string;
      ok: boolean;
      message: string;
    };

/**
 * 它能请求的动作。**白名单在类型里**：加一条新动作必须先在这里写清楚它的名字，
 * 顺手多一个字符串是通不过类型检查的。
 *
 * 没有 `kill`、没有 `retry_task`——那些仍然只能建议，不能自动做（§3.2）。
 */
export type ActionName = 'mcp.reconnect';

export interface ActionPayload {
  incidentId: string;
  action: ActionName;
  reason: string;
  evidence: string;
}

/** 交给模型的东西：目标 + 候选 + 证据。没有别的一一模型不该看见整库。 */
export interface JudgePayload {
  taskId: string;
  title: string;
  goal: string;
  candidate: { kind: string; summary: string; detail: string };
  trace: readonly { seq: number; at: number; name: string; argsDigest: string; ok: boolean | null }[];
}

export type JudgeResult =
  | ({ ok: true } & Judgment & { model?: string })
  | { ok: false; error: string };

export type WatchdogEvent =
  | {
      type: 'ready';
      pid: number;
      businessDbOpen: boolean;
      sessionDb: string;
      incidents: StoredFinding[];
    }
  | { type: 'tick'; at: number; snapshot: WatchdogSnapshot; incidents: StoredFinding[] }
  | { type: 'judge'; requestId: string; findingId: string; payload: JudgePayload }
  | { type: 'action'; requestId: string; payload: ActionPayload }
  | {
      type: 'pong';
      at: number;
      uptimeMs: number;
      lastTickAt: number | null;
      activeFindings: number;
      /** 已经有模型结论的条数。 */
      judged: number;
    }
  | { type: 'error'; message: string };

export type WatchdogPong = Extract<WatchdogEvent, { type: 'pong' }>;
