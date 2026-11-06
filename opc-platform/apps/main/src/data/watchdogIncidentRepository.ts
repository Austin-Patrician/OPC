import type { CompanyDatabase } from './companyDatabase';

/**
 * Watchdog 的 incident **镜像**（`11-watchdog-spec.md` W3）。
 *
 * 事实源在 Watchdog 自己的库（`watchdog/store.ts`）：状态机必须能在主进程
 * 卡住时继续跑。这张表是给人、给 Router 看的一份副本，由父进程按子进程每轮的
 * `tick` 刷新——镜像可以丢，下一轮会写平。
 *
 * 因此这里只有两个写动作：`sync`（把子进程给的整页刷进来）和 `markHandled`
 * （人点过"我知道了"）。**不在这里推进状态**——那是子进程的事。
 */

export type IncidentState = 'active' | 'rechecking' | 'escalated' | 'resolved';

/** 子进程一页 incident 的结构；与 `StoredFinding` 兼容，但不依赖它。 */
export interface IncidentMirrorInput {
  id: string;
  kind: string;
  state: IncidentState;
  subjectType: string;
  subjectId: string;
  summary: string;
  detail: string;
  verdict?: { verdict: string; reason: string; confidence: number };
  judgedAt?: number;
  judgedBy?: string;
  firstAt: number;
  lastSeenAt: number;
  reopenCount: number;
  resolvedAt?: number;
}

export interface WatchdogIncident {
  id: string;
  kind: string;
  state: IncidentState;
  subjectType: string;
  subjectId: string;
  summary: string;
  /** 证据（JSON 字符串）。问答要用它才说得清"为什么这么判"。 */
  detail: string;
  /** 模型判断单独存储，不拼进规则摘要。 */
  verdict?: string;
  verdictReason?: string;
  verdictConfidence?: number;
  judgedAt?: number;
  judgedBy?: string;
  firstAt: number;
  lastSeenAt: number;
  reopenCount: number;
  resolvedAt?: number;
  /** 已经成功通知到人的时刻；`undefined` = 还没有。 */
  announcedAt?: number;
  announceAttempts?: number;
}

interface IncidentRow {
  id: string;
  kind: string;
  state: IncidentState;
  subject_type: string;
  subject_id: string;
  summary: string;
  detail: string;
  verdict: string;
  verdict_reason: string;
  verdict_confidence: number;
  judged_at: number | null;
  judged_by: string;
  first_at: number;
  last_seen_at: number;
  reopen_count: number;
  resolved_at: number | null;
  announced_at: number | null;
  announce_attempts: number;
}

/** 通知最多试几次。次数用完就停手，交给日志与人。 */
const MAX_ANNOUNCE_ATTEMPTS = 5;

