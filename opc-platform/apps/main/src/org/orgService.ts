import crypto from 'node:crypto';
import type { DepartmentNode, HireInput, OrgMember, PersonnelInput } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { BudgetRepository } from '../data/budgetRepository';
import { BudgetService } from '../work/budgetService';

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

export class OrgService {
  constructor(private readonly db: CompanyDatabase) {}

  /** Every employee row, with position data when one exists. */
  private readMembers = (): OrgMember[] => {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.name, e.role, e.level, e.status, e.model, e.skills, e.persona, e.avatar, e.hired_at,
                (SELECT COALESCE(SUM(t.tokens_used), 0) FROM task t WHERE t.employee_id = e.id) AS tokens_used,
                p.title, p.department_id, p.reports_to_employee_id, p.is_head,
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
      skills: string;
      persona: string;
      avatar: string;
      hired_at: number;
      tasks_done: number;
      cost_today: number;
      tokens_used: number;
      title: string | null;
      department_id: string | null;
      reports_to_employee_id: string | null;
      is_head: number | null;
      active_tasks: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      level: row.level,
      status: row.status,
      model: row.model,
      title: row.title ?? row.role,
      departmentId: row.department_id ?? '',
      reportsToEmployeeId: row.reports_to_employee_id ?? undefined,
      isHead: row.is_head === 1,
      activeTasks: row.active_tasks,
      tokensUsed: row.tokens_used,
      skills: JSON.parse(row.skills || '[]') as string[],
      persona: row.persona ?? '',
      avatar: row.avatar ?? '',
      hiredAt: row.hired_at || 0,
      costTodayUsd: row.cost_today,
      tasksDone: row.tasks_done,
    }));
  };

  list = (): DepartmentNode[] => {
    const members = this.readMembers();
    const departments = this.db
      .prepare(
        'SELECT id, name, code, description, color FROM department WHERE deleted_at IS NULL ORDER BY created_at',
      )
      .all() as {
      id: string;
      name: string;
      code: string;
      description: string;
      color: string;
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
      return {
        id: department.id,
        name: department.name,
        code: department.code,
        description: department.description,
        color: department.color,
        // Derived, never stored: `position.is_head` is the single source of truth.
        // `department.head_employee_id` is kept in the schema for one release so a
        // rollback still renders, but this class neither reads nor writes it.
        headEmployeeId: departmentMembers.find((member) => member.isHead)?.id,
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
   */
  place = (employeeId: string, departmentId: string): void => {
    const now = Date.now();
    this.db.prepare("UPDATE employee SET status = 'active', updated_at = ? WHERE id = ?").run(now, employeeId);
    this.assignExisting(employeeId, departmentId);
    const existing = this.db
      .prepare('SELECT id FROM position WHERE employee_id = ? AND deleted_at IS NULL')
      .get(employeeId);
    if (!existing) {
      this.transfer(employeeId, departmentId);
    }
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
   */
  private clearHead = (departmentId: string, now: number): void => {
    this.db
      .prepare(
        'UPDATE position SET is_head = 0, updated_at = ? WHERE department_id = ? AND is_head = 1 AND deleted_at IS NULL',
      )
      .run(now, departmentId);
  };

  /** The live position of one employee, if any. `position` is the org authority. */
  private livePosition = (
    employeeId: string,
  ): { id: string; department_id: string; reports_to_employee_id: string | null; is_head: number } | undefined =>
    this.db
      .prepare(
        `SELECT id, department_id, reports_to_employee_id, is_head FROM position
          WHERE employee_id = ? AND deleted_at IS NULL`,
      )
      .get(employeeId) as
      | { id: string; department_id: string; reports_to_employee_id: string | null; is_head: number }
      | undefined;

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

  createDepartment = (input: {
    name: string;
    code?: string;
    description?: string;
    /** Optional appointed head; the employee moves into the new department. */
    headEmployeeId?: string;
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

    this.db
      .prepare(
        `INSERT INTO department (id, name, code, description, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, code, (input.description ?? '').trim(), color, now, now);
    if (input.headEmployeeId) {
      const head = this.db
        .prepare("SELECT id FROM employee WHERE id = ? AND status = 'active'")
        .get(input.headEmployeeId);
      if (!head) throw new Error('指定的负责人不在岗');
      // Move first (the employee may already hold a position elsewhere), then mark
      // head. A brand-new department has no incumbent, but going through `clearHead`
      // keeps the invariant in one place.
      this.transfer(input.headEmployeeId, id);
      this.clearHead(id, Date.now());
      this.db
        .prepare(
          "UPDATE position SET is_head = 1, updated_at = ? WHERE employee_id = ? AND department_id = ? AND deleted_at IS NULL",
        )
        .run(Date.now(), input.headEmployeeId, id);
    }

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
    // A brand-new id cannot be its own manager; this validates the target is active.
    this.assertManager(employeeId, input.reportsToEmployeeId ?? null);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO employee (id, name, role, level, department_id, model, skills, persona, status, hired_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          employeeId,
          input.name,
          input.role,
          input.level ?? 'P5',
          input.departmentId,
          input.model ?? '',
          JSON.stringify(input.skills ?? []),
          input.persona ?? '',
          now,
          now,
          now,
        );

      // The new head replaces the old one; `idx_pos_head` would reject a second flag.
      // Demote first: the insert below is the only row that must stay flagged.
      if (input.isHead) this.clearHead(input.departmentId, now);

      this.db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `position-${crypto.randomUUID()}`,
          employeeId,
          input.departmentId,
          input.title ?? input.role,
          input.reportsToEmployeeId ?? null,
          input.isHead ? 1 : 0,
          now,
          now,
        );
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
        const departmentId =
          input.departmentId ??
          (this.db
            .prepare(
              `SELECT department_id FROM position WHERE employee_id = ? AND deleted_at IS NULL
               UNION SELECT department_id FROM employee WHERE id = ?`,
            )
            .get(input.employeeId, input.employeeId) as { department_id: string } | undefined)?.department_id;
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
      default:
        throw new Error(`未知的人事操作: ${String(input.action)}`);
    }
  };

  /** Backfills skills from a fixture or an import; idempotent. */
  setSkills = (employeeId: string, skills: readonly string[]): void => {
    this.db
      .prepare('UPDATE employee SET skills = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(skills), Date.now(), employeeId);
  };

  /** Places an already-existing employee (demo migration / import). */
  assignExisting = (
    employeeId: string,
    departmentId: string,
    options: { title?: string; isHead?: boolean; reportsToEmployeeId?: string } = {},
  ): void => {
    const employee = this.db.prepare('SELECT id, role FROM employee WHERE id = ?').get(employeeId) as
      | { id: string; role: string }
      | undefined;
    if (!employee) throw new Error('员工不存在');

    const existing = this.db
      .prepare('SELECT id FROM position WHERE employee_id = ? AND deleted_at IS NULL')
      .get(employeeId);
    if (existing) return;

    this.assertManager(employeeId, options.reportsToEmployeeId ?? null);

    const now = Date.now();
    // Demote the incumbent before inserting the new flag: `idx_pos_head` permits one.
    if (options.isHead) this.clearHead(departmentId, now);
    this.db
      .prepare(
        `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `position-${crypto.randomUUID()}`,
        employeeId,
        departmentId,
        options.title ?? employee.role,
        options.reportsToEmployeeId ?? null,
        options.isHead ? 1 : 0,
        now,
        now,
      );
    this.db
      .prepare('UPDATE employee SET department_id = ?, updated_at = ? WHERE id = ?')
      .run(departmentId, now, employeeId);
  };

  transfer = (employeeId: string, departmentId: string, reportsToEmployeeId?: string): OrgMember => {
    const department = this.db
      .prepare('SELECT id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(departmentId);
    if (!department) throw new Error('部门不存在');

    this.assertManager(employeeId, reportsToEmployeeId ?? null);

    const current = this.livePosition(employeeId);
    // A "transfer" to the same department must not silently demote the head: the
    // old row is soft-deleted below, so the flag has to be carried across.
    const keepHead = current?.is_head === 1 && current.department_id === departmentId;

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE position SET deleted_at = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL')
        .run(now, now, employeeId);
      this.db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT role FROM employee WHERE id = ?), ?, ?, ?, ?)`,
        )
        .run(
          `position-${crypto.randomUUID()}`,
          employeeId,
          departmentId,
          employeeId,
          reportsToEmployeeId ?? null,
          keepHead ? 1 : 0,
          now,
          now,
        );
      this.db
        .prepare('UPDATE employee SET department_id = ?, updated_at = ? WHERE id = ?')
        .run(departmentId, now, employeeId);
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
   */
  fire = (employeeId: string): { cancelled: number } => {
    const now = Date.now();
    const tasks = this.db
      .prepare("SELECT id FROM task WHERE employee_id = ? AND status IN ('open','running')")
      .all(employeeId) as { id: string }[];

    // Direct reports are handed to the departing manager's own manager. Without this
    // they keep pointing at a terminated employee: `subordinatesOf` drops them (it
    // only counts active members), so the whole branch silently becomes rootless.
    const managerId = this.livePosition(employeeId)?.reports_to_employee_id ?? null;
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
        .prepare("UPDATE employee SET status = 'terminated', updated_at = ? WHERE id = ?")
        .run(now, employeeId);
      this.db
        .prepare('UPDATE position SET deleted_at = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL')
        .run(now, now, employeeId);
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
