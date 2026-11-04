import type {
  AcceptanceTemplate,
  IssueLink,
  LinkType,
  TaskAcceptance,
  TaskFailureKind,
  TaskStatus,
  TaskSteering,
  TaskTrace,
  TaskTraceKind,
  WorkTask,
} from '@opc/shared/domain';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CompanyDatabase } from './companyDatabase';

/** What a task needs at creation; anything else is derived or defaulted. */
export interface CreateTaskDraft {
  title: string;
  brief: string;
  deliverableSpec: string;
  assigneeId: string;
  /** Charges this project's budget; stored so a resumed task keeps its axis. */
  projectGroupId?: string;
  /** The v2 line of work this task belongs to; subtasks inherit it. */
  threadId?: string;
  /** The execution body that runs it; also the harness key. */
  workerId?: string;
  estTokens: number;
  acceptanceCommand: string[];
  acceptanceTemplate: AcceptanceTemplate;
}

/**
 * What this file needs from better-sqlite3's statement object.
 *
 * Declared structurally instead of importing the addon's namespaced types: the
 * package is xport =, so its Statement alias is unreachable from an ESM type
 * import, and this is the whole surface used here.
 */
interface PreparedStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Position in the task tree; both fields travel together. */
export interface TaskTreePlacement {
  parentTaskId: string;
  depth: number;
}

/** Status patches are explicit nulls: "clear the error" is a real instruction. */
export interface TaskStatusPatch {
  startedAt?: number;
  finishedAt?: number | null;
  error?: string | null;
  /** 这次停下是哪一类（§3.7）；`null` = 没有失败，或者旧任务没分类。 */
  errorKind?: TaskFailureKind | null;
}

type Reviewer = 'auto' | 'system' | 'user';

interface TaskRow {
  id: string;
  title: string;
  brief: string;
  deliverable_spec: string;
  owner_id: string;
  owner_name: string;
  parent_task_id: string | null;
  project_group_id: string | null;
  thread_id: string | null;
  worker_id: string | null;
  review_of_task_id: string | null;
  issue_key: string | null;
  priority: string | null;
  labels: string | null;
  /** JSON `TaskSteering[]`: 你中途改的方向（V32）。 */
  steering: string | null;
  due_at: number | null;
  is_review: number;
  depth: number;
  est_tokens: number;
  acceptance_command: string;
  acceptance_template: string;
  status: string;
  workspace_rel_path: string;
  attempts: number;
  tokens_used: number;
  cost_usd: number;
  error: string | null;
  error_kind: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
  child_count: number;
}

/**
 * Where a task's files live, relative to `paths.workspaceDir`.
 *
 * Derived from the id instead of stored at creation time so a resumed task always
 * looks in the same place — the id is the only stable part.
 */
export function taskWorkspaceRelPath(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `tasks/${safe}`;
}

/**
 * Tasks as the app's work ledger: business state only.
 *
 * The execution state (checkpoints, transcript) belongs to the employee's
 * pi-durable database (§P2); this class never writes there and the runtime never
 * writes here. They meet at `task.id` and `task.durable_task_id`.
 */
export class TaskRepository {
  private readonly statements = new Map<string, PreparedStatement>();

  constructor(private readonly db: CompanyDatabase) {}

  /**
   * `OPC-12`：工单号的序号。
   *
   * 前缀以前取自部门代码（"活儿归哪儿"）。组织没了，前缀固定成 `OPC`——单机只有
   * 一个工作台，用不着靠前缀区分归属；序号仍然在 insert 的同一个写里取，
   * 两个任务拿不到同一个号。
   */
  private nextIssueKey(): string {
    const prefix = 'OPC';
    const last = this.statement(
      "SELECT issue_key FROM task WHERE issue_key LIKE ? ORDER BY LENGTH(issue_key) DESC, issue_key DESC LIMIT 1",
    ).get(`${prefix}-%`) as { issue_key: string } | undefined;
    const lastSeq = last ? Number(last.issue_key.split('-').pop()) || 0 : 0;
    return `${prefix}-${lastSeq + 1}`;
  }

  /** Blockers of one task, with the fields an issue row needs to explain itself. */
  private linksOf(taskId: string): IssueLink[] {
    return this.db
      .prepare(
        `SELECT t.id, t.issue_key, t.title, t.status
           FROM task_link l JOIN task t ON t.id = l.from_task_id
          WHERE l.to_task_id = ? AND l.type = 'blocks'
          ORDER BY t.created_at`,
      )
      .all(taskId)
      .map((raw) => {
        const row = raw as { id: string; issue_key: string | null; title: string; status: TaskStatus };
        return {
          taskId: row.id,
          issueKey: row.issue_key ?? undefined,
          title: row.title,
          status: row.status,
        };
      });
  }

