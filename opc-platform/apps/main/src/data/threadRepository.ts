import type {
  AttentionLevel,
  ThreadState,
  TriggerEvent,
  TriggerSource,
  TriageState,
  Worker,
  WorkerStatus,
  WorkerTemplate,
  WorkReport,
  WorkThread,
} from '@opc/shared/domain';
import crypto from 'node:crypto';
import type { CompanyDatabase } from './companyDatabase';

/**
 * v2 core persistence: `thread` / `worker` / `event` / `report`
 * (docs/v2/00-audit.md §5.5, migration V25).
 *
 * The centre of gravity moved from `employee` to `thread`. Nothing here knows
 * about departments, positions, reporting lines or hiring — a worker is created
 * for the thread that needs it and retired when it is done.
 *
 * Coexists with the old tables on purpose: B3 migrates the consumers
 * (`comm` / `work` / `budget`) one at a time, and only B4 drops the org cluster.
 */

/** What this file needs from better-sqlite3's statement object. */
interface PreparedStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface CreateThreadInput {
  title: string;
  goal?: string;
  /** 环境身份；同一个 key 的后续事件会并到这条线上。 */
  threadKey?: string | null;
  attention?: AttentionLevel;
  /** Hard token ceiling for the whole thread; null = only the global cap applies. */
  budgetTokens?: number | null;
}

export interface CreateWorkerInput {
  name: string;
  template?: WorkerTemplate;
  skills?: readonly string[];
  threadId?: string | null;
  /** Who fills this execution body (an employee id during the migration). */
  employeeId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
}

export interface EnqueueEventInput {
  source?: TriggerSource;
  kind: string;
  payload?: Record<string, unknown>;
  threadId?: string | null;
}

/** A queue row with the line of work attached, for the attention screen. */
export interface QueueEntry extends WorkReport {
  threadTitle: string;
  threadState: ThreadState;
}

export interface AddReportInput {
  threadId: string;
  level?: AttentionLevel;
  title: string;
  body?: string;
}

interface ThreadRow {
  id: string;
  title: string;
  goal: string;
  thread_key: string | null;
  state: ThreadState;
  attention: AttentionLevel;
  budget_tokens: number | null;
  spent_tokens: number;
  created_at: number;
  last_activity_at: number;
  closed_at: number | null;
}

interface WorkerRow {
  id: string;
  name: string;
  template: WorkerTemplate;
  skills: string;
  thread_id: string | null;
  employee_id: string | null;
  model_provider: string | null;
  model_id: string | null;
  status: WorkerStatus;
  spent_tokens: number;
  created_at: number;
  retired_at: number | null;
}

interface EventRow {
  id: string;
  source: TriggerSource;
  kind: string;
  payload: string;
  thread_id: string | null;
  triage: TriageState;
  created_at: number;
  triaged_at: number | null;
}

interface ReportRow {
  id: string;
  thread_id: string;
  level: AttentionLevel;
  title: string;
  body: string;
  created_at: number;
  read_at: number | null;
}

/** States a finished thread can land in; both stop the router from resuming it. */
const TERMINAL: readonly ThreadState[] = ['done', 'failed', 'archived'];

export interface ThreadRepositoryOptions {
  /** Injected so tests drive the clock instead of sleeping. */
  now?: () => number;
  /** Injected so tests get stable ids. */
  id?: () => string;
}

export class ThreadRepository {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly db: CompanyDatabase,
    options: ThreadRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  // ── thread ──────────────────────────────────────────────────────────────

  createThread(input: CreateThreadInput): WorkThread {
    const at = this.now();
    const row = {
      id: this.id(),
      title: input.title,
      goal: input.goal ?? '',
      thread_key: input.threadKey ?? null,
      state: 'open' as ThreadState,
      attention: input.attention ?? ('silent' as AttentionLevel),
      budget_tokens: input.budgetTokens ?? null,
      spent_tokens: 0,
      created_at: at,
      last_activity_at: at,
      closed_at: null,
    };
    this.statement(
      `INSERT INTO thread (id, title, goal, thread_key, state, attention, budget_tokens, spent_tokens, created_at, last_activity_at, closed_at)
       VALUES (@id, @title, @goal, @thread_key, @state, @attention, @budget_tokens, @spent_tokens, @created_at, @last_activity_at, @closed_at)`,
    ).run(row);
    return toThread(row as ThreadRow);
  }

