import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from '../data/scrub';
import type { TraceRow } from './candidates';

/**
 * Watchdog 自己的库（`11-watchdog-spec.md` §2.2）。
 *
 * 这里是 incident 的**唯一事实源**：状态机（active → rechecking → escalated →
 * resolved）必须能在主进程卡住时继续推进，所以它不能住在主进程里。
 * 业务库里那张 `watchdog_incident` 是**镜像**，给 Router 与界面看；镜像坏了
 * 下一轮 tick 会重新写平。
 *
 * 两条纪律：
 *
 * 1. **去重落在库里**（部分唯一索引 `WHERE active = 1`），不落在内存的 `Set` 里。
 *    现在的旧 Watchdog 重启就失忆，正是因为它把"说过了"记在内存。
 * 2. **恢复要能自动关，复发要能重新开**：关掉的行保持 `resolved`，再出现时开新行并
 *    `reopen_count + 1`——那两次不是同一件事，但它们是同一类事。
 */

export type IncidentState = 'active' | 'rechecking' | 'escalated' | 'resolved';

export interface StoredFinding {
  id: string;
  /** 最近一次被观察到的时刻。 */
  at: number;
  kind: string;
  subjectType: string;
  subjectId: string;
  summary: string;
  detail: string;
  state: IncidentState;
  /** 第一次出现的时刻；状态机按它算年龄。 */
  firstAt: number;
  lastSeenAt: number;
  /** 这类事在这台机器上这是第几次复发。0 = 第一次。 */
  reopenCount: number;
  resolvedAt?: number;
  /** 模型给出的语义判断（W5）。没有就是还没判过。 */
  verdict?: Judgment;
  judgedAt?: number;
  /** `child` = 子进程自己判的；`parent` = 主进程代判（无静态凭据时的兜底）。 */
  judgedBy?: string;
  /** 请求过的动作（W6）。 */
  action?: string;
  actedAt?: number;
  actionResult?: string;
}

/** 语义判断。`insufficient_evidence` 是一个**合法结论**，不是失败。 */
export interface Judgment {
  verdict: 'progressing' | 'stalled' | 'looping' | 'deviating' | 'insufficient_evidence';
  reason: string;
  confidence: number;
}

interface FindingRow {
  id: string;
  at: number;
  kind: string;
  subject_type: string;
  subject_id: string;
  summary: string;
  detail: string;
  active: number;
  state: IncidentState;
  first_at: number;
  last_seen_at: number;
  reopen_count: number;
  resolved_at: number | null;
  verdict: string;
  verdict_reason: string;
  verdict_confidence: number;
  judged_at: number | null;
  judged_by: string;
  action: string;
  acted_at: number | null;
  action_result: string;
}

/** 只读的一次业务库观察结果。子进程算出结论，不是原文。 */
export interface WatchdogSnapshot {
  /** 主进程心跳；`null` 表示从来没写过（老库或刚装）。 */
  heartbeat: { at: number; state: string; instanceId: string } | null;
  openEvents: number;
  pendingTasks: number;
  /** 开着但很久没动的运行中任务。 */
  staleRunning: readonly { id: string; title: string; idleMs: number }[];
}

export interface RaiseInput {
  kind: string;
  subjectType?: string;
  subjectId?: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface StoreThresholds {
  /** 持续这么久还没自己好 → rechecking（说明它不是一闪而过）。 */
  recheckAfterMs: number;
  /** 再久 → escalated（该有人看了）。 */
  escalateAfterMs: number;
}

export const DEFAULT_STORE_THRESHOLDS: StoreThresholds = {
  recheckAfterMs: 2 * 60_000,
  escalateAfterMs: 15 * 60_000,
};

export class WatchdogStore {
  private thresholds: StoreThresholds;

  private constructor(
    private readonly db: Database.Database,
    thresholds: StoreThresholds,
  ) {
    this.thresholds = thresholds;
  }

  /** 规则可以在运行时改（W7）：设置页保存后，下一轮就按新值走。 */
  setThresholds(thresholds: StoreThresholds): void {
    this.thresholds = thresholds;
  }