  /** Links are directional: `fromId blocks toId`. */
  link = (fromId: string, toId: string, type: LinkType = 'blocks'): void => {
    if (fromId === toId) throw new Error('不能把任务连到自己');
    const exists = (id: string) => Boolean(this.db.prepare('SELECT id FROM task WHERE id = ?').get(id));
    if (!exists(fromId) || !exists(toId)) throw new Error('任务不存在');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_link (id, from_task_id, to_task_id, type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`link-${crypto.randomUUID()}`, fromId, toId, type, Date.now());
  };

  unlink = (fromId: string, toId: string, type: LinkType = 'blocks'): void => {
    this.db
      .prepare('DELETE FROM task_link WHERE from_task_id = ? AND to_task_id = ? AND type = ?')
      .run(fromId, toId, type);
  };

  /** A blocker only blocks while it is unfinished. */
  isBlocked = (taskId: string): boolean =>
    this.linksOf(taskId).some((link) => link.status !== 'accepted' && link.status !== 'delivered');

  /** Priority / labels / due date: the fields you edits after dispatch. */
  setIssueMeta = (
    taskId: string,
    patch: { priority?: WorkTask['priority']; labels?: string[]; dueAt?: number | null },
  ): void => {
    const current = this.db
      .prepare('SELECT priority, labels, due_at FROM task WHERE id = ?')
      .get(taskId) as { priority: string; labels: string; due_at: number | null } | undefined;
    if (!current) throw new Error('任务不存在');

    this.db
      .prepare('UPDATE task SET priority = ?, labels = ?, due_at = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.priority ?? current.priority,
        JSON.stringify(patch.labels ?? (JSON.parse(current.labels || '[]') as string[])),
        patch.dueAt === undefined ? current.due_at : patch.dueAt,
        Date.now(),
        taskId,
      );
  };

