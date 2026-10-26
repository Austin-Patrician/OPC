import type {
  Agent,
  AcceptanceTemplate,
  TaskAcceptance,
  TaskStatus,
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
}

type Reviewer = 'auto' | 'manager' | 'boss';

interface TaskRow {
  id: string;
  title: string;
  brief: string;
  deliverable_spec: string;
  employee_id: string;
  employee_name: string;
  parent_task_id: string | null;
  review_of_task_id: string | null;
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
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
  child_count: number;
  persona: string | null;
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
   * Idempotent employee projection: the org service owns hiring, but chat and the
   * work loop need every agent to have a row (and a budget) before they can hold a
   * task. Existing rows keep their status — a terminated employee must not come
   * back to life just because the UI asked for a chat list.
   */
  seedEmployees = (agents: readonly Agent[]): void => {
    const now = Date.now();
    const upsert = this.statement(
      `INSERT INTO employee (id, name, role, level, department_id, model, skills, persona, avatar,
                             status, hired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'active', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         level = excluded.level,
         department_id = excluded.department_id,
         model = excluded.model,
         skills = excluded.skills,
         persona = excluded.persona,
         updated_at = excluded.updated_at`,
    );

    const run = this.db.transaction(() => {
      for (const agent of agents) {
        upsert.run(
          agent.id,
          agent.name,
          agent.role,
          agent.level,
          agent.departmentId || null,
          agent.model,
          JSON.stringify(agent.skills),
          agent.briefMd || '',
          now,
          now,
          now,
        );
      }
    });
    run();
  };

  createTask = (
    draft: CreateTaskDraft,
    workspaceRelPath: string,
    taskId: string,
    placement?: TaskTreePlacement,
  ): WorkTask => {
    const assignee = this.statement(
      "SELECT id, name FROM employee WHERE id = ? AND status = 'active'",
    ).get(draft.assigneeId) as { id: string; name: string } | undefined;
    // A structured refusal beats a foreign-key error: the caller turns this into
    // ASSIGNEE_UNAVAILABLE and releases the reservation it took.
    if (!assignee) throw new Error(`员工不在岗或不存在：${draft.assigneeId}`);

    const now = Date.now();
    this.statement(
      `INSERT INTO task (id, title, brief, deliverable_spec, employee_id, employee_name,
                         parent_task_id, review_of_task_id, is_review, depth, est_tokens,
                         acceptance_command, acceptance_template, status, workspace_rel_path,
                         attempts, tokens_used, cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, 'open', ?, 0, 0, 0, ?, ?)`,
    ).run(
      taskId,
      draft.title,
      draft.brief,
      draft.deliverableSpec,
      assignee.id,
      assignee.name,
      placement?.parentTaskId ?? null,
      placement?.depth ?? 0,
      draft.estTokens,
      JSON.stringify(draft.acceptanceCommand),
      draft.acceptanceTemplate,
      workspaceRelPath,
      now,
      now,
    );

    return this.getTask(taskId) as WorkTask;
  };

  getTask = (taskId: string): WorkTask | undefined => {
    const row = this.statement(
      `SELECT t.*,
              (SELECT COUNT(*) FROM task c WHERE c.parent_task_id = t.id) AS child_count,
              (SELECT e.persona FROM employee e WHERE e.id = t.employee_id) AS persona
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

    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      deliverableSpec: row.deliverable_spec,
      assigneeId: row.employee_id,
      assigneeName: row.employee_name,
      parentTaskId: row.parent_task_id ?? undefined,
      reviewOfTaskId: row.review_of_task_id ?? undefined,
      isReview: row.is_review === 1,
      depth: row.depth,
      childCount: row.child_count,
      estTokens: row.est_tokens,
      acceptanceCommand: parseJson<string[]>(row.acceptance_command, []),
      acceptanceTemplate: row.acceptance_template as AcceptanceTemplate,
      ...(row.persona ? { persona: row.persona } : {}),
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
      steps: steps.map((step) => ({ at: step.at, text: step.text })),
    };
  };

  listTasks = (): WorkTask[] => this.selectIds('SELECT id FROM task ORDER BY created_at DESC');

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

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
