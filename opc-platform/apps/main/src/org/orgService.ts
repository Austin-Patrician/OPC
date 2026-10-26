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
      .prepare('SELECT * FROM department WHERE deleted_at IS NULL ORDER BY created_at')
      .all() as {
      id: string;
      name: string;
      code: string;
      description: string;
      color: string;
      head_employee_id: string | null;
    }[];

    // No synthetic "unassigned" department: people without a position live in the
    // talent pool (`unplaced`), which is what the market page lists.
    return departments.map((department) => ({
      id: department.id,
      name: department.name,
      code: department.code,
      description: department.description,
      color: department.color,
      headEmployeeId: department.head_employee_id ?? undefined,
      members: members.filter((member) => member.departmentId === department.id),
    }));
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
      // Move first (the employee may already hold a position elsewhere), then mark head.
      this.transfer(input.headEmployeeId, id);
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

    if (input.reportsToEmployeeId) {
      const manager = this.db
        .prepare("SELECT id FROM employee WHERE id = ? AND status = 'active'")
        .get(input.reportsToEmployeeId);
      if (!manager) throw new Error('汇报对象不在岗');
    }

    const now = Date.now();
    const employeeId = `agent-${crypto.randomUUID()}`;

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

      if (input.isHead) {
        this.db
          .prepare('UPDATE department SET head_employee_id = ?, updated_at = ? WHERE id = ?')
          .run(employeeId, now, input.departmentId);
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
      case 'set-manager':
        this.db
          .prepare(
            'UPDATE position SET reports_to_employee_id = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL',
          )
          .run(input.reportsToEmployeeId || null, Date.now(), input.employeeId);
        return;
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

    const now = Date.now();
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
    if (options.isHead) {
      this.db
        .prepare('UPDATE department SET head_employee_id = ?, updated_at = ? WHERE id = ?')
        .run(employeeId, now, departmentId);
    }
  };

  transfer = (employeeId: string, departmentId: string, reportsToEmployeeId?: string): OrgMember => {
    const department = this.db
      .prepare('SELECT id FROM department WHERE id = ? AND deleted_at IS NULL')
      .get(departmentId);
    if (!department) throw new Error('部门不存在');

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE position SET deleted_at = ?, updated_at = ? WHERE employee_id = ? AND deleted_at IS NULL')
        .run(now, now, employeeId);
      this.db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, reports_to_employee_id, is_head, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT role FROM employee WHERE id = ?), ?, 0, ?, ?)`,
        )
        .run(
          `position-${crypto.randomUUID()}`,
          employeeId,
          departmentId,
          employeeId,
          reportsToEmployeeId ?? null,
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

    const budgets = new BudgetService(new BudgetRepository(this.db));

    const tx = this.db.transaction(() => {
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