  /** One-time backfill for rows that predate keys; idempotent. */
  ensureIssueKeys = (): number => {
    const rows = this.db
      .prepare('SELECT id, owner_id FROM task WHERE issue_key IS NULL ORDER BY created_at')
      .all() as { id: string; owner_id: string }[];
    if (rows.length === 0) return 0;

    const update = this.db.prepare('UPDATE task SET issue_key = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const row of rows) update.run(this.nextIssueKey(), row.id);
    })();
    return rows.length;
  };

  createTask = (
    draft: CreateTaskDraft,
    workspaceRelPath: string,
    taskId: string,
    placement?: TaskTreePlacement,
  ): WorkTask => {
    // 谁来干：现在是一个执行体，不是一个人。名字随执行体一起记下来，
    // 卡片在 worker 被退休之后仍然能渲染（denormalised on purpose）。
    const owner = this.statement('SELECT id, name FROM worker WHERE id = ?').get(draft.assigneeId) as
      | { id: string; name: string }
      | undefined;
    if (!owner) throw new Error(`执行体不存在：${draft.assigneeId}`);

    const now = Date.now();
    this.statement(
      `INSERT INTO task (id, title, brief, deliverable_spec, owner_id, owner_name,
                         parent_task_id, thread_id, worker_id, review_of_task_id, is_review, depth, est_tokens,
                         acceptance_command, acceptance_template, status, workspace_rel_path,
                         attempts, tokens_used, cost_usd, issue_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, 'open', ?, 0, 0, 0, ?, ?, ?)`,
    ).run(
      taskId,
      draft.title,
      draft.brief,
      draft.deliverableSpec,
      owner.id,
      owner.name,
      placement?.parentTaskId ?? null,
      draft.threadId ?? null,
      draft.workerId ?? null,
      placement?.depth ?? 0,
      draft.estTokens,
      JSON.stringify(draft.acceptanceCommand),
      draft.acceptanceTemplate,
      workspaceRelPath,
      this.nextIssueKey(),
      now,
      now,
    );

    return this.getTask(taskId) as WorkTask;
  };

  /**
   * The most recent task on a line of work.
   *
   * When you approves or asks for a rework from the attention queue, the
   * newest task is the one they are looking at — the thread's earlier tasks are
   * history, and a rework created a new one rather than reopening the old.
   */
  latestForThread = (threadId: string): WorkTask | undefined => {
    const row = this.statement(
      'SELECT id FROM task WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(threadId) as { id: string } | undefined;
    return row ? this.getTask(row.id) : undefined;
  };

  getTask = (taskId: string): WorkTask | undefined => {
    const row = this.statement(
      `SELECT t.*,
              (SELECT COUNT(*) FROM task c WHERE c.parent_task_id = t.id) AS child_count
         FROM task t WHERE t.id = ?`,
    ).get(taskId) as TaskRow | undefined;
    if (!row) return undefined;

    const artifacts = this.statement(
      'SELECT id, rel_path, bytes, sha256 FROM artifact WHERE task_id = ? ORDER BY rel_path',
    ).all(row.id) as { id: string; rel_path: string; bytes: number; sha256: string }[];

    const acceptance = this.statement(
      `SELECT verdict, reason, evidence, created_at FROM acceptance
        WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(row.id) as
      | { verdict: string; reason: string; evidence: string; created_at: number }
      | undefined;

    const steps = this.statement('SELECT at, text FROM task_step WHERE task_id = ? ORDER BY rowid').all(
      row.id,
    ) as { at: number; text: string }[];

    // 一行坏 JSON 不该让整张任务卡读不出来：丢掉坏的，留下好的。
    const steering = parseJson<TaskSteering[]>(row.steering ?? '[]', []).filter(
      (entry): entry is TaskSteering => typeof entry?.note === 'string',
    );

    /** 库里的字符串只认那七个；手改坏的、将来删掉的，一律当"没分类"。 */
    const errorKind = isFailureKind(row.error_kind) ? row.error_kind : undefined;

    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      deliverableSpec: row.deliverable_spec,
      assigneeId: row.owner_id,
      assigneeName: row.owner_name,
      issueKey: row.issue_key ?? undefined,
      priority: (row.priority as WorkTask['priority']) ?? 'P2',
      blockedBy: this.linksOf(row.id),
      labels: JSON.parse(row.labels || '[]') as string[],
      // 只有真有话说时才带上这个字段：空数组会让"没人改过方向"和"改过又撤回"分开。
      ...(steering.length > 0 ? { steering } : {}),
      dueAt: row.due_at ?? undefined,
      parentTaskId: row.parent_task_id ?? undefined,
      projectGroupId: row.project_group_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      workerId: row.worker_id ?? undefined,
      reviewOfTaskId: row.review_of_task_id ?? undefined,
      isReview: row.is_review === 1,
      depth: row.depth,
      childCount: row.child_count,
      estTokens: row.est_tokens,
      acceptanceCommand: parseJson<string[]>(row.acceptance_command, []),
      acceptanceTemplate: row.acceptance_template as AcceptanceTemplate,
      status: row.status as TaskStatus,
      workspaceRelPath: row.workspace_rel_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        relPath: artifact.rel_path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })),
      ...(acceptance
        ? {
            acceptance: {
              verdict: acceptance.verdict as TaskAcceptance['verdict'],
              reason: acceptance.reason,
              evidence: parseJson<TaskAcceptance['evidence']>(acceptance.evidence, {
                command: [],
                exitCode: null,
                stdoutTail: '',
                stderrTail: '',
                durationMs: 0,
              }),
              createdAt: acceptance.created_at,
            },
          }
        : {}),
      attempts: row.attempts,
      tokensUsed: row.tokens_used,
      costUsd: row.cost_usd,
      ...(row.error ? { error: row.error } : {}),
      ...(errorKind ? { errorKind } : {}),
      steps: steps.map((step) => ({ at: step.at, text: step.text })),
    };
  };

  listTasks = (limit = 20): WorkTask[] =>
    this.selectIds(`SELECT id FROM task ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`);

  /** 一条工作线上的任务，最新在前。链式召回从这里往下跳（§3.3）。 */
  listByThread = (threadId: string, limit = 5): WorkTask[] =>
    this.selectIds(
      `SELECT id FROM task WHERE thread_id = ? ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`,
      threadId,
    );

  listChildren = (taskId: string): WorkTask[] =>
    this.selectIds('SELECT id FROM task WHERE parent_task_id = ? ORDER BY created_at', taskId);

  /** Sign-off tasks filed against this one; the count is the rework round counter. */
  listReviews = (taskId: string): WorkTask[] =>
    this.selectIds('SELECT id FROM task WHERE review_of_task_id = ? ORDER BY created_at', taskId);

  /** Running work, oldest activity first: these are the crash-recovery candidates. */
  listRunning = (): WorkTask[] =>
    this.selectIds("SELECT id FROM task WHERE status = 'running' ORDER BY updated_at");

  /** Non-terminal work: what a restarted process must reconcile (§2.4 step 3c). */
  listPending = (): WorkTask[] =>
    this.selectIds("SELECT id FROM task WHERE status IN ('open','running') ORDER BY created_at");

  setStatus = (taskId: string, status: TaskStatus, patch: TaskStatusPatch = {}): void => {
    const assignments = ['status = ?', 'updated_at = ?'];
    const values: (string | number | null)[] = [status, Date.now()];

    if (patch.startedAt !== undefined) {
      assignments.push('started_at = ?');
      values.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      assignments.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (patch.error !== undefined) {
      assignments.push('error = ?');
      values.push(patch.error);
    }
    if (patch.errorKind !== undefined) {
      assignments.push('error_kind = ?');
      values.push(patch.errorKind);
    }

    values.push(taskId);
    this.statement(`UPDATE task SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  };

  addStep = (taskId: string, text: string): void => {
    const now = Date.now();
    this.statement('INSERT INTO task_step (id, task_id, at, text) VALUES (?, ?, ?, ?)').run(
      `step-${crypto.randomUUID()}`,
      taskId,
      now,
      text,
    );
    this.touch(taskId, now);
  };

  // ── trace：过程档（W6）──────────────────────────────────────────────────

  /**
   * 记一个**动作**。
   *
   * 和 `addStep` 的分工是给谁看：这个给界面、Watchdog、复盘看，`step` 是写给人读的叙述。
   * 裁剪**不在这里**做——留多少条是策略（`work/trace.ts`），仓储只管读写。
   */
  appendTrace = (input: {
    taskId: string;
    seq: number;
    kind: TaskTraceKind;
    name: string;
    argsDigest?: string;
    ok?: boolean | null;
    ms?: number;
    tokens?: number;
    at?: number;
  }): TaskTrace => {
    const at = input.at ?? Date.now();
    const row: TaskTrace = {
      id: `trace-${crypto.randomUUID()}`,
      taskId: input.taskId,
      seq: input.seq,
      at,
      kind: input.kind,
      name: input.name,
      argsDigest: input.argsDigest ?? '',
      ok: input.ok === undefined ? null : input.ok,
      ...(input.ms === undefined ? {} : { ms: input.ms }),
      ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
    };
    this.statement(
      `INSERT INTO task_trace (id, task_id, seq, at, kind, name, args_digest, ok, ms, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.taskId,
      row.seq,
      row.at,
      row.kind,
      row.name,
      row.argsDigest,
      row.ok === null ? null : row.ok ? 1 : 0,
      row.ms ?? null,
      row.tokens ?? null,
    );
    this.touch(input.taskId, at);
    return row;
  };

  /** 最近的 N 个动作，按发生顺序（旧 → 新）。 */
  listTrace = (taskId: string, limit = 20): TaskTrace[] => {
    const rows = this.statement(
      'SELECT * FROM task_trace WHERE task_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(taskId, limit) as TraceRow[];
    return rows.reverse().map(toTrace);
  };

  /** 下一个序号从库里续，所以重试/续跑不会把 seq 从头开始。 */
  maxTraceSeq = (taskId: string): number => {
    const row = this.statement('SELECT MAX(seq) AS seq FROM task_trace WHERE task_id = ?').get(
      taskId,
    ) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  };

  /**
   * 只留头 `head` 条与尾 `tail` 条，中间删掉。
   *
   * 返回**删掉的条数**：用例和探针靠它证明裁剪真的发生了，而不是靠读代码相信。
   * 删掉的那一段在 `seq` 上留空洞，读的人据此说「略去 N 步」。
   */
  pruneTrace = (taskId: string, head: number, tail: number): number => {
    const max = this.maxTraceSeq(taskId);
    const cutoff = max - tail;
    if (cutoff <= head) return 0;
    const info = this.statement(
      'DELETE FROM task_trace WHERE task_id = ? AND seq > ? AND seq <= ?',
    ).run(taskId, head, cutoff) as { changes?: number } | undefined;
    return info?.changes ?? 0;
  };

  /**
   * 你中途改的方向，追加在任务上。
   *
   * 追加而不是覆盖：一段活的中间可能被改两次方向，两次都是真的发生过的事；只有
   * 需要"当前口径"的地方（提示词）才把它整体按顺序读出来。
   */
  addSteering = (taskId: string, note: string): TaskSteering[] => {
    const text = note.trim();
    if (!text) return [];
    const row = this.statement('SELECT steering FROM task WHERE id = ?').get(taskId) as
      | { steering: string | null }
      | undefined;
    if (!row) throw new Error(`任务不存在：${taskId}`);

    const next = [...parseJson<TaskSteering[]>(row.steering ?? '[]', []), { note: text, at: Date.now() }];
    this.statement('UPDATE task SET steering = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(next),
      Date.now(),
      taskId,
    );
    return next;
  };

  addAcceptance = (
    taskId: string,
    acceptance: Omit<TaskAcceptance, 'createdAt'>,
    reviewer: Reviewer = 'auto',
  ): void => {
    const now = Date.now();
    this.statement(
      `INSERT INTO acceptance (id, task_id, verdict, reason, evidence, reviewer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `acc-${crypto.randomUUID()}`,
      taskId,
      acceptance.verdict,
      acceptance.reason,
      JSON.stringify(acceptance.evidence),
      reviewer,
      now,
    );
    // One row per attempt: the count is "how many times the system had to check".
    this.statement('UPDATE task SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(
      now,
      taskId,
    );
  };

  /** Re-keys a freshly created task as the manager sign-off of `originalTaskId`. */
  markAsReview = (reviewTaskId: string, originalTaskId: string): void => {
    this.statement(
      'UPDATE task SET is_review = 1, review_of_task_id = ?, updated_at = ? WHERE id = ?',
    ).run(originalTaskId, Date.now(), reviewTaskId);
  };

  setDurableTaskId = (taskId: string, durableTaskId: string): void => {
    this.statement('UPDATE task SET durable_task_id = ?, updated_at = ? WHERE id = ?').run(
      durableTaskId,
      Date.now(),
      taskId,
    );
  };

  getDurableTaskId = (taskId: string): string | undefined => {
    const row = this.statement('SELECT durable_task_id FROM task WHERE id = ?').get(taskId) as
      | { durable_task_id: string | null }
      | undefined;
    return row?.durable_task_id ?? undefined;
  };

  addTokens = (taskId: string, tokens: number): void => {
    if (!Number.isFinite(tokens) || tokens === 0) return;
    this.statement('UPDATE task SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?').run(
      Math.max(0, Math.round(tokens)),
      Date.now(),
      taskId,
    );
  };

  addCost = (taskId: string, costUsd: number): void => {
    if (!Number.isFinite(costUsd) || costUsd === 0) return;
    this.statement('UPDATE task SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(
      Math.max(0, costUsd),
      Date.now(),
      taskId,
    );
  };

  /** The deliverable list is rebuilt from the workspace on every verify pass. */
  clearArtifacts = (taskId: string): void => {
    this.statement('DELETE FROM artifact WHERE task_id = ?').run(taskId);
  };

  addArtifact = (taskId: string, relPath: string, absolutePath: string): void => {
    const bytes = readFileSync(absolutePath);
    this.statement(
      `INSERT INTO artifact (id, task_id, rel_path, bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, rel_path) DO UPDATE SET
         bytes = excluded.bytes, sha256 = excluded.sha256`,
    ).run(
      `art-${crypto.randomUUID()}`,
      taskId,
      relPath,
      bytes.byteLength,
      crypto.createHash('sha256').update(bytes).digest('hex'),
      Date.now(),
    );
  };

  private selectIds(sql: string, ...params: unknown[]): WorkTask[] {
    const rows = this.statement(sql).all(...params) as { id: string }[];
    // Explicitly sequential: better-sqlite3 can only run one statement at a time, and
    // a nested re-entrant prepare inside an iteration is exactly how that breaks.
    const tasks: WorkTask[] = [];
    for (const row of rows) {
      const task = this.getTask(row.id);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  private touch(taskId: string, now: number): void {
    this.statement('UPDATE task SET updated_at = ? WHERE id = ?').run(now, taskId);
  }

  private statement(sql: string): PreparedStatement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }
}

interface TraceRow {
  id: string;
  task_id: string;
  seq: number;
  at: number;
  kind: TaskTraceKind;
  name: string;
  args_digest: string;
  ok: number;
  ms: number | null;
  tokens: number | null;
}

function toTrace(row: TraceRow): TaskTrace {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    name: row.name,
    argsDigest: row.args_digest,
    ok: row.ok === null ? null : row.ok === 1,
    ...(row.ms === null ? {} : { ms: row.ms }),
    ...(row.tokens === null ? {} : { tokens: row.tokens }),
  };
}

const FAILURE_KINDS: readonly TaskFailureKind[] = [
  'retryable',
  'rejected',
  'unverified',
  'needs_decision',
  'handed_back',
  'blocked',
  'cancelled',
];

/** 库里的字符串只认这七个；手改坏的、将来删掉的，一律当"没分类"。 */
function isFailureKind(value: string | null): value is TaskFailureKind {
  return value !== null && (FAILURE_KINDS as readonly string[]).includes(value);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