  getThread(id: string): WorkThread | null {
    const row = this.statement('SELECT * FROM thread WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** Newest activity first; the boss's list is ordered by "what moved last". */
  listThreads(input: { state?: ThreadState; limit?: number } = {}): WorkThread[] {
    const limit = input.limit ?? 50;
    const rows = input.state
      ? this.statement(
          'SELECT * FROM thread WHERE state = ? ORDER BY last_activity_at DESC LIMIT ?',
        ).all(input.state, limit)
      : this.statement('SELECT * FROM thread ORDER BY last_activity_at DESC LIMIT ?').all(limit);
    return (rows as ThreadRow[]).map(toThread);
  }

  /** Only what a router would pick up: still open, not terminal. */
  listActiveThreads(limit = 50): WorkThread[] {
    const rows = this.statement(
      `SELECT * FROM thread
        WHERE state NOT IN ('done','failed','archived')
        ORDER BY last_activity_at DESC LIMIT ?`,
    ).all(limit) as ThreadRow[];
    return rows.map(toThread);
  }

  /**
   * Moves a thread. Closing it stamps `closed_at`, and reopening clears it: a
   * thread that was closed by mistake must not keep a stale close time.
   */
  setState(id: string, state: ThreadState): WorkThread {
    const at = this.now();
    const closed = TERMINAL.includes(state) ? at : null;
    this.statement('UPDATE thread SET state = ?, closed_at = ?, last_activity_at = ? WHERE id = ?').run(
      state,
      closed,
      at,
      id,
    );
    return this.mustGetThread(id);
  }

  /** The only write that changes who is allowed to interrupt the boss. */
  setAttention(id: string, attention: AttentionLevel): WorkThread {
    this.statement('UPDATE thread SET attention = ?, last_activity_at = ? WHERE id = ?').run(
      attention,
      this.now(),
      id,
    );
    return this.mustGetThread(id);
  }

  /** Any touch of a thread keeps it at the top of "what moved last". */
  touch(id: string): void {
    this.statement('UPDATE thread SET last_activity_at = ? WHERE id = ?').run(this.now(), id);
  }

  /**
   * Records spend against a thread.
   *
   * Returns false when the thread has no ceiling or is still under it, true when
   * this charge crossed it — the caller decides whether crossing means "stop" or
   * "ask the boss". Nothing here silently refuses a charge: the ledger must not
   * disagree with the tokens actually spent.
   */
  charge(id: string, tokens: number): boolean {
    this.statement(
      'UPDATE thread SET spent_tokens = spent_tokens + ?, last_activity_at = ? WHERE id = ?',
    ).run(tokens, this.now(), id);
    const row = this.statement('SELECT budget_tokens, spent_tokens FROM thread WHERE id = ?').get(id) as
      | { budget_tokens: number | null; spent_tokens: number }
      | undefined;
    if (!row || row.budget_tokens === null) return false;
    return row.spent_tokens >= row.budget_tokens;
  }

  // ── worker ──────────────────────────────────────────────────────────────

  createWorker(input: CreateWorkerInput): Worker {
    const row = {
      id: this.id(),
      name: input.name,
      template: input.template ?? ('research' as WorkerTemplate),
      skills: JSON.stringify(input.skills ?? []),
      thread_id: input.threadId ?? null,
      employee_id: input.employeeId ?? null,
      model_provider: input.modelProvider ?? null,
      model_id: input.modelId ?? null,
      status: 'idle' as WorkerStatus,
      spent_tokens: 0,
      created_at: this.now(),
      retired_at: null,
    };
    this.statement(
      `INSERT INTO worker (id, name, template, skills, thread_id, employee_id, model_provider, model_id, status, spent_tokens, created_at, retired_at)
       VALUES (@id, @name, @template, @skills, @thread_id, @employee_id, @model_provider, @model_id, @status, @spent_tokens, @created_at, @retired_at)`,
    ).run(row);
    return toWorker(row as WorkerRow);
  }

  /**
   * The execution body for one (thread, employee) pair — reused if it exists.
   *
   * One thread may have several workers (that is why the harness is keyed by
   * worker, not by thread), but two tasks of the same person on the same line of
   * work must share one, or the same context gets rebuilt per task.
   */
  ensureWorker(input: {
    threadId: string;
    employeeId: string;
    name: string;
    template?: WorkerTemplate;
    /** Pinned when the worker is created: a line of work keeps its runtime. */
    modelProvider?: string | null;
    modelId?: string | null;
  }): Worker {
    const existing = this.statement(
      "SELECT * FROM worker WHERE thread_id = ? AND employee_id = ? AND status != 'retired' ORDER BY created_at LIMIT 1",
    ).get(input.threadId, input.employeeId) as WorkerRow | undefined;
    if (existing) return toWorker(existing);
    return this.createWorker({
      name: input.name,
      threadId: input.threadId,
      employeeId: input.employeeId,
      ...(input.template ? { template: input.template } : {}),
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
    });
  }

  getWorker(id: string): Worker | null {
    const row = this.statement('SELECT * FROM worker WHERE id = ?').get(id) as WorkerRow | undefined;
    return row ? toWorker(row) : null;
  }

  /** Workers still alive for a thread, in creation order. */
  listWorkers(threadId: string): Worker[] {
    const rows = this.statement(
      "SELECT * FROM worker WHERE thread_id = ? AND status != 'retired' ORDER BY created_at",
    ).all(threadId) as WorkerRow[];
    return rows.map(toWorker);
  }

  setWorkerStatus(id: string, status: WorkerStatus): Worker {
    this.statement('UPDATE worker SET status = ?, retired_at = ? WHERE id = ?').run(
      status,
      status === 'retired' ? this.now() : null,
      id,
    );
    const row = this.statement('SELECT * FROM worker WHERE id = ?').get(id) as WorkerRow | undefined;
    if (!row) throw new Error(`未知 worker: ${id}`);
    return toWorker(row);
  }

  /**
   * Ends a worker. It keeps its row (and its spend) — the thread's history must
   * still be able to say who did the work — but it leaves the thread.
   */
  retireWorker(id: string): Worker {
    return this.setWorkerStatus(id, 'retired');
  }

  // ── event (Trigger) ─────────────────────────────────────────────────────

  enqueueEvent(input: EnqueueEventInput): TriggerEvent {
    const row = {
      id: this.id(),
      source: input.source ?? ('manual' as TriggerSource),
      kind: input.kind,
      payload: JSON.stringify(input.payload ?? {}),
      thread_id: input.threadId ?? null,
      triage: 'pending' as TriageState,
      created_at: this.now(),
      triaged_at: null,
    };
    this.statement(
      `INSERT INTO event (id, source, kind, payload, thread_id, triage, created_at, triaged_at)
       VALUES (@id, @source, @kind, @payload, @thread_id, @triage, @created_at, @triaged_at)`,
    ).run(row);
    return toEvent(row as EventRow);
  }

  /** The only events a model may be asked about: the ones the program layer kept. */
  listPendingEvents(limit = 20): TriggerEvent[] {
    const rows = this.statement(
      "SELECT * FROM event WHERE triage = 'pending' ORDER BY created_at LIMIT ?",
    ).all(limit) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Records the verdict of the semantic layer.
   *
   * `accepted` must name the thread it belongs to; `dropped` and `merged` may
   * leave it null. A dropped event is never deleted — the boss has to be able to
   * see what the system decided to ignore.
   */
  triageEvent(id: string, triage: Exclude<TriageState, 'pending'>, threadId: string | null = null): TriggerEvent {
    if (triage === 'accepted' && !threadId) {
      throw new Error('accepted 事件必须指定 threadId');
    }
    this.statement('UPDATE event SET triage = ?, thread_id = ?, triaged_at = ? WHERE id = ?').run(
      triage,
      threadId,
      this.now(),
      id,
    );
    const row = this.statement('SELECT * FROM event WHERE id = ?').get(id) as EventRow | undefined;
    if (!row) throw new Error(`未知事件: ${id}`);
    return toEvent(row);
  }

  // ── report (the attention queue) ────────────────────────────────────────

  addReport(input: AddReportInput): WorkReport {
    const row = {
      id: this.id(),
      thread_id: input.threadId,
      level: input.level ?? ('notify' as AttentionLevel),
      title: input.title,
      body: input.body ?? '',
      created_at: this.now(),
      read_at: null,
    };
    this.statement(
      `INSERT INTO report (id, thread_id, level, title, body, created_at, read_at)
       VALUES (@id, @thread_id, @level, @title, @body, @created_at, @read_at)`,
    ).run(row);
    this.touch(input.threadId);
    return toReport(row as ReportRow);
  }

  /**
   * The boss's queue: unread, most urgent first.
   *
   * The ordering is the product: a `decide` row costs the boss a decision, so it
   * outranks every `notify` no matter how old. `silent` is deliberately absent —
   * it is a record, not an interruption.
   */
  listQueue(limit = 50): WorkReport[] {
    const rows = this.statement(
      `SELECT * FROM report
        WHERE read_at IS NULL AND level != 'silent'
        ORDER BY CASE level WHEN 'decide' THEN 0 ELSE 1 END, created_at DESC
        LIMIT ?`,
    ).all(limit) as ReportRow[];
    return rows.map(toReport);
  }

  /**
   * The same queue, joined to the line of work it came from.
   *
   * The boss's screen never shows a report id; it shows "整理 Q3 财报
   * 需要你拍板". Without the join the UI would have to fetch every thread just to
   * put a title on a row.
   */
  listQueueWithThread(limit = 50): QueueEntry[] {
    const rows = this.statement(
      `SELECT r.*, t.title AS thread_title, t.state AS thread_state
         FROM report r
         JOIN thread t ON t.id = r.thread_id
        WHERE r.read_at IS NULL AND r.level != 'silent'
        ORDER BY CASE r.level WHEN 'decide' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT ?`,
    ).all(limit) as (ReportRow & { thread_title: string; thread_state: ThreadState })[];
    return rows.map((row) => ({
      ...toReport(row),
      threadTitle: row.thread_title,
      threadState: row.thread_state,
    }));
  }

  markReportRead(id: string): WorkReport {
    this.statement('UPDATE report SET read_at = ? WHERE id = ?').run(this.now(), id);
    const row = this.statement('SELECT * FROM report WHERE id = ?').get(id) as ReportRow | undefined;
    if (!row) throw new Error(`未知汇报: ${id}`);
    return toReport(row);
  }

  // ── 链式召回的读取面（§3.3）─────────────────────────────────────────────

  /** 一条线的汇报，最新在前。Router 讲"最近怎么样"时只看这几条。 */
  listReportsOf(threadId: string, limit = 5): WorkReport[] {
    const rows = this.statement(
      'SELECT * FROM report WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(threadId, limit) as ReportRow[];
    return rows.map(toReport);
  }

  getReport(id: string): WorkReport | null {
    const row = this.statement('SELECT * FROM report WHERE id = ?').get(id) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  getEvent(id: string): TriggerEvent | null {
    const row = this.statement('SELECT * FROM event WHERE id = ?').get(id) as EventRow | undefined;
    return row ? toEvent(row) : null;
  }

  // ── 并线与订阅（§3.2）────────────────────────────────────────────────────

  /**
   * 这个环境身份上还在推进的那条线。
   *
   * 这是**直通**的判定：命中就说明"这条事件流的归属已经确定了"，程序可以直接
   * 发给订阅它的 worker，不必再让 Router 判一次。所以它必须是确定性的、便宜的、
   * 不看模型的——就是一个带索引的等值查询。
   *
   * 终态的线不返回：一条已经关掉的线不该再接过路的事件，那些事件是新工作。
   */
  threadByKey(key: string): WorkThread | null {
    const row = this.statement(
      `SELECT * FROM thread
        WHERE thread_key = ? AND state NOT IN ('done','failed','archived')
        ORDER BY last_activity_at DESC LIMIT 1`,
    ).get(key) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** Idempotent: re-subscribing a live worker is a no-op, not a duplicate row. */
  subscribe(threadId: string, workerId: string): void {
    this.statement(
      `INSERT INTO subscription (thread_id, worker_id, created_at, dropped_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(thread_id, worker_id) DO UPDATE SET dropped_at = NULL`,
    ).run(threadId, workerId, this.now());
  }

  /**
   * 退订。行不删：谁在什么时候盯过哪条线，是排查"为什么这个事件没人接"的唯一线索。
   */
  unsubscribe(threadId: string, workerId: string): void {
    this.statement(
      'UPDATE subscription SET dropped_at = ? WHERE thread_id = ? AND worker_id = ? AND dropped_at IS NULL',
    ).run(this.now(), threadId, workerId);
  }

  /** Workers still watching this line, newest subscription first. */
  subscribersOf(threadId: string): Worker[] {
    const rows = this.statement(
      `SELECT w.* FROM subscription s
         JOIN worker w ON w.id = s.worker_id
        WHERE s.thread_id = ? AND s.dropped_at IS NULL AND w.status != 'retired'
        ORDER BY s.created_at DESC`,
    ).all(threadId) as WorkerRow[];
    return rows.map(toWorker);
  }

  /** Every live subscription, for the passthrough index. */
  listLiveSubscriptions(): { threadId: string; workerId: string }[] {
    const rows = this.statement(
      `SELECT s.thread_id, s.worker_id FROM subscription s
         JOIN thread t ON t.id = s.thread_id
         JOIN worker w ON w.id = s.worker_id
        WHERE s.dropped_at IS NULL
          AND t.state NOT IN ('done','failed','archived')
          AND w.status != 'retired'`,
    ).all() as { thread_id: string; worker_id: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, workerId: row.worker_id }));
  }

  // ── 汇报播报（Router 对老板说过了）──────────────────────────────────────

  /**
   * 还没被 Router 拿去说过的汇报。
   *
   * 和 `listQueue` 不同：那是"老板还没读的"，这是"我还没讲的"。两者都需要——
   * 一条 silent 汇报老板永远不必读，但 Router 要把它并进那一轮的上下文里，否则
   * 它下一次回答"怎么样了"时对事实一无所知。
   */
  listUnannouncedReports(limit = 50): WorkReport[] {
    const rows = this.statement(
      `SELECT * FROM report WHERE announced_at IS NULL ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as ReportRow[];
    return rows.map(toReport);
  }

  markAnnounced(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const at = this.now();
    const run = this.statement('UPDATE report SET announced_at = ? WHERE id = ?');
    for (const id of ids) run.run(at, id);
  }

  /** 交不进去时撤回：宁可下一轮再讲一遍，不可丢一次。 */
  unmarkAnnounced(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const run = this.statement('UPDATE report SET announced_at = NULL WHERE id = ?');
    for (const id of ids) run.run(id);
  }

  /** 撤回一次 triage，让事件回到 pending。 */
  resetTriage(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const run = this.statement(
      "UPDATE event SET triage = 'pending', triaged_at = NULL, thread_id = NULL WHERE id = ?",
    );
    for (const id of ids) run.run(id);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private mustGetThread(id: string): WorkThread {
    const thread = this.getThread(id);
    if (!thread) throw new Error(`未知 thread: ${id}`);
    return thread;
  }

  /** Lazily prepared: better-sqlite3 caches by SQL string on the connection. */
  private statement(sql: string): PreparedStatement {
    return (this.db as unknown as { prepare(sql: string): PreparedStatement }).prepare(sql);
  }
}

function toThread(row: ThreadRow): WorkThread {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    threadKey: row.thread_key ?? null,
    state: row.state,
    attention: row.attention,
    budgetTokens: row.budget_tokens,
    spentTokens: row.spent_tokens,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    closedAt: row.closed_at,
  };
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    template: row.template,
    skills: parseList(row.skills),
    threadId: row.thread_id,
    employeeId: row.employee_id,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    status: row.status,
    spentTokens: row.spent_tokens,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

function toEvent(row: EventRow): TriggerEvent {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    payload: parseRecord(row.payload),
    threadId: row.thread_id,
    triage: row.triage,
    createdAt: row.created_at,
    triagedAt: row.triaged_at,
  };
}

function toReport(row: ReportRow): WorkReport {
  return {
    id: row.id,
    threadId: row.thread_id,
    level: row.level,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function parseList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecord(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