  static open(file: string, thresholds: StoreThresholds = DEFAULT_STORE_THRESHOLDS): WatchdogStore {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS watchdog_finding (
        id           TEXT PRIMARY KEY,
        at           INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        subject_type TEXT NOT NULL DEFAULT '',
        subject_id   TEXT NOT NULL DEFAULT '',
        summary      TEXT NOT NULL DEFAULT '',
        detail       TEXT NOT NULL DEFAULT '',
        active       INTEGER NOT NULL DEFAULT 1,
        state        TEXT NOT NULL DEFAULT 'active',
        first_at     INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        reopen_count INTEGER NOT NULL DEFAULT 0,
        resolved_at  INTEGER,
        verdict      TEXT NOT NULL DEFAULT '',
        verdict_reason TEXT NOT NULL DEFAULT '',
        verdict_confidence REAL NOT NULL DEFAULT 0,
        judged_at    INTEGER,
        judged_by    TEXT NOT NULL DEFAULT '',
        action       TEXT NOT NULL DEFAULT '',
        acted_at     INTEGER,
        action_result TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_watchdog_finding_recent ON watchdog_finding(at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchdog_finding_active
        ON watchdog_finding(kind, subject_type, subject_id)
        WHERE active = 1;

      CREATE TABLE IF NOT EXISTS watchdog_tick (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        at   INTEGER NOT NULL,
        pid  INTEGER NOT NULL
      );

      -- 任务扫描游标：每轮接着上一轮往后看，避免"最旧的 20 个"长期占满窗口。
      CREATE TABLE IF NOT EXISTS watchdog_cursor (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at INTEGER NOT NULL DEFAULT 0,
        task_id    TEXT NOT NULL DEFAULT ''
      );
    `);
    migrateFinding(db);
    return new WatchdogStore(db, thresholds);
  }

  tick(now: number, pid: number): void {
    this.db
      .prepare(
        `INSERT INTO watchdog_tick (id, at, pid) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, pid = excluded.pid`,
      )
      .run(now, pid);
  }

  lastTick(): number | null {
    const row = this.db.prepare(`SELECT at FROM watchdog_tick WHERE id = 1`).get() as
      | { at: number }
      | undefined;
    return row?.at ?? null;
  }

  /**
   * 报一件事。同一种症状在同一种对象上只留一条活跃记录；已经在的就只更新。
   *
   * 年龄从 `first_at` 算，不从"上次看到"算：一条一直在发生的问题不会因为被
   * 反复观察到就永远停在"刚出现"。
   */
  raise(input: RaiseInput, now: number): StoredFinding {
    const subjectType = input.subjectType ?? '';
    const subjectId = input.subjectId ?? '';
    // 摘要来自任务标题与动作摘要，里面可能夹着一段命令或 URL。
    // 它会被镜像到业务库、喂给模型、在问答里念出来——所以入口就要脱敏。
    const summary = scrubSecrets(input.summary);
    // detail 是一段 JSON 文本，只被当字符串用（镜像、问答、证据），所以整段过一遍
    // 是安全的——它不会被反解析。
    const detail = scrubSecrets(JSON.stringify(input.detail ?? {}));
    const active = this.findActive(input.kind, subjectType, subjectId);

    if (active) {
      const state = this.advance(active.state, active.first_at, now);
      this.db
        .prepare(
          `UPDATE watchdog_finding
              SET at = ?, last_seen_at = ?, summary = ?, detail = ?, state = ?
            WHERE id = ?`,
        )
        .run(now, now, clip(summary, 400), clip(detail, 2000), state, active.id);
      return toFinding({ ...active, at: now, last_seen_at: now, state });
    }

    const previous = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM watchdog_finding
          WHERE kind = ? AND subject_type = ? AND subject_id = ? AND active = 0`,
      )
      .get(input.kind, subjectType, subjectId) as { n: number };

    const row: FindingRow = {
      id: crypto.randomUUID(),
      at: now,
      kind: clip(input.kind, 80),
      subject_type: clip(subjectType, 40),
      subject_id: clip(subjectId, 120),
      summary: clip(summary, 400),
      detail: clip(detail, 2000),
      active: 1,
      state: 'active',
      first_at: now,
      last_seen_at: now,
      reopen_count: previous.n,
      resolved_at: null,
      verdict: '',
      verdict_reason: '',
      verdict_confidence: 0,
      judged_at: null,
      judged_by: '',
      action: '',
      acted_at: null,
      action_result: '',
    };
    this.db
      .prepare(
        `INSERT INTO watchdog_finding
           (id, at, kind, subject_type, subject_id, summary, detail, active, state,
            first_at, last_seen_at, reopen_count, resolved_at)
         VALUES (@id, @at, @kind, @subject_type, @subject_id, @summary, @detail, @active, @state,
                 @first_at, @last_seen_at, @reopen_count, @resolved_at)`,
      )
      .run(row);
    return toFinding(row);
  }

  /** 症状消失了就关掉它；下一次再出现会开一条新记录（`reopen_count + 1`）。 */
  resolve(kind: string, subjectType: string, subjectId: string, now: number): number {
    const result = this.db
      .prepare(
        `UPDATE watchdog_finding
            SET active = 0, state = 'resolved', resolved_at = ?, last_seen_at = ?
          WHERE kind = ? AND subject_type = ? AND subject_id = ? AND active = 1`,
      )
      .run(now, now, kind, subjectType, subjectId);
    return result.changes;
  }

  /**
   * 时间驱动的状态推进。每轮体检都跑一次。
   *
   * 为什么状态要由时间推：没有这一层，"这个问题存在 20 分钟了"就只写在摘要里；
   * 有了它，界面和后续的修复动作可以按状态做事，而不是每次重新读时间戳算一遍。
   */
  sweep(now: number): void {
    const rows = this.db
      .prepare(`SELECT id, state, first_at FROM watchdog_finding WHERE active = 1`)
      .all() as { id: string; state: IncidentState; first_at: number }[];
    const update = this.db.prepare(`UPDATE watchdog_finding SET state = ? WHERE id = ?`);
    for (const row of rows) {
      const next = this.advance(row.state, row.first_at, now);
      if (next !== row.state) update.run(next, row.id);
    }
  }

  /** 全部（含已恢复），按最近活跃排序。父进程用它同步镜像。 */
  recent(limit = 50): StoredFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_finding ORDER BY last_seen_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as FindingRow[];
    return rows.map(toFinding);
  }