export class WatchdogIncidentRepository {
  constructor(
    private readonly db: CompanyDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 把一页 incident 刷进镜像，并返回**还需要通知人**的那些。
   *
   * 为什么不是"刚好升级的那些"：升级是一次状态迁移，但"通知到人"是另一次动作，
   * 可能失败。以前两者被当成一件事——写报告失败那次就永久静音了。
   * 现在判据在库里（`announced_at IS NULL`），失败下一轮还会再试。
   *
   * 只 upsert、不删：子进程没再提的那些，可能是它被重启后还没跑到，也可能是
   * 这件事真的没人看了。把"没提到"解释成"已恢复"是错的——那是编造。
   */
  sync(rows: readonly IncidentMirrorInput[]): {
    written: number;
    escalated: readonly WatchdogIncident[];
  } {
    if (rows.length === 0) return { written: 0, escalated: [] };
    const now = this.now();
    const statement = this.db.prepare(
      `INSERT INTO watchdog_incident
         (id, kind, state, subject_type, subject_id, summary, detail,
          verdict, verdict_reason, verdict_confidence, judged_at, judged_by,
          first_at, last_seen_at, resolved_at, reopen_count, synced_at)
       VALUES (@id, @kind, @state, @subjectType, @subjectId, @summary, @detail,
               @verdict, @verdictReason, @verdictConfidence, @judgedAt, @judgedBy,
               @firstAt, @lastSeenAt, @resolvedAt, @reopenCount, @syncedAt)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         state = excluded.state,
         subject_type = excluded.subject_type,
         subject_id = excluded.subject_id,
         summary = excluded.summary,
         detail = excluded.detail,
         verdict = excluded.verdict,
         verdict_reason = excluded.verdict_reason,
         verdict_confidence = excluded.verdict_confidence,
         judged_at = excluded.judged_at,
         judged_by = excluded.judged_by,
         first_at = excluded.first_at,
         last_seen_at = excluded.last_seen_at,
         resolved_at = excluded.resolved_at,
         reopen_count = excluded.reopen_count,
         synced_at = excluded.synced_at`,
    );
    const write = this.db.transaction((list: readonly IncidentMirrorInput[]) => {
      for (const row of list) {
        statement.run({
          id: row.id,
          kind: row.kind,
          state: row.state,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          summary: row.summary,
          detail: row.detail,
          verdict: row.verdict?.verdict ?? '',
          verdictReason: row.verdict?.reason ?? '',
          verdictConfidence: row.verdict?.confidence ?? 0,
          judgedAt: row.judgedAt ?? null,
          judgedBy: row.judgedBy ?? '',
          firstAt: row.firstAt,
          lastSeenAt: row.lastSeenAt,
          resolvedAt: row.resolvedAt ?? null,
          reopenCount: row.reopenCount,
          syncedAt: now,
        });
      }
    });
    write(rows);

    const ids = rows.map((row) => row.id);
    return { written: rows.length, escalated: this.pendingAnnouncements(ids) };
  }

  /** 通知成功：记下来，以后再同步也不会重复打扰。 */
  markAnnounced(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = this.now();
    const statement = this.db.prepare(
      `UPDATE watchdog_incident
          SET announced_at = ?, announce_attempts = announce_attempts + 1
        WHERE id = ?`,
    );
    for (const id of ids) statement.run(now, id);
  }

  /** 通知失败：记一次尝试。次数用完就停手，不再每轮重试。 */
  markAnnounceAttempt(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(
      `UPDATE watchdog_incident SET announce_attempts = announce_attempts + 1 WHERE id = ?`,
    );
    for (const id of ids) statement.run(id);
  }

  /** 还没恢复的，最近活跃优先。 */
  listOpen(limit = 20): WatchdogIncident[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_incident
          WHERE state <> 'resolved'
          ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(Math.max(1, limit)) as IncidentRow[];
    return rows.map(toIncident);
  }

  listRecent(limit = 50): WatchdogIncident[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_incident ORDER BY last_seen_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as IncidentRow[];
    return rows.map(toIncident);
  }

  /**
   * 需要通知的那些：已经 escalated、还没成功通知过、也还没试够次数。
   *
   * 只看**这一页**里的 id：范围外的条目不属于这次同步，硬塞进来会让"哪些变了"
   * 变得不可解释。
   */
  private pendingAnnouncements(ids: readonly string[]): WatchdogIncident[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_incident
          WHERE id IN (${placeholders})
            AND state = 'escalated'
            AND announced_at IS NULL
            AND announce_attempts < ?`,
      )
      .all(...ids, MAX_ANNOUNCE_ATTEMPTS) as IncidentRow[];
    return rows.map(toIncident);
  }
}

function toIncident(row: IncidentRow): WatchdogIncident {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    summary: row.summary,
    detail: row.detail,
    ...(row.verdict ? { verdict: row.verdict } : {}),
    ...(row.verdict_reason ? { verdictReason: row.verdict_reason } : {}),
    ...(row.verdict ? { verdictConfidence: row.verdict_confidence } : {}),
    ...(row.judged_at === null ? {} : { judgedAt: row.judged_at }),
    ...(row.judged_by ? { judgedBy: row.judged_by } : {}),
    firstAt: row.first_at,
    lastSeenAt: row.last_seen_at,
    reopenCount: row.reopen_count,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.announced_at === null ? {} : { announcedAt: row.announced_at }),
    announceAttempts: row.announce_attempts,
  };
}
