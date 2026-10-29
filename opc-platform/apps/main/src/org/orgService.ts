import crypto from 'node:crypto';
import type {
  DepartmentEditInput,
  DepartmentNode,
  EmployeeToolPolicy,
  EmploymentEvent,
  EmploymentEventKind,
  Evaluation,
  EvaluationInput,
  HireInput,
  JobEditInput,
  JobInput,
  JobNode,
  JobSeatInput,
  ModelRef,
  OrgMember,
  PersonnelInput,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { BOSS_USER_ID } from '../data/schema';
import { BudgetRepository } from '../data/budgetRepository';
import { BudgetService } from '../work/budgetService';
import { normalizeToolPolicy, parseToolPolicy } from '../work/toolPolicy';

/**
 * Organisation as data, not demo fixtures.
 *
 * `employee` holds identity and employment status; `position` holds where someone
 * sits and to whom they report. Tasks and budgets hang off the employee; the org
 * chart is a projection of those two tables.
 */
/** Distinct tag colours for departments, in the order new ones pick them up. */
export const DEPARTMENT_COLORS = [
  '#0099FF',
  '#512BD4',
  '#10B981',
  '#FF9500',
  '#FF4D4F',
  '#AF52DE',
  '#00C7BE',
  '#FF2D55',
] as const;

/** `employee.model_ref` is JSON; a malformed or empty value means "inherit". */
function parseModelRef(value: string | null | undefined): ModelRef | undefined {
  if (!value) return undefined;
  try {
    const raw = JSON.parse(value) as { providerId?: unknown; modelId?: unknown };
    return typeof raw.providerId === 'string' &&
      raw.providerId &&
      typeof raw.modelId === 'string' &&
      raw.modelId
      ? { providerId: raw.providerId, modelId: raw.modelId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Skills are tags: trim, drop empties, and keep the first spelling of a duplicate. */
function cleanSkills(value: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const raw of value ?? []) {
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push(skill);
  }
  return skills;
}

function parseSkills(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export class OrgService {
  constructor(private readonly db: CompanyDatabase) {}

  /** Every employee row, with position data when one exists. */
  private readMembers = (): OrgMember[] => {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.name, e.role, e.level, e.status, e.model, e.model_ref, e.skills, e.persona, e.avatar,
                e.tool_policy, e.hired_at, e.terminated_at, e.probation_ends_at,
                (SELECT COALESCE(SUM(t.tokens_used), 0) FROM task t WHERE t.employee_id = e.id) AS tokens_used,
                p.title, p.department_id, p.reports_to_employee_id, p.is_head, p.is_acting_head, p.job_id,
                (SELECT COUNT(*) FROM task t WHERE t.employee_id = e.id AND t.status IN ('open','running')) AS active_tasks,
                (SELECT COUNT(*) FROM task t WHERE t.employee_id = e.id AND t.status IN ('accepted','delivered')) AS tasks_done,
                (SELECT COALESCE(SUM(t.cost_usd), 0) FROM task t
                  WHERE t.employee_id = e.id AND COALESCE(t.finished_at, t.created_at) >= CAST(strftime('%s','now','start of day') AS INTEGER) * 1000) AS cost_today
         FROM employee e
         LEFT JOIN position p ON p.employee_id = e.id AND p.deleted_at IS NULL
         ORDER BY e.created_at`,
      )
      .all() as {
      id: string;
      name: string;
      role: string;
      level: string;
      status: string;
      model: string;
      model_ref: string;
      skills: string;
      persona: string;
      avatar: string;
      tool_policy: string;
      hired_at: number;
      terminated_at: number | null;
      probation_ends_at: number | null;
      tasks_done: number;
      cost_today: number;
      tokens_used: number;
      title: string | null;
      department_id: string | null;
      reports_to_employee_id: string | null;
      is_head: number | null;
      is_acting_head: number | null;
      job_id: string | null;
      active_tasks: number;
    }[];

    return rows.map((row) => {
      const modelRef = parseModelRef(row.model_ref);
      return {
        id: row.id,
        name: row.name,
        role: row.role,
        level: row.level,
        status: row.status,
        model: row.model,
        ...(modelRef ? { modelRef } : {}),
        title: row.title ?? row.role,
        departmentId: row.department_id ?? '',
        reportsToEmployeeId: row.reports_to_employee_id ?? undefined,
        ...(row.job_id ? { jobId: row.job_id } : {}),
        isHead: row.is_head === 1,
        isActingHead: row.is_acting_head === 1,
        activeTasks: row.active_tasks,
        tokensUsed: row.tokens_used,
        skills: JSON.parse(row.skills || '[]') as string[],
        persona: row.persona ?? '',
        avatar: row.avatar ?? '',
        hiredAt: row.hired_at || 0,
        ...(row.terminated_at ? { terminatedAt: row.terminated_at } : {}),
        ...(row.probation_ends_at ? { probationEndsAt: row.probation_ends_at } : {}),
        costTodayUsd: row.cost_today,
        tasksDone: row.tasks_done,
      };
    });
  };

  list = (): DepartmentNode[] => {
    const members = this.readMembers();
    const departments = this.db
      .prepare(
        `SELECT id, name, code, description, color, parent_id, sort_order
           FROM department WHERE deleted_at IS NULL
          ORDER BY sort_order, created_at, id`,
      )
      .all() as {
      id: string;
      name: string;
      code: string;
      description: string;
      color: string;
      parent_id: string | null;
      sort_order: number;
    }[];

    const byDepartment = new Map<string, OrgMember[]>();
    for (const member of members) {
      if (!member.departmentId) continue;
      const bucket = byDepartment.get(member.departmentId);
      if (bucket) bucket.push(member);
      else byDepartment.set(member.departmentId, [member]);
    }

    // No synthetic "unassigned" department: people without a position live in the
    // talent pool (`unplaced`), which is what the market page lists.
    return departments.map((department) => {
      const departmentMembers = byDepartment.get(department.id) ?? [];
      const head = departmentMembers.find((member) => member.isHead);
      const acting = departmentMembers.find((member) => member.isActingHead);
      return {
        id: department.id,
        name: department.name,
        code: department.code,
        description: department.description,
        color: department.color,
        ...(department.parent_id ? { parentId: department.parent_id } : {}),
        sortOrder: department.sort_order,
        // Derived, never stored: `position.is_head` is the single source of truth.
        // `department.head_employee_id` is kept in the schema for one release so a
        // rollback still renders, but this class neither reads nor writes it.
        headEmployeeId: head?.id,
        ...(acting ? { actingHeadEmployeeId: acting.id } : {}),
        members: departmentMembers,
      };
    });
  };

  /** Employees with no active position: alumni and anyone not yet placed. */
  unplaced = (): OrgMember[] => this.readMembers().filter((member) => member.departmentId === '');

  /**
   * Every employee row, including people whose position is gone (terminated).
   *
   * `list()` is the org chart and only shows live positions; anything that must tell
   * "left the company" apart from "never existed" — a message that will never be read
   * is not the same as an unknown id — has to look here instead.
   */
  everyone = (): OrgMember[] => this.readMembers();

  /**
   * Places an employee into a department, re-activating them when needed.
   * Used by the talent pool and by re-hiring after a termination.
   *
   * It always goes through `transfer`, so re-placing someone who still holds a seat
   * elsewhere actually moves them instead of leaving them where they were. The seat
   * title and the reporting line are recovered from the last position row by
   * `transfer` — reinstatement is not a fresh hire.
   */
  place = (employeeId: string, departmentId: string): void => {
    const now = Date.now();
    const before = this.db
      .prepare('SELECT status, terminated_at FROM employee WHERE id = ?')
      .get(employeeId) as { status: string; terminated_at: number | null } | undefined;
    if (!before) throw new Error('员工不存在');

    const current = this.livePosition(employeeId);
    if (current && current.department_id === departmentId) {
      // Already seated there: no new row, but keep the redundant column honest.
      this.db
        .prepare("UPDATE employee SET status = 'active', terminated_at = NULL, department_id = ?, updated_at = ? WHERE id = ?")
        .run(departmentId, now, employeeId);
      return;
    }

    const previousDepartment = current?.department_id ?? this.latestPosition(employeeId)?.department_id;
    const returning = before.status === 'terminated';

    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE employee SET status = 'active', terminated_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, employeeId);
      // Reinstatement records its own event, so the seat write must stay silent here;
      // a plain "put someone from the pool into a department" is a real move and is
      // recorded as one.
      this.moveSeat(employeeId, departmentId, undefined, undefined, returning ? null : 'transferred');

      // "Away since X" is the fact an HR page is asked for, and it is not derivable
      // from two seat rows: one is closed, the other says nothing about the gap.
      if (returning) {
        this.recordEvent({
          employeeId,
          kind: 'reinstated',
          from: previousDepartment ? { departmentId: previousDepartment } : {},
          to: { departmentId },
          reason: before.terminated_at
            ? `离职于 ${new Date(before.terminated_at).toISOString().slice(0, 10)}`
            : '',
          at: now,
        });
      }
    });
    tx();
  };

  /** Direct reports of one employee (org-chart edge), active only. */
  subordinatesOf = (managerId: string): OrgMember[] =>
    this.list()
      .flatMap((department) => department.members)
      .filter((member) => member.reportsToEmployeeId === managerId && member.status === 'active');

  /**
   * Demotes the current head of `departmentId`.
   *
   * Called before appointing a new one: `idx_pos_head` allows exactly one live head
   * per department, so "hire a new head" has to mean "replace", not "add".
   *
   * Every demotion is recorded: "who was head until when" is exactly the question the
   * timeline exists to answer, and `position.is_head` alone forgets it on the next hire.
   */
  private clearHead = (departmentId: string, now: number, reason = ''): void => {
    const incumbents = this.db
      .prepare(
        `SELECT employee_id, title FROM position
          WHERE department_id = ? AND is_head = 1 AND deleted_at IS NULL`,
      )
      .all(departmentId) as { employee_id: string; title: string }[];

    this.db
      .prepare(
        'UPDATE position SET is_head = 0, updated_at = ? WHERE department_id = ? AND is_head = 1 AND deleted_at IS NULL',
      )
      .run(now, departmentId);

    for (const incumbent of incumbents) {
      this.recordEvent({
        employeeId: incumbent.employee_id,
        kind: 'head_removed',
        from: { departmentId, title: incumbent.title },
        reason,
        at: now,
      });
    }
  };

  /** The live position of one employee, if any. `position` is the org authority. */
  private livePosition = (
    employeeId: string,
  ): {
    id: string;
    department_id: string;
    title: string;
    reports_to_employee_id: string | null;
    is_head: number;
    is_acting_head: number;
    job_id: string | null;
  } | undefined =>
    this.db
      .prepare(
        `SELECT id, department_id, title, reports_to_employee_id, is_head, is_acting_head, job_id
           FROM position WHERE employee_id = ? AND deleted_at IS NULL`,
      )
      .get(employeeId) as
      | {
          id: string;
          department_id: string;
          title: string;
          reports_to_employee_id: string | null;
          is_head: number;
          is_acting_head: number;
          job_id: string | null;
        }
      | undefined;

  /**
   * The most recent position row, live or closed.
   *
   * A transfer closes the old row instead of updating it, so once someone moves the
   * only surviving copy of their seat title and reporting line is that closed row.
   * `transfer` / `place` read it before writing the new seat, which is what makes
   * "transfer does not lose the title" and "reinstatement restores the manager" true.
   */
  private latestPosition = (
    employeeId: string,
  ): {
    department_id: string;
    title: string;
    reports_to_employee_id: string | null;
    job_id: string | null;
  } | undefined =>
    this.db
      .prepare(
        `SELECT department_id, title, reports_to_employee_id, job_id FROM position
          WHERE employee_id = ?
          ORDER BY (deleted_at IS NULL) DESC, created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(employeeId) as
      | { department_id: string; title: string; reports_to_employee_id: string | null; job_id: string | null }
      | undefined;

  /** Where the person sat last (live seat first). Reinstatement needs a department. */
  private lastDepartment = (employeeId: string): string | undefined => {
    const seat = this.latestPosition(employeeId);
    if (seat) return seat.department_id;
    return (
      this.db.prepare('SELECT department_id FROM employee WHERE id = ?').get(employeeId) as
        | { department_id: string | null }
        | undefined
    )?.department_id ?? undefined;
  };

  /**
   * A reporting line that can survive a move: it is dropped only when the manager is
   * no longer employed, because `subordinatesOf` would never count them again.
   */
  private survivingManager = (employeeId: string, managerId: string | null): string | null => {
    if (!managerId || managerId === employeeId) return null;
    return this.isActive(managerId) ? managerId : null;
  };

  /**
   * Appends one row to the employment timeline.
   *
   * Called from inside the same transaction as the change it describes, so the two
   * cannot disagree: a transfer that rolls back leaves no "transferred" event behind.
   * Events are never updated or deleted — the timeline is the audit trail.
   */
  private recordEvent = (input: {
    employeeId: string;
    kind: EmploymentEventKind;
    from?: { departmentId?: string | null; title?: string | null; level?: string | null };
    to?: { departmentId?: string | null; title?: string | null; level?: string | null };
    actor?: string;
    reason?: string;
    at?: number;
  }): void => {
    const now = input.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO employment_event
           (id, employee_id, kind, from_department_id, to_department_id,
            from_title, to_title, from_level, to_level, actor, reason, at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `event-${crypto.randomUUID()}`,
        input.employeeId,
        input.kind,
        input.from?.departmentId ?? null,
        input.to?.departmentId ?? null,
        input.from?.title ?? null,
        input.to?.title ?? null,
        input.from?.level ?? null,
        input.to?.level ?? null,
        input.actor ?? BOSS_USER_ID,
        input.reason ?? '',
        now,
        now,
      );
  };

  /** One employee's timeline, newest first. */
  events = (employeeId: string, limit = 100): EmploymentEvent[] => {
    const rows = this.db
      .prepare(
        `SELECT id, employee_id, kind, from_department_id, to_department_id,
                from_title, to_title, from_level, to_level, actor, reason, at
           FROM employment_event WHERE employee_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(employeeId, limit) as {
      id: string;
      employee_id: string;
      kind: EmploymentEventKind;
      from_department_id: string | null;
      to_department_id: string | null;
      from_title: string | null;
      to_title: string | null;
      from_level: string | null;
      to_level: string | null;
      actor: string;
      reason: string;
      at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      kind: row.kind,
      ...(row.from_department_id ? { fromDepartmentId: row.from_department_id } : {}),
      ...(row.to_department_id ? { toDepartmentId: row.to_department_id } : {}),
      ...(row.from_title ? { fromTitle: row.from_title } : {}),
      ...(row.to_title ? { toTitle: row.to_title } : {}),
      ...(row.from_level ? { fromLevel: row.from_level } : {}),
      ...(row.to_level ? { toLevel: row.to_level } : {}),
      actor: row.actor,
      reason: row.reason,
      at: row.at,
    }));
  };

  // ── 职务（全局）与部门编制 ────────────────────────────────────────────────

  /**
   * The company-wide job catalogue.
   *
   * `filled` / `headcount` are totals; the per-department plan is in `seats`. Passing a
   * department filters to the jobs that department either planned or already uses, which
   * is what its dossier needs.
   */
  private readJobs = (departmentId?: string): JobNode[] => {
    const rows = this.db
      .prepare(
        `SELECT j.id, j.title, j.level, j.description, j.skills, j.model, j.model_ref,
                (SELECT COUNT(*) FROM position p
                  WHERE p.job_id = j.id AND p.deleted_at IS NULL) AS filled
           FROM job j
          WHERE j.deleted_at IS NULL ${
            departmentId
              ? `AND (EXISTS (SELECT 1 FROM department_job dj
                               WHERE dj.job_id = j.id AND dj.department_id = ?)
                    OR EXISTS (SELECT 1 FROM position p
                                WHERE p.job_id = j.id AND p.department_id = ? AND p.deleted_at IS NULL))`
              : ''
          }
          ORDER BY j.created_at, j.id`,
      )
      .all(...(departmentId ? [departmentId, departmentId] : [])) as {
      id: string;
      title: string;
      level: string;
      description: string;
      skills: string;
      model: string;
      model_ref: string;
      filled: number;
    }[];

    const seats = this.db
      .prepare(
        `SELECT dj.department_id, d.name AS department_name, dj.job_id, dj.headcount,
                (SELECT COUNT(*) FROM position p
                  WHERE p.job_id = dj.job_id AND p.department_id = dj.department_id
                    AND p.deleted_at IS NULL) AS filled
           FROM department_job dj
           JOIN department d ON d.id = dj.department_id AND d.deleted_at IS NULL
          ORDER BY d.sort_order, d.created_at, d.id`,
      )
      .all() as {
      department_id: string;
      department_name: string;
      job_id: string;
      headcount: number;
      filled: number;
    }[];

    return rows.map((row) => {
      const modelRef = parseModelRef(row.model_ref);
      const own = seats.filter((seat) => seat.job_id === row.id);
      return {
        id: row.id,
        title: row.title,
        level: row.level,
        description: row.description,
        skills: parseSkills(row.skills),
        model: row.model,
        ...(modelRef ? { modelRef } : {}),
        filled: row.filled,
        headcount: own.reduce((sum, seat) => sum + seat.headcount, 0),
        seats: own.map((seat) => ({
          departmentId: seat.department_id,
          departmentName: seat.department_name,
          headcount: seat.headcount,
          filled: seat.filled,
        })),
      };
    });
  };

  /** Every job, or the ones one department plans / uses. */
  jobs = (departmentId?: string): JobNode[] => this.readJobs(departmentId);

  createJob = (input: JobInput): JobNode => {
    const title = input.title.trim();
    if (!title) throw new Error('岗位名称不能为空');

    const clash = this.db
      .prepare(
        'SELECT id FROM job WHERE deleted_at IS NULL AND LOWER(TRIM(title)) = LOWER(?)',
      )
      .get(title);
    if (clash) throw new Error(`公司里已有岗位：${title}`);

    const now = Date.now();
    const id = `job-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO job (id, title, level, description, skills, model, model_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        input.level ?? 'P5',
        (input.description ?? '').trim(),
        JSON.stringify(cleanSkills(input.skills)),
        (input.model ?? '').trim(),
        input.modelRef ? JSON.stringify(input.modelRef) : '',
        now,
        now,
      );

    return this.readJobs().find((job) => job.id === id) as JobNode;
  };

  /**
   * Changes a job definition: title / level / responsibilities / defaults.
   *
   * Editing it does **not** rewrite people already in the seat: skills and model are
   * copies taken at hire time, because someone may have spent time tuning their own
   * stack. Responsibilities are the exception and are read live (see `taskRepository`).
   *
   * Headcount is not here — it belongs to a department, see `setJobSeat`.
   */
  updateJob = (input: JobEditInput): JobNode => {
    const current = this.db
      .prepare('SELECT id, title, skills, model, model_ref FROM job WHERE id = ? AND deleted_at IS NULL')
      .get(input.id) as
      | { id: string; title: string; skills: string; model: string; model_ref: string }
      | undefined;
    if (!current) throw new Error('岗位不存在');

    const title = input.title === undefined ? current.title : input.title.trim();
    if (!title) throw new Error('岗位名称不能为空');
    if (title !== current.title) {
      const clash = this.db
        .prepare(
          `SELECT id FROM job WHERE deleted_at IS NULL AND LOWER(TRIM(title)) = LOWER(?) AND id <> ?`,
        )
        .get(title, input.id);
      if (clash) throw new Error(`公司里已有岗位：${title}`);
    }

    this.db
      .prepare(
        `UPDATE job SET title = ?, level = COALESCE(?, level),
                        description = COALESCE(?, description),
                        skills = COALESCE(?, skills), model = COALESCE(?, model),
                        model_ref = COALESCE(?, model_ref), updated_at = ?
          WHERE id = ?`,
      )
      .run(
        title,
        input.level ?? null,
        input.description === undefined ? null : input.description.trim(),
        input.skills === undefined ? null : JSON.stringify(cleanSkills(input.skills)),
        input.model === undefined ? null : input.model.trim(),
        // tri-state: undefined keeps, null clears to "inherit the company default".
        input.modelRef === undefined
          ? null
          : input.modelRef
            ? JSON.stringify(input.modelRef)
            : '',
        Date.now(),
        input.id,
      );

    return this.readJobs().find((job) => job.id === input.id) as JobNode;
  };

  /** Soft-deletes a job; refused while someone still sits in it. */
  archiveJob = (jobId: string): void => {
    const job = this.db
      .prepare('SELECT id, title FROM job WHERE id = ? AND deleted_at IS NULL')
      .get(jobId) as { id: string; title: string } | undefined;
    if (!job) throw new Error('岗位不存在');

    const filled = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM position WHERE job_id = ? AND deleted_at IS NULL')
        .get(jobId) as { n: number }
    ).n;
    if (filled > 0) throw new Error(`「${job.title}」还有 ${filled} 人在岗，请先调岗`);

    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM department_job WHERE job_id = ?').run(jobId);
      this.db
        .prepare('UPDATE job SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, jobId);
    })();
  };

  /**
   * Sets one department's headcount for one job.
   *
   * This is the only place "how many do we want" is written; the job itself stays a
   * company-wide definition. Lowering it below the people already sitting there is
   * refused — move someone first, that is a decision, not a rounding error.
   */
  setJobSeat = (input: JobSeatInput): JobNode => {
    const job = this.db
      .prepare('SELECT id, title FROM job WHERE id = ? AND deleted_at IS NULL')
      .get(input.jobId) as { id: string; title: string } | undefined;
    if (!job) throw new Error('岗位不存在');
    this.liveDepartment(input.departmentId);

    if (!Number.isInteger(input.headcount) || input.headcount < 0) {
      throw new Error('编制必须是非负整数');
    }

    const filled = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM position
            WHERE job_id = ? AND department_id = ? AND deleted_at IS NULL`,
        )
        .get(input.jobId, input.departmentId) as { n: number }
    ).n;
    if (input.headcount < filled) {
      throw new Error(`编制不能小于在岗人数（当前 ${filled} 人），请先调岗`);
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO department_job (department_id, job_id, headcount, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(department_id, job_id)
         DO UPDATE SET headcount = excluded.headcount, updated_at = excluded.updated_at`,
      )
      .run(input.departmentId, input.jobId, input.headcount, now, now);

    return this.readJobs().find((entry) => entry.id === input.jobId) as JobNode;
  };

  /**
   * Explicitly push a job's skills / model onto the people already in it.
   *
   * `updateJob` never rewrites live employees, so applying a change to the current
   * occupants is a separate, deliberate call. Responsibilities are not copied; they
   * are read live from the job at task time.
   */
  syncJob = (jobId: string): number => {
    const job = this.db
      .prepare('SELECT id, skills, model, model_ref FROM job WHERE id = ? AND deleted_at IS NULL')
      .get(jobId) as
      | { id: string; skills: string; model: string; model_ref: string }
      | undefined;
    if (!job) throw new Error('岗位不存在');

    const occupants = this.db
      .prepare('SELECT employee_id FROM position WHERE job_id = ? AND deleted_at IS NULL')
      .all(jobId) as { employee_id: string }[];
    if (occupants.length === 0) return 0;

    const now = Date.now();
    const update = this.db.prepare(
      'UPDATE employee SET skills = ?, model = ?, model_ref = ?, updated_at = ? WHERE id = ?',
    );
    this.db.transaction(() => {
      for (const row of occupants) {
        update.run(job.skills, job.model, job.model_ref, now, row.employee_id);
      }
    })();
    return occupants.length;
  };

  /**
   * Resolves the job a seat fills, and enforces that department's cap.
   *
   * Returns `null` when the caller did not name one. A job with no `department_job`
   * row in this department has no cap: the department simply has not planned for it,
   * and the dossier reports the hire as 计划外.
   *
   * `occupantId` is the person being seated. Their own current seat is excluded from
   * the count, otherwise re-seating someone inside the same department ("keep the flag"
   * transfers, department-head appointment) would report the job as full of themselves.
   */
  private resolveJob = (
    jobId: string | undefined,
    departmentId: string,
    occupantId?: string,
  ): {
    id: string;
    title: string;
    level: string;
    skills: string[];
    model: string;
    modelRef?: ModelRef;
  } | null => {
    if (!jobId) return null;
    const job = this.db
      .prepare(
        `SELECT id, title, level, skills, model, model_ref FROM job WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(jobId) as
      | {
          id: string;
          title: string;
          level: string;
          skills: string;
          model: string;
          model_ref: string;
        }
      | undefined;
    if (!job) throw new Error('岗位不存在或已撤销');

    const seat = this.db
      .prepare('SELECT headcount FROM department_job WHERE department_id = ? AND job_id = ?')
      .get(departmentId, job.id) as { headcount: number } | undefined;

    if (seat) {
      const filled = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM position
              WHERE job_id = ? AND department_id = ? AND deleted_at IS NULL
                AND (? IS NULL OR employee_id <> ?)`,
          )
          .get(job.id, departmentId, occupantId ?? null, occupantId ?? null) as { n: number }
      ).n;
      if (filled >= seat.headcount) {
        throw new Error(`「${job.title}」编制已满（${filled}/${seat.headcount}）`);
      }
    }

    const modelRef = parseModelRef(job.model_ref);
    return {
      id: job.id,
      title: job.title,
      level: job.level,
      skills: parseSkills(job.skills),
      model: job.model,
      ...(modelRef ? { modelRef } : {}),
    };
  };

  private isActive = (employeeId: string): boolean =>
    this.db
      .prepare("SELECT 1 AS ok FROM employee WHERE id = ? AND status = 'active'")
      .get(employeeId) !== undefined;

  /**
   * A reporting line is a permission edge, not a drawing: `subordinatesOf` decides
   * who gets the decompose tool. So the target must be an active employee, and the
   * new edge must not close a loop (A→B→A makes both of them managers).
   */
  private assertManager = (employeeId: string, managerId: string | null): void => {
    if (!managerId) return;
    if (managerId === employeeId) throw new Error('不能把自己设为汇报对象');
    if (!this.isActive(managerId)) throw new Error('汇报对象不在岗');

    const seen = new Set<string>();
    let cursor: string | null = managerId;
    while (cursor) {
      if (cursor === employeeId) throw new Error('汇报线不能成环');
      // A pre-existing loop elsewhere in the chain cannot be fixed here; stop rather
      // than spin. This write is still safe: it adds an edge to a chain that already
      // had a cycle, it does not create one through `employeeId`.
      if (seen.has(cursor)) return;
      seen.add(cursor);
      cursor = this.livePosition(cursor)?.reports_to_employee_id ?? null;
    }
  };

  /**
   * Repairs legacy rows that share a colour (older builds hard-coded one blue).
   * Runs at startup and is idempotent: the first holder keeps its colour.
   */
  ensureDistinctColors = (): void => {
    const rows = this.db
      .prepare('SELECT id, color FROM department WHERE deleted_at IS NULL ORDER BY created_at')
      .all() as { id: string; color: string }[];
    const seen = new Set<string>();
    const update = this.db.prepare('UPDATE department SET color = ?, updated_at = ? WHERE id = ?');

    for (const row of rows) {
      const key = row.color.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      const free = DEPARTMENT_COLORS.find((candidate) => !seen.has(candidate.toUpperCase()));
      if (!free) break;
      seen.add(free.toUpperCase());
      update.run(free, Date.now(), row.id);
    }
  };

  /**
   * A department's parent must be a live department, cannot be itself, and cannot be
   * one of its own descendants — otherwise the tree becomes a loop and every renderer
   * that walks it hangs. Same reasoning as `assertManager`, one level up the chart.
   */
  private assertParent = (departmentId: string, parentId: string | null): void => {
    if (!parentId) return;
    if (parentId === departmentId) throw new Error('不能把部门挂到自己下面');
    const parent = this.db
      .prepare('SELECT id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(parentId);
    if (!parent) throw new Error('上级部门不存在');

    const seen = new Set<string>();
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === departmentId) throw new Error('部门层级不能成环');
      if (seen.has(cursor)) return;
      seen.add(cursor);
      cursor =
        (
          this.db.prepare('SELECT parent_id FROM department WHERE id = ?').get(cursor) as
            | { parent_id: string | null }
            | undefined
        )?.parent_id ?? null;
    }
  };

  /** One live department row, or a friendly error. */
  private liveDepartment = (departmentId: string): { id: string; name: string; parent_id: string | null } => {
    const row = this.db
      .prepare('SELECT id, name, parent_id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(departmentId) as { id: string; name: string; parent_id: string | null } | undefined;
    if (!row) throw new Error('部门不存在');
    return row;
  };

  /**
   * Rename / re-code / re-describe a department, or move it in the tree.
   *
   * Every field is optional so the same call backs both "rename this" and "drag this
   * under that". `parentId: null` is a deliberate move to the top level; omitting it
   * leaves the department where it is (same tri-state as `transfer`).
   */
  updateDepartment = (input: DepartmentEditInput): DepartmentNode => {
    const current = this.liveDepartment(input.id);

    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name) throw new Error('部门名称不能为空');
    if (name !== current.name) {
      const clash = this.db
        .prepare(
          'SELECT id FROM department WHERE deleted_at IS NULL AND LOWER(TRIM(name)) = LOWER(?) AND id <> ?',
        )
        .get(name, input.id);
      if (clash) throw new Error(`部门名称已存在：${name}`);
    }

    const code = input.code === undefined ? undefined : input.code.trim().toUpperCase();
    if (code) {
      const codeClash = this.db
        .prepare(
          'SELECT id FROM department WHERE deleted_at IS NULL AND UPPER(TRIM(code)) = ? AND id <> ?',
        )
        .get(code, input.id);
      if (codeClash) throw new Error(`部门代号已存在：${code}`);
    }

    if (input.parentId !== undefined) this.assertParent(input.id, input.parentId || null);

    const now = Date.now();
    const parentId = input.parentId === undefined ? current.parent_id : input.parentId || null;
    const movedParent = parentId !== current.parent_id;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE department
              SET name = ?, code = COALESCE(?, code), description = COALESCE(?, description),
                  parent_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          name,
          code ?? null,
          input.description === undefined ? null : input.description.trim(),
          parentId,
          now,
          input.id,
        );

      // `sort_order` is a position among siblings, not a number the caller invents: a
      // bare "set this to 0" would leave two departments claiming the same slot and
      // the chart would fall back to creation time. Renumber the whole row instead.
      // A department that changes parent also lands at the end of its new siblings.
      if (input.sortOrder !== undefined || movedParent) {
        this.reorderSiblings(parentId, input.id, input.sortOrder, now);
      }
    });
    tx();

    return this.list().find((department) => department.id === input.id) as DepartmentNode;
  };

  /**
   * Rewrites `sort_order` for every live sibling so the given department sits at
   * `index` (default: last). Ids come back from the DB rather than from a caller's
   * array, so a stale renderer cannot shuffle rows it cannot see.
   */
  private reorderSiblings(
    parentId: string | null,
    departmentId: string,
    index: number | undefined,
    now: number,
  ): void {
    const siblings = (
      this.db
        .prepare(
          `SELECT id FROM department
            WHERE deleted_at IS NULL AND parent_id IS ? AND id <> ?
            ORDER BY sort_order, created_at, id`,
        )
        .all(parentId, departmentId) as { id: string }[]
    ).map((row) => row.id);

    const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    siblings.splice(at, 0, departmentId);

    const update = this.db.prepare('UPDATE department SET sort_order = ?, updated_at = ? WHERE id = ?');
    siblings.forEach((id, position) => update.run(position, now, id));
  }

  /**
   * Soft-deletes a department.
   *
   * It refuses while anyone is still seated in it or it still has child departments:
   * deleting either would orphan rows that the chart cannot render — a position whose
   * department is gone disappears from the org silently, which is exactly the class of
   * bug the v11/v12 invariants were about. Move the people and the children out first.
   */
  archiveDepartment = (departmentId: string): { archived: string } => {
    const department = this.liveDepartment(departmentId);

    const seated = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM position WHERE department_id = ? AND deleted_at IS NULL')
        .get(departmentId) as { n: number }
    ).n;
    if (seated > 0) throw new Error(`「${department.name}」还有 ${seated} 名在岗员工，请先调岗`);

    const children = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM department WHERE parent_id = ? AND deleted_at IS NULL')
        .get(departmentId) as { n: number }
    ).n;
    if (children > 0) throw new Error(`「${department.name}」还有 ${children} 个下级部门，请先移出`);

    this.db
      .prepare('UPDATE department SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), departmentId);
    return { archived: departmentId };
  };

  createDepartment = (input: {
    name: string;
    code?: string;
    description?: string;
    /** Optional appointed head; the employee moves into the new department. */
    headEmployeeId?: string;
    /** Optional parent; the new department becomes a child of it. */
    parentId?: string;
  }): DepartmentNode => {
    const name = input.name.trim();
    if (!name) throw new Error('部门名称不能为空');
    // Department names are a company-wide key: duplicates make the directory
    // ambiguous and the org chart unreadable.
    const clash = this.db
      .prepare('SELECT name FROM department WHERE deleted_at IS NULL AND LOWER(TRIM(name)) = LOWER(?)')
      .get(name);
    if (clash) throw new Error(`部门名称已存在：${name}`);

    const code = (input.code ?? '').trim().toUpperCase();
    if (code) {
      const codeClash = this.db
        .prepare('SELECT code FROM department WHERE deleted_at IS NULL AND UPPER(TRIM(code)) = ?')
        .get(code);
      if (codeClash) throw new Error(`部门代号已存在：${code}`);
    }

    const now = Date.now();
    const id = `dept-${crypto.randomUUID()}`;
    // Every department gets its own tag colour: the directory, the headcount bar and
    // the cards all key off it, so identical colours would erase the distinction.
    const used = new Set(
      (
        this.db.prepare('SELECT color FROM department WHERE deleted_at IS NULL').all() as {
          color: string;
        }[]
      ).map((row) => row.color.toUpperCase()),
    );
    const color = DEPARTMENT_COLORS.find((candidate) => !used.has(candidate.toUpperCase())) ?? DEPARTMENT_COLORS[0]!;

    // The head is part of this operation, so validate it *before* writing anything.
    // The old order inserted the department first and threw afterwards, leaving an
    // empty department behind while the UI reported a failure.
    if (input.headEmployeeId && !this.isActive(input.headEmployeeId)) {
      throw new Error('指定的负责人不在岗');
    }
    const parentId = input.parentId || null;
    this.assertParent(id, parentId);
    // New departments land at the end of their siblings, so the chart keeps a stable
    // order that the boss can then rearrange.
    const sortOrder = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM department
            WHERE deleted_at IS NULL AND parent_id IS ?`,
        )
        .get(parentId) as { next: number }
    ).next;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO department (id, name, code, description, color, parent_id, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, code, (input.description ?? '').trim(), color, parentId, sortOrder, now, now);
      if (input.headEmployeeId) {
        // Move first (the employee may already hold a position elsewhere), then appoint.
        // `appointHead` is the single place that flips `is_head` and records the event,
        // so creating a department with a head leaves the same trail as appointing one.
        this.transfer(input.headEmployeeId, id);
        this.appointHead(id, input.headEmployeeId);
      }
    });
    tx();

    return this.list().find((department) => department.id === id) as DepartmentNode;
  };

  /** Hire = employee + position + budget, in one transaction. */
  hire = (input: HireInput): OrgMember => {
    const department = this.db
      .prepare('SELECT id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(input.departmentId);
    if (!department) throw new Error('部门不存在');

    const now = Date.now();
    const employeeId = `agent-${crypto.randomUUID()}`;
    // '' is the "no manager" value the UI sends; it is not an employee id, and passing
    // it to the foreign key would fail with a raw SQLite error.
    const managerId = input.reportsToEmployeeId || null;
    // A brand-new id cannot be its own manager; this validates the target is active.
    this.assertManager(employeeId, managerId);
    // Headcount is checked before anything is written: a refused hire must not leave a
    // half-created employee behind, and "编制已满" is a decision the boss has to make.
    const job = this.resolveJob(input.jobId, input.departmentId);
    const level = input.level ?? job?.level ?? 'P5';
    // With a job, its title *is* the role: the boss should not be able to type a
    // different one in the wizard and split "测试工程师" into three spellings.
    const role = job?.title ?? input.role;
    const title = input.title ?? job?.title ?? input.role;
    // A job is a template, so its skills / model seed the hire. An empty answer means
    // "use the job's", not "none" — clearing later is the stack editor's job.
    const askedSkills = cleanSkills(input.skills);
    const skills = askedSkills.length > 0 ? askedSkills : (job?.skills ?? []);
    const modelRef = input.modelRef ?? job?.modelRef;
    const model = input.model?.trim() || job?.model || '';
    // Probation is a date, not a flag: "试用期到哪天" is what a review is scheduled
    // against, and a boolean would have to be recomputed from `hired_at` every time.
    const probationDays = input.probationDays ?? 0;
    if (probationDays < 0 || !Number.isFinite(probationDays)) throw new Error('试用期天数不合法');
    const probationEndsAt = probationDays > 0 ? now + probationDays * 24 * 60 * 60 * 1000 : null;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO employee (id, name, role, level, department_id, model, model_ref, skills, persona, status,
                                 hired_at, probation_ends_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          employeeId,
          input.name,
          role,
          level,
          input.departmentId,
          model,
          // `model` stays the human label; `model_ref` is what the agent actually runs.
          modelRef ? JSON.stringify(modelRef) : '',
          JSON.stringify(skills),
          input.persona ?? '',
          now,
          probationEndsAt,
          now,
          now,
        );

      // The new head replaces the old one; `idx_pos_head` would reject a second flag.
      // Demote first: the insert below is the only row that must stay flagged.
      if (input.isHead) this.clearHead(input.departmentId, now, 'new head hired');

      this.db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, job_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `position-${crypto.randomUUID()}`,
          employeeId,
          input.departmentId,
          title,
          managerId,
          input.isHead ? 1 : 0,
          job?.id ?? null,
          now,
          now,
        );

      this.recordEvent({
        employeeId,
        kind: 'hired',
        to: { departmentId: input.departmentId, title, level },
        reason: job ? `入职 ${job.title}` : '',
        at: now,
      });
      if (input.isHead) {
        this.recordEvent({
          employeeId,
          kind: 'head_appointed',
          to: { departmentId: input.departmentId, title },
          at: now,
        });
      }
    });
    tx();

    new BudgetService(new BudgetRepository(this.db)).ensureForEmployee(employeeId);

    const member = this.list()
      .flatMap((departmentNode) => departmentNode.members)
      .find((entry) => entry.id === employeeId);
    if (!member) throw new Error('入职后读取员工失败');
    return member;
  };

  /** Uploaded portrait: a resized data URL, so nothing leaves the machine. */
  setAvatar = (employeeId: string, dataUrl: string): void => {
    this.db
      .prepare('UPDATE employee SET avatar = ?, updated_at = ? WHERE id = ?')
      .run(dataUrl, Date.now(), employeeId);
  };

  /**
   * The charter that reaches the system prompt.
   *
   * Stored on the employee row, so the next task and the next 1v1 reply pick it
   * up without a restart; `''` is a valid value and simply removes the charter.
   */
  setPersona = (employeeId: string, persona: string): void => {
    const { changes } = this.db
      .prepare('UPDATE employee SET persona = ?, updated_at = ? WHERE id = ?')
      .run(persona, Date.now(), employeeId);
    if (changes === 0) throw new Error('员工不存在');
  };

  /**
   * The model this employee actually runs with.
   *
   * Absent means "inherit the company default"; the legacy free-text `model`
   * column is not used here, because a label cannot identify a provider.
   */
  modelRefOf = (employeeId: string): ModelRef | undefined => {
    const row = this.db
      .prepare('SELECT model_ref FROM employee WHERE id = ?')
      .get(employeeId) as { model_ref: string } | undefined;
    return row ? parseModelRef(row.model_ref) : undefined;
  };

  /** Stored deny-list; malformed JSON degrades to "everything available". */
  toolPolicyOf = (employeeId: string): EmployeeToolPolicy => {
    const row = this.db
      .prepare('SELECT tool_policy FROM employee WHERE id = ?')
      .get(employeeId) as { tool_policy: string } | undefined;
    return parseToolPolicy(row?.tool_policy);
  };

  /**
   * Writes the employee's model override and/or tool policy.
   *
   * `model` is tri-state: omitted keeps the current ref, `null` clears it, an object
   * sets it. `modelLabel` is the human-readable snapshot the org chart shows; it is
   * passed by the caller because this service does not read the model catalogue.
   */
  setStack = (
    employeeId: string,
    input: { model?: ModelRef | null; modelLabel?: string; policy?: EmployeeToolPolicy },
  ): void => {
    const exists = this.db.prepare('SELECT id FROM employee WHERE id = ?').get(employeeId);
    if (!exists) throw new Error('员工不存在');

    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.model !== undefined) {
      if (input.model === null) {
        assignments.push("model_ref = '', model = ''");
      } else {
        const { providerId, modelId } = input.model;
        if (typeof providerId !== 'string' || !providerId || typeof modelId !== 'string' || !modelId) {
          throw new Error('模型参数不合法');
        }
        assignments.push('model_ref = ?, model = ?');
        values.push(JSON.stringify({ providerId, modelId }), input.modelLabel || `${providerId}/${modelId}`);
      }
    }
    if (input.policy !== undefined) {
      assignments.push('tool_policy = ?');
      values.push(JSON.stringify(normalizeToolPolicy(input.policy)));
    }
    if (assignments.length === 0) return;

    assignments.push('updated_at = ?');
    values.push(Date.now(), employeeId);
    this.db.prepare(`UPDATE employee SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  };

  /** One personnel entry point: transfer, terminate, reinstate, re-assign manager. */
  personnel = (input: PersonnelInput): void => {
    switch (input.action) {
      case 'transfer':
        if (!input.departmentId) throw new Error('调岗需要目标部门');
        this.transfer(input.employeeId, input.departmentId, input.reportsToEmployeeId);
        return;
      case 'terminate':
        this.fire(input.employeeId);
        return;
      case 'reinstate': {
        // The live seat is gone (terminated soft-deleted it), so the department has to
        // come from the last position row — the employee row is cleared on termination.
        const departmentId = input.departmentId ?? this.lastDepartment(input.employeeId);
        if (!departmentId) throw new Error('没有人事档案里的部门，请先指定部门');
        this.place(input.employeeId, departmentId);
        return;
      }
      case 'set-manager': {
        const position = this.livePosition(input.employeeId);
        if (!position) throw new Error('该员工不在岗，无法设置汇报对象');
        const managerId = input.reportsToEmployeeId || null;
        this.assertManager(input.employeeId, managerId);
        this.db
          .prepare('UPDATE position SET reports_to_employee_id = ?, updated_at = ? WHERE id = ?')
          .run(managerId, Date.now(), position.id);
        return;
      }
      case 'promote':
        this.promote(input.employeeId, { level: input.level, title: input.title, reason: input.reason });
        return;
      case 'confirm':
        this.confirm(input.employeeId, { reason: input.reason });
        return;
      default:
        throw new Error(`未知的人事操作: ${String(input.action)}`);
    }
  };

  /**
   * Raises (or lowers) someone's level, and optionally renames the seat.
   *
   * `employee.level` was display-only and had no write path at all, so "晋升" was a word
   * the UI used and the data could not express. The old value is captured in the event,
   * which is what makes a promotion review possible later.
   */
  promote = (employeeId: string, input: { level?: string; title?: string; reason?: string }): OrgMember => {
    const employee = this.db
      .prepare("SELECT id, level, status FROM employee WHERE id = ?")
      .get(employeeId) as { id: string; level: string; status: string } | undefined;
    if (!employee) throw new Error('员工不存在');
    if (employee.status !== 'active') throw new Error('该员工不在岗，无法晋升');

    const seat = this.livePosition(employeeId);
    const level = (input.level ?? employee.level).trim();
    const title = input.title?.trim() || seat?.title || '';
    if (!level) throw new Error('职级不能为空');
    if (level === employee.level && title === (seat?.title ?? '')) {
      // Nothing to record: an event that says "P5 → P5" is noise in a timeline.
      return this.everyone().find((member) => member.id === employeeId) as OrgMember;
    }

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE employee SET level = ?, updated_at = ? WHERE id = ?').run(level, now, employeeId);
      if (seat && title && title !== seat.title) {
        this.db.prepare('UPDATE position SET title = ?, updated_at = ? WHERE id = ?').run(title, now, seat.id);
      }
      this.recordEvent({
        employeeId,
        kind: 'promoted',
        from: { title: seat?.title, level: employee.level },
        to: { title: title || seat?.title, level },
        reason: input.reason ?? '',
        at: now,
      });
    });
    tx();

    return this.everyone().find((member) => member.id === employeeId) as OrgMember;
  };

  /**
   * Appoints (or clears) the head of a department.
   *
   * `is_head` had only two ways in — "hired as head" and "created a department with a
   * head" — so a department whose head left stayed headless forever. This is the
   * missing operation, and it records both halves: the demotion of the incumbent and
   * the appointment of the successor.
   */
  appointHead = (departmentId: string, employeeId: string | null): DepartmentNode => {
    const department = this.liveDepartment(departmentId);
    const now = Date.now();

    if (employeeId) {
      const seat = this.livePosition(employeeId);
      if (!seat) throw new Error('该员工不在岗');
      if (seat.department_id !== departmentId) {
        throw new Error(`「${department.name}」的负责人必须在该部门在岗，请先调岗`);
      }
      if (seat.is_head === 1) {
        return this.list().find((node) => node.id === departmentId) as DepartmentNode;
      }
    }

    const tx = this.db.transaction(() => {
      // `clearHead` records the demotion of whoever held it; then the new flag goes on.
      this.clearHead(departmentId, now, employeeId ? '更换负责人' : '免去负责人');
      if (employeeId) {
        this.db
          .prepare(
            "UPDATE position SET is_head = 1, updated_at = ? WHERE employee_id = ? AND department_id = ? AND deleted_at IS NULL",
          )
          .run(now, employeeId, departmentId);
        // An acting head exists because the seat was empty. Filling it ends the
        // arrangement, and `idx_pos_acting_head` would otherwise leave two people
        // claiming the same department's leadership.
        this.clearActingHead(departmentId, now);
        const seat = this.livePosition(employeeId);
        this.recordEvent({
          employeeId,
          kind: 'head_appointed',
          to: { departmentId, title: seat?.title },
          at: now,
        });
      }
    });
    tx();

    return this.list().find((node) => node.id === departmentId) as DepartmentNode;
  };

  /** Clears the acting-head flag without recording an event (the caller explains it). */
  private clearActingHead = (departmentId: string, now: number): void => {
    this.db
      .prepare(
        'UPDATE position SET is_acting_head = 0, updated_at = ? WHERE department_id = ? AND is_acting_head = 1 AND deleted_at IS NULL',
      )
      .run(now, departmentId);
  };

  /**
   * Appoints (or clears) an acting head: the person covering a seat that is vacant or
   * whose holder is away.
   *
   * It is a separate flag, not a second `is_head`, because the two answer different
   * questions: "who is formally accountable" and "who is holding the fort". Collapsing
   * them would make a temporary cover indistinguishable from a real appointment in
   * every report that reads `is_head` — including the permission edge for task
   * decomposition.
   */
  appointActingHead = (departmentId: string, employeeId: string | null): DepartmentNode => {
    const department = this.liveDepartment(departmentId);
    const now = Date.now();

    if (employeeId) {
      const seat = this.livePosition(employeeId);
      if (!seat) throw new Error('该员工不在岗');
      if (seat.department_id !== departmentId) {
        throw new Error(`「${department.name}」的代理负责人必须在该部门在岗，请先调岗`);
      }
      if (seat.is_head === 1) {
        throw new Error('负责人本人不需要再设为代理负责人');
      }
      if (seat.is_acting_head === 1) {
        return this.list().find((node) => node.id === departmentId) as DepartmentNode;
      }
    }

    const tx = this.db.transaction(() => {
      this.clearActingHead(departmentId, now);
      if (employeeId) {
        this.db
          .prepare(
            "UPDATE position SET is_acting_head = 1, updated_at = ? WHERE employee_id = ? AND department_id = ? AND deleted_at IS NULL",
          )
          .run(now, employeeId, departmentId);
      }
    });
    tx();

    return this.list().find((node) => node.id === departmentId) as DepartmentNode;
  };

  // ── 绩效 ────────────────────────────────────────────────────────────────

  /** One employee's reviews, newest first. */
  evaluations = (employeeId: string, limit = 50): Evaluation[] => {
    const rows = this.db
      .prepare(
        `SELECT id, employee_id, kind, period_key, score_overall, score_quality, score_speed,
                score_cost, summary, reviewer, at
           FROM evaluation WHERE employee_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(employeeId, limit) as {
      id: string;
      employee_id: string;
      kind: Evaluation['kind'];
      period_key: string;
      score_overall: number;
      score_quality: number | null;
      score_speed: number | null;
      score_cost: number | null;
      summary: string;
      reviewer: string;
      at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      kind: row.kind,
      periodKey: row.period_key,
      scoreOverall: row.score_overall,
      ...(row.score_quality !== null ? { scoreQuality: row.score_quality } : {}),
      ...(row.score_speed !== null ? { scoreSpeed: row.score_speed } : {}),
      ...(row.score_cost !== null ? { scoreCost: row.score_cost } : {}),
      summary: row.summary,
      reviewer: row.reviewer,
      at: row.at,
    }));
  };

  /**
   * Records one review.
   *
   * Scores are validated here as well as by the CHECK constraint: "4.5 out of 5" is the
   * only thing a promotion decision can stand on, so a typo must be refused with a
   * readable message rather than a raw SQLite error. The employee does not have to be
   * active — an exit interview is a review too.
   */
  addEvaluation = (input: EvaluationInput): Evaluation => {
    const employee = this.db.prepare('SELECT id FROM employee WHERE id = ?').get(input.employeeId);
    if (!employee) throw new Error('员工不存在');

    const score = input.scoreOverall;
    if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error('总评分必须在 1–5 之间');
    for (const [label, value] of [
      ['质量', input.scoreQuality],
      ['速度', input.scoreSpeed],
      ['成本', input.scoreCost],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > 5)) {
        throw new Error(`${label}评分必须在 1–5 之间`);
      }
    }

    const now = Date.now();
    const id = `eval-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO evaluation
           (id, employee_id, kind, period_key, score_overall, score_quality, score_speed,
            score_cost, summary, reviewer, at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.employeeId,
        input.kind ?? 'periodic',
        (input.periodKey ?? '').trim(),
        score,
        input.scoreQuality ?? null,
        input.scoreSpeed ?? null,
        input.scoreCost ?? null,
        (input.summary ?? '').trim(),
        input.reviewer ?? BOSS_USER_ID,
        now,
        now,
      );

    return this.evaluations(input.employeeId).find((row) => row.id === id) as Evaluation;
  };

  /**
   * Confirms someone who is on probation (转正).
   *
   * Clearing `probation_ends_at` is what makes the person permanent, and the event is
   * what makes "when did they pass probation" answerable — the column alone forgets it.
   */
  confirm = (employeeId: string, input: { reason?: string } = {}): OrgMember => {
    const employee = this.db
      .prepare("SELECT id, status, probation_ends_at FROM employee WHERE id = ?")
      .get(employeeId) as { id: string; status: string; probation_ends_at: number | null } | undefined;
    if (!employee) throw new Error('员工不存在');
    if (employee.status !== 'active') throw new Error('该员工不在岗，无法转正');

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE employee SET probation_ends_at = NULL, updated_at = ? WHERE id = ?')
        .run(now, employeeId);
      const seat = this.livePosition(employeeId);
      this.recordEvent({
        employeeId,
        kind: 'confirmed',
        to: { departmentId: seat?.department_id, title: seat?.title },
        reason:
          input.reason ??
          (employee.probation_ends_at
            ? `试用期至 ${new Date(employee.probation_ends_at).toISOString().slice(0, 10)}`
            : ''),
        at: now,
      });
    });
    tx();

    return this.everyone().find((member) => member.id === employeeId) as OrgMember;
  };

  /** Backfills skills from a fixture or an import; idempotent. */
  setSkills = (employeeId: string, skills: readonly string[]): void => {
    this.db
      .prepare('UPDATE employee SET skills = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(skills), Date.now(), employeeId);
  };

  /**
   * Moves someone to another department.
   *
   * `reportsToEmployeeId` is tri-state: omitted (`undefined`) keeps the current line,
   * `''` clears it, an id sets it. The board's drag-and-drop passes neither argument,
   * and a drop must not silently cut the reporting line — that line is the permission
   * edge `subordinatesOf` reads to decide who may decompose tasks.
   *
   * The seat `title` is carried across too. It is the name of the seat ("高级前端工程
   * 师"), not the job family in `employee.role`; resetting it to `role` on every move
   * quietly rewrote people's job titles.
   *
   * `jobId` is the fourth tri-state: omitted keeps the job when the department does not
   * change (a plain title edit), and clears it when it does, because a job belongs to
   * one department and carrying it across would point at another team's headcount.
   * `''` clears it explicitly, an id assigns it (validated against the cap).
   */
  transfer = (
    employeeId: string,
    departmentId: string,
    reportsToEmployeeId?: string,
    jobId?: string,
  ): OrgMember => this.moveSeat(employeeId, departmentId, reportsToEmployeeId, jobId, 'transferred');

  /**
   * The one place a seat is written.
   *
   * `eventKind` is `null` for callers that record their own event: reinstatement is
   * one fact ("he came back"), not two ("he was transferred from nowhere, then
   * reinstated"), and the timeline should read like a person's history, not like the
   * sequence of internal calls that produced it.
   */
  private moveSeat = (
    employeeId: string,
    departmentId: string,
    reportsToEmployeeId: string | undefined,
    jobId: string | undefined,
    eventKind: EmploymentEventKind | null,
  ): OrgMember => {
    const department = this.db
      .prepare('SELECT id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(departmentId);
    if (!department) throw new Error('部门不存在');

    const employee = this.db.prepare('SELECT id, role, level FROM employee WHERE id = ?').get(employeeId) as
      | { id: string; role: string; level: string }
      | undefined;
    if (!employee) throw new Error('员工不存在');

    const current = this.livePosition(employeeId);
    const previous = current ?? this.latestPosition(employeeId);
    const sameDepartment = current?.department_id === departmentId;
    const title = previous?.title?.trim() ? previous.title : employee.role;
    const managerId =
      reportsToEmployeeId === undefined
        ? this.survivingManager(employeeId, previous?.reports_to_employee_id ?? null)
        : reportsToEmployeeId || null;
    this.assertManager(employeeId, managerId);

    // Jobs are company-wide, so a move keeps the seat's job unless the caller names
    // another one. The new department may have no headcount planned for it; the
    // dossier reports that as 计划外 instead of silently dropping the seat.
    const requestedJob = jobId === undefined ? previous?.job_id ?? '' : jobId;
    const job = this.resolveJob(requestedJob || undefined, departmentId, employeeId);

    // A "transfer" to the same department must not silently demote the head: the
    // old row is soft-deleted below, so the flag has to be carried across. Same for
    // the acting head — it is a second flag on the same row, and losing it would
    // leave a department with nobody covering the seat.
    const keepHead = current?.is_head === 1 && sameDepartment;
    const keepActing = current?.is_acting_head === 1 && sameDepartment;

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE position SET deleted_at = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL')
        .run(now, now, employeeId);
      this.db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, is_acting_head, job_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `position-${crypto.randomUUID()}`,
          employeeId,
          departmentId,
          title,
          managerId,
          keepHead ? 1 : 0,
          keepActing ? 1 : 0,
          job?.id ?? null,
          now,
          now,
        );
      this.db
        .prepare('UPDATE employee SET department_id = ?, updated_at = ? WHERE id = ?')
        .run(departmentId, now, employeeId);

      // Only a real move is an event: re-seating someone in the same department (the
      // same-department branch above) must not fill the timeline with noise.
      if (eventKind && (!sameDepartment || !current)) {
        this.recordEvent({
          employeeId,
          kind: eventKind,
          from: current ? { departmentId: current.department_id, title: current.title } : {},
          to: { departmentId, title },
          at: now,
        });
      }
    });
    tx();

    const member = this.list()
      .flatMap((departmentNode) => departmentNode.members)
      .find((entry) => entry.id === employeeId);
    if (!member) throw new Error('调岗后读取员工失败');
    return member;
  };

  /**
   * Firing stops future work and frees quota: active tasks are cancelled and their
   * reservations released, because a departed employee must not keep spending.
   *
   * It also closes the employment record: `terminated_at` is stamped (the column has
   * existed since v1 but nothing ever wrote it) and the redundant
   * `employee.department_id` is cleared, so no reader can mistake a departed employee
   * for a member of their old department. The seat itself stays as history — the
   * position row is soft-deleted, not removed.
   */
  fire = (employeeId: string): { cancelled: number } => {
    const now = Date.now();
    const tasks = this.db
      .prepare("SELECT id FROM task WHERE employee_id = ? AND status IN ('open','running')")
      .all(employeeId) as { id: string }[];

    const seat = this.livePosition(employeeId);
    // Direct reports are handed to the departing manager's own manager. Without this
    // they keep pointing at a terminated employee: `subordinatesOf` drops them (it
    // only counts active members), so the whole branch silently becomes rootless.
    const managerId = seat?.reports_to_employee_id ?? null;
    const successor =
      managerId && managerId !== employeeId && this.isActive(managerId) ? managerId : null;

    const budgets = new BudgetService(new BudgetRepository(this.db));

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE position SET reports_to_employee_id = ?, updated_at = ? WHERE reports_to_employee_id = ? AND deleted_at IS NULL',
        )
        .run(successor, now, employeeId);
      this.db
        .prepare(
          `UPDATE employee SET status = 'terminated', terminated_at = ?, department_id = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, employeeId);
      this.db
        .prepare('UPDATE position SET deleted_at = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL')
        .run(now, now, employeeId);

      // Leaving closes two records at once: the employment itself, and the head seat
      // they may have held. Both are written before the position row is gone, so the
      // event can still name the department and title they left.
      this.recordEvent({
        employeeId,
        kind: 'terminated',
        from: seat ? { departmentId: seat.department_id, title: seat.title } : {},
        at: now,
      });
      if (seat?.is_head === 1) {
        this.recordEvent({
          employeeId,
          kind: 'head_removed',
          from: { departmentId: seat.department_id, title: seat.title },
          reason: '离职',
          at: now,
        });
      }

      for (const task of tasks) {
        this.db
          .prepare("UPDATE task SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, task.id);
        this.db
          .prepare('INSERT INTO task_step (id, task_id, at, text) VALUES (?, ?, ?, ?)')
          .run(`step-${crypto.randomUUID()}`, task.id, now, '员工已离职，任务取消');
      }
    });
    tx();

    for (const task of tasks) budgets.release(task.id);
    return { cancelled: tasks.length };
  };
}