  /** 还没恢复的。 */
  active(): StoredFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_finding WHERE active = 1 ORDER BY first_at ASC`)
      .all() as FindingRow[];
    return rows.map(toFinding);
  }

  /**
   * 该判哪一条。
   *
   * 一次只给一条：判断要花一次模型调用，"每轮最多一次"就是花销的闸门。
   * 冷却由 `judged_at` 承担——它存在库里，重启之后也记得判过。
   */
  needsJudgment(now: number, cooldownMs: number): StoredFinding | null {
    const row = this.db
      .prepare(
        `SELECT * FROM watchdog_finding
          WHERE active = 1 AND (judged_at IS NULL OR judged_at < ?)
          ORDER BY first_at ASC
          LIMIT 1`,
      )
      .get(now - cooldownMs) as FindingRow | undefined;
    return row ? toFinding(row) : null;
  }

  /** 落一条判断。`by` 记录是谁判的：`child` = 子进程自己，`parent` = 主进程代判。 */
  setVerdict(id: string, judgment: Judgment, now: number, escalate: boolean, by = 'parent'): void {
    const current = this.db
      .prepare(`SELECT summary FROM watchdog_finding WHERE id = ?`)
      .get(id) as { summary: string } | undefined;
    if (!current) return;
    this.db
      .prepare(
        `UPDATE watchdog_finding
            SET verdict = ?, verdict_reason = ?, verdict_confidence = ?, judged_at = ?,
                judged_by = ?, summary = ?,
                state = CASE WHEN ? = 1 THEN 'escalated' ELSE state END
          WHERE id = ?`,
      )
      .run(
        judgment.verdict,
        clip(judgment.reason, 400),
        judgment.confidence,
        now,
        by,
        clip(`${scrubSecrets(current.summary)}｜模型判断：${label(judgment)}`, 400),
        escalate ? 1 : 0,
        id,
      );
  }

  /**
   * 判断失败也要记一次"判过了"。
   *
   * 否则模型不可用的每一轮都会重试，把冷却时间变成一分钟一次的重试风暴。
   */
  markJudged(id: string, now: number): void {
    this.db.prepare(`UPDATE watchdog_finding SET judged_at = ? WHERE id = ?`).run(now, id);
  }

  /** 任务扫描游标（W4/W8 修正）：跨重启保留，避免同一批任务长期占满窗口。 */
  readCursor(): TaskScanCursor {
    const row = this.db
      .prepare(`SELECT updated_at, task_id FROM watchdog_cursor WHERE id = 1`)
      .get() as { updated_at: number; task_id: string } | undefined;
    return { updatedAt: row?.updated_at ?? 0, id: row?.task_id ?? '' };
  }

  writeCursor(cursor: TaskScanCursor): void {
    this.db
      .prepare(
        `INSERT INTO watchdog_cursor (id, updated_at, task_id) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, task_id = excluded.task_id`,
      )
      .run(cursor.updatedAt, cursor.id);
  }

  /** 已经判过的条数：探针用它等模型那一趟往返。 */
  judgedCount(): number {    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM watchdog_finding WHERE verdict <> ''`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * 该对哪条 incident 请求动手。
   *
   * `kinds` 是白名单：只有这些症状有对应的动作（目前只有 MCP 断连）。
   * 冷却按 `acted_at` 算，和判断一样落库——重启之后不会把同一个重连又跑一遍。
   */
  needsAction(kinds: readonly string[], now: number, cooldownMs: number): StoredFinding | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT * FROM watchdog_finding
          WHERE active = 1 AND kind IN (${placeholders})
            AND (acted_at IS NULL OR acted_at < ?)
          ORDER BY first_at ASC
          LIMIT 1`,
      )
      .get(...kinds, now - cooldownMs) as FindingRow | undefined;
    return row ? toFinding(row) : null;
  }

  /**
   * 动作的结果。
   *
   * 失败**不**改状态、也不关 incident：动作失败只说明"这次没修好"，问题还在。
   * 把失败写成已解决，是这类系统最容易犯的谎。
   */
  setActionResult(id: string, action: string, result: string, now: number): void {
    this.db
      .prepare(
        `UPDATE watchdog_finding
            SET action = ?, acted_at = ?, action_result = ?
          WHERE id = ?`,
      )
      .run(action, now, clip(result, 400), id);
  }

  close(): void {
    this.db.close();  }

  private findActive(kind: string, subjectType: string, subjectId: string): FindingRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM watchdog_finding
          WHERE kind = ? AND subject_type = ? AND subject_id = ? AND active = 1`,
      )
      .get(kind, subjectType, subjectId) as FindingRow | undefined;
  }

  private advance(state: IncidentState, firstAt: number, now: number): IncidentState {
    if (state === 'resolved') return state;
    const age = now - firstAt;
    if (age >= this.thresholds.escalateAfterMs) return 'escalated';
    // 只升不降：已经 escalated 的不会因为时间"变年轻"退回 rechecking。
    if (state === 'escalated') return 'escalated';
    if (age >= this.thresholds.recheckAfterMs) return 'rechecking';
    return state;
  }
}

