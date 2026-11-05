import type { CompanyDatabase } from './companyDatabase';

/**
 * Watchdog 的动作账本（`11-watchdog-spec.md` W6）。
 *
 * 记的是**请求**，不是实现：实现永远在主进程里跑（凭据、业务不变量都在那边）。
 * 这张表存在的理由有三个，缺一个都不该加一张表：
 *
 * 1. **幂等**：`UNIQUE (incident_id, action)` 让同一个请求重发一百次也只执行一次。
 *    子进程会在超时后重发——没有这一层，一次断线就会让"重连"跑很多次。
 * 2. **审计**：谁在什么时候、因为哪条证据、要求系统做了什么。
 * 3. **失败也要留痕**：执行失败写 `failed` + 原因，绝不把 incident 当成已恢复。
 */

export type ActionStatus = 'pending' | 'done' | 'failed' | 'refused';

/** 认领的结果。**"没认领到"不是一种状态**：每种原因对应不同的下一步。 */
export type ClaimResult = 'claimed' | 'done' | 'refused' | 'in_flight' | 'exhausted';

export interface ActionRequest {
  incidentId: string;
  action: string;
  reason: string;
  evidence: string;
}

export interface ActionOutcome {
  /** false = 这次没有执行（已经做过，或者不在白名单里）。 */
  executed: boolean;
  status: ActionStatus;
  message: string;
}

interface ActionRow {
  id: string;
  incident_id: string;
  action: string;
  reason: string;
  evidence: string;
  requested_at: number;
  executed_at: number | null;
  status: ActionStatus;
  result: string;
  attempts: number;
}

/** 超过这个时间还停在 `pending`，说明执行它的那个进程已经不在了。 */
const STALE_PENDING_MS = 5 * 60_000;
/** 同一条动作最多做几次。失败可以重试，但不能无限重试。 */
const MAX_ATTEMPTS = 3;

export class WatchdogActionRepository {
  constructor(
    private readonly db: CompanyDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 认领一次动作。
   *
   * 这里最容易犯的错是把"没认领到"当成一种情况（"已经执行过了"）。实际上有五种，
   * 而它们的下一步完全不同：
   *
   * - `claimed`  ：这次由你执行；
   * - `done`     ：真的做过，幂等跳过；
   * - `refused`  ：不在白名单，不再重试；
   * - `in_flight`：另一个执行还没回（或刚崩、还没到超时），等；
   * - `exhausted`：试够次数了，交给人和日志。
   *
   * 旧实现把 pending 与 failed 都当成 done，于是"认领后崩溃"会被永久当成修好了。
   */
  claim(request: ActionRequest): ClaimResult {
    const now = this.now();
    const existing = this.db
      .prepare(`SELECT * FROM watchdog_action WHERE incident_id = ? AND action = ?`)
      .get(request.incidentId, request.action) as ActionRow | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO watchdog_action
             (id, incident_id, action, reason, evidence, requested_at, executed_at, status, result, attempts)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', '', 1)`,
        )
        .run(
          crypto.randomUUID(),
          request.incidentId,
          request.action,
          clip(request.reason, 400),
          clip(request.evidence, 800),
          now,
        );
      return 'claimed';
    }

    if (existing.status === 'done') return 'done';
    if (existing.status === 'refused') return 'refused';
    if (existing.attempts >= MAX_ATTEMPTS) return 'exhausted';
    // 还在执行窗口里：另一个进程可能正在做，重复请求只会打架。
    if (existing.status === 'pending' && now - existing.requested_at < STALE_PENDING_MS) {
      return 'in_flight';
    }

    // failed，或者 pending 已经超时（执行它的进程多半已经不在了）：重新认领。
    this.db
      .prepare(
        `UPDATE watchdog_action
            SET status = 'pending', requested_at = ?, executed_at = NULL,
                result = '', attempts = attempts + 1,
                reason = ?, evidence = ?
          WHERE id = ?`,
      )
      .run(now, clip(request.reason, 400), clip(request.evidence, 800), existing.id);
    return 'claimed';
  }

  finish(incidentId: string, action: string, status: ActionStatus, message: string): void {
    this.db
      .prepare(
        `UPDATE watchdog_action
            SET executed_at = ?, status = ?, result = ?
          WHERE incident_id = ? AND action = ?`,
      )
      .run(this.now(), status, clip(message, 400), incidentId, action);
  }

  listRecent(limit = 20): {
    incidentId: string;
    action: string;
    status: ActionStatus;
    at: number;
    result: string;
  }[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_action ORDER BY requested_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as ActionRow[];
    return rows.map((row) => ({
      incidentId: row.incident_id,
      action: row.action,
      status: row.status,
      at: row.executed_at ?? row.requested_at,
      result: row.result,
    }));
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