/** 旧库补列。逐列判断、逐列加：整段 ALTER 在一半列已存在时会整体失败。 */
function migrateFinding(db: Database.Database): void {
  const has = (name: string): boolean =>
    (db.prepare(`PRAGMA table_info(watchdog_finding)`).all() as { name: string }[]).some(
      (row) => row.name === name,
    );
  const ensure = (name: string, ddl: string): boolean => {
    if (has(name)) return false;
    db.exec(`ALTER TABLE watchdog_finding ADD COLUMN ${ddl}`);
    return true;
  };

  const addedState = ensure('state', "state TEXT NOT NULL DEFAULT 'active'");
  ensure('first_at', 'first_at INTEGER NOT NULL DEFAULT 0');
  ensure('last_seen_at', 'last_seen_at INTEGER NOT NULL DEFAULT 0');
  ensure('reopen_count', 'reopen_count INTEGER NOT NULL DEFAULT 0');
  if (addedState) {
    db.exec(`
      UPDATE watchdog_finding SET first_at = at WHERE first_at = 0;
      UPDATE watchdog_finding SET last_seen_at = at WHERE last_seen_at = 0;
      UPDATE watchdog_finding SET state = 'resolved' WHERE active = 0;
    `);
  }

  // W5：模型给出的结论 + 谁判的。空字符串 = 还没判过。
  ensure('verdict', "verdict TEXT NOT NULL DEFAULT ''");
  ensure('verdict_reason', "verdict_reason TEXT NOT NULL DEFAULT ''");
  ensure('verdict_confidence', 'verdict_confidence REAL NOT NULL DEFAULT 0');
  ensure('judged_at', 'judged_at INTEGER');
  ensure('judged_by', "judged_by TEXT NOT NULL DEFAULT ''");

  // W6：请求过什么、什么时候、结果如何。
  ensure('action', "action TEXT NOT NULL DEFAULT ''");
  ensure('acted_at', 'acted_at INTEGER');
  ensure('action_result', "action_result TEXT NOT NULL DEFAULT ''");
}

function toFinding(row: FindingRow): StoredFinding {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    summary: row.summary,
    detail: row.detail,
    state: row.state,
    firstAt: row.first_at,
    lastSeenAt: row.last_seen_at,
    reopenCount: row.reopen_count,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.verdict
      ? {
          verdict: {
            verdict: row.verdict as Judgment['verdict'],
            reason: row.verdict_reason,
            confidence: row.verdict_confidence,
          },
        }
      : {}),
    ...(row.judged_at === null ? {} : { judgedAt: row.judged_at }),
    ...(row.judged_by ? { judgedBy: row.judged_by } : {}),
    ...(row.action ? { action: row.action } : {}),
    ...(row.acted_at === null ? {} : { actedAt: row.acted_at }),
    ...(row.action_result ? { actionResult: row.action_result } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 结论的中文说法。写进摘要，所以它必须是一句人话。 */
export function label(judgment: Judgment): string {
  switch (judgment.verdict) {
    case 'progressing':
      return '还在往前走';
    case 'stalled':
      return '确实停住了';
    case 'looping':
      return '在原地打转';
    case 'deviating':
      return '偏离了目标';
    case 'insufficient_evidence':
      return '证据不足，判不了';
  }
}

/**
 * 一次体检要用的只读查询。
 *
 * 宁可查空也不补齐：业务库的 schema 由主进程迁移，子进程**不负责**建表。
 * 表不存在就说明版本不匹配——那是要报出来的事，不是要在这里被"修好"的。
 */
export function readSnapshot(
  db: Database.Database,
  now: number,
  idleThresholdMs: number,
): WatchdogSnapshot {
  const heartbeat = db
    .prepare(`SELECT at, state, instance_id FROM system_heartbeat WHERE id = 'main'`)
    .get() as { at: number; state: string; instance_id: string } | undefined;

  const openEvents = (
    db.prepare(`SELECT COUNT(*) AS n FROM system_event WHERE handled_at IS NULL`).get() as {
      n: number;
    }
  ).n;

  const pendingTasks = (
    db.prepare(`SELECT COUNT(*) AS n FROM task WHERE status IN ('open','running')`).get() as {
      n: number;
    }
  ).n;

  const staleRunning = db
    .prepare(
      `SELECT id, title, updated_at FROM task
        WHERE status = 'running' AND updated_at < ?
        ORDER BY updated_at ASC LIMIT 5`,
    )
    .all(now - idleThresholdMs) as { id: string; title: string; updated_at: number }[];

  return {
    heartbeat: heartbeat
      ? { at: heartbeat.at, state: heartbeat.state, instanceId: heartbeat.instance_id }
      : null,
    openEvents,
    pendingTasks,
    staleRunning: staleRunning.map((task) => ({
      id: task.id,
      title: task.title,
      idleMs: now - task.updated_at,
    })),
  };
}

/**
 * 还在跑的任务（W4 的候选来自它们）。
 *
 * 上限 20：这不是"漏掉就看不见"的问题——下一轮还会再看一遍，只是换个批次。
 * 一个子进程每轮把一万条任务全读一遍，比漏掉几条更糟。
 */
export interface RunningTaskView {
  id: string;
  title: string;
  updatedAt: number;
  startedAt: number | null;
}

/** 分页扫描的游标：按 (updated_at, id) 递增，天然稳定。 */
export interface TaskScanCursor {
  updatedAt: number;
  id: string;
}

export interface TaskScan {
  tasks: RunningTaskView[];
  /**
   * 这一轮是否扫到了队尾。
   *
   * 它**不是**"关发现"的判据：任务多于一页时，每轮只扫一段，拿"这一轮没看见"
   * 当"已经恢复"会把上一段还在打转的发现全部关掉。关不关由调用方按任务判
   * （这一轮看过它没有 / 它还在不在 running）。
   */
  wrapped: boolean;
  next: TaskScanCursor;
}

/**
 * 按游标取一页运行中的任务。
 *
 * 为什么要游标：固定取"最旧的 20 个"时，长时间不结束的任务会永久占住窗口，
 * 后面的任务永远轮不到——那不是"漏一次"，是稳定地饿死一半。游标到队尾后
 * 归零，下一轮从头再来，于是每一轮都在推进。
 */
export function readRunningTasks(
  db: Database.Database,
  limit: number,
  cursor: TaskScanCursor,
): TaskScan {
  const rows = db
    .prepare(
      `SELECT id, title, updated_at, started_at FROM task
        WHERE status = 'running'
          AND (updated_at > ? OR (updated_at = ? AND id > ?))
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
    )
    .all(cursor.updatedAt, cursor.updatedAt, cursor.id, Math.max(1, limit)) as {
    id: string;
    title: string;
    updated_at: number;
    started_at: number | null;
  }[];

  const tasks = rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
  }));

  const last = rows[rows.length - 1];
  const wrapped = rows.length < Math.max(1, limit);
  return {
    tasks,
    wrapped,
    next: wrapped || !last ? { updatedAt: 0, id: '' } : { updatedAt: last.updated_at, id: last.id },
  };
}

/** 最近的动作，**按 seq 升序**返回（规则要从旧到新看）。 */
export function readTrace(db: Database.Database, taskId: string, limit = 20): TraceRow[] {
  const rows = db
    .prepare(
      `SELECT seq, at, kind, name, args_digest, ok FROM task_trace
        WHERE task_id = ?
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(taskId, Math.max(1, limit)) as {
    seq: number;
    at: number;
    kind: string;
    name: string;
    args_digest: string;
    ok: number | null;
  }[];

  return rows.reverse().map((row) => ({
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    name: row.name,
    // 动作摘要来自工具参数，里面可能是一整条命令或 URL。它会被喂给模型
    // （本地或主进程代判），所以在**读**这里抹一遍——写端修是另一件事。
    argsDigest: scrubSecrets(row.args_digest),
    ok: row.ok === null ? null : row.ok !== 0,
  }));
}

/** 判断要用的一件活的全部背景：它想做什么（验收标准），以及它做到了哪一步。 */
export interface TaskDetailView {
  id: string;
  title: string;
  goal: string;
  updatedAt: number;
  startedAt: number | null;
}

/**
 * 一个任务现在的状态；行不在了返回 `null`。
 *
 * 只在"这条发现这一轮没被扫到"时用：它可能排在后面的页里（还在跑），
 * 也可能早就结束了。只有后者才允许把发现关掉。
 */
export function readTaskStatus(db: Database.Database, taskId: string): string | null {
  const row = db.prepare(`SELECT status FROM task WHERE id = ?`).get(taskId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

export function readTask(db: Database.Database, taskId: string): TaskDetailView | null {
  const row = db
    .prepare(
      `SELECT id, title, deliverable_spec, updated_at, started_at FROM task WHERE id = ?`,
    )
    .get(taskId) as
    | {
        id: string;
        title: string;
        deliverable_spec: string | null;
        updated_at: number;
        started_at: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    goal: row.deliverable_spec ?? '',
    updatedAt: row.updated_at,
    startedAt: row.started_at,
  };
}

/**
 * 还没人处理的系统故障（W6 的动作来源）。
 *
 * 这些事以前只有一句 `console.warn`，现在它们是 incident：有主体、有证据、
 * 有状态。MCP 连不上是唯一一个"重连一次就可能自己好"的，所以它也是目前
 * 唯一有对应动作的症状。
 */
export interface OpenEventView {
  id: string;
  at: number;
  kind: string;
  subjectType: string;
  subjectId: string;
  summary: string;
}

export function readOpenEvents(db: Database.Database, limit = 10): OpenEventView[] {
  const rows = db
    .prepare(
      `SELECT id, at, kind, subject_type, subject_id, summary FROM system_event
        WHERE handled_at IS NULL
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, limit)) as {
    id: string;
    at: number;
    kind: string;
    subject_type: string;
    subject_id: string;
    summary: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    summary: row.summary,
  }));
}
