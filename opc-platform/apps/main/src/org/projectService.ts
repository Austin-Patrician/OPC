import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';

export interface ProjectMember {
  employeeId: string;
  name: string;
  role: string;
  /** `paused` means a budget hard stop (§5.6), not a removal. */
  status: string;
  pauseReason?: string;
  /** Project-internal reporting line, which may differ from the department one. */
  reportsToEmployeeId?: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  code: string;
  description: string;
  departmentId: string;
  status: 'active' | 'archived';
  members: ProjectMember[];
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  code?: string;
  description?: string;
  departmentId?: string;
}

/**
 * Project groups, separate from the org seat.
 *
 * Design §4.3 splits them on purpose: `position` is where someone sits in the org
 * chart (one at a time), `assignment` is the projects they work on (many). That is
 * what makes project-scoped memory and facts possible — an employee's context is
 * "my seat + the projects I am currently assigned to", never every project.
 */
export class ProjectService {
  constructor(private readonly db: CompanyDatabase) {}

  create = (input: CreateProjectInput): ProjectGroup => {
    const name = input.name.trim();
    if (!name) throw new Error('项目名称不能为空');
    const clash = this.db
      .prepare("SELECT name FROM project_group WHERE status = 'active' AND LOWER(TRIM(name)) = LOWER(?)")
      .get(name);
    if (clash) throw new Error(`项目名称已存在：${name}`);

    const now = Date.now();
    const id = `proj-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO project_group (id, name, code, description, department_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, name, (input.code ?? '').trim().toUpperCase(), (input.description ?? '').trim(), input.departmentId ?? null, now, now);

    return this.list().find((project) => project.id === id)!;
  };

  list = (options: { includeArchived?: boolean } = {}): ProjectGroup[] => {
    const rows = this.db
      .prepare(
        `SELECT id, name, code, description, department_id, status, created_at
           FROM project_group ${options.includeArchived ? '' : "WHERE status = 'active'"}
          ORDER BY created_at DESC`,
      )
      .all() as {
      id: string;
      name: string;
      code: string;
      description: string;
      department_id: string | null;
      status: 'active' | 'archived';
      created_at: number;
    }[];

    const members = this.db
      .prepare(
        `SELECT a.project_group_id, a.employee_id, a.role, a.status, a.pause_reason,
                a.reports_to_employee_id, e.name
           FROM assignment a JOIN employee e ON e.id = a.employee_id
          WHERE a.status IN ('active','paused')
          ORDER BY a.created_at`,
      )
      .all() as {
      project_group_id: string;
      employee_id: string;
      role: string;
      status: string;
      pause_reason: string | null;
      reports_to_employee_id: string | null;
      name: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      departmentId: row.department_id ?? '',
      status: row.status,
      createdAt: row.created_at,
      members: members
        .filter((member) => member.project_group_id === row.id)
        .map((member) => ({
          employeeId: member.employee_id,
          name: member.name,
          role: member.role,
          status: member.status,
          ...(member.pause_reason ? { pauseReason: member.pause_reason } : {}),
          ...(member.reports_to_employee_id
            ? { reportsToEmployeeId: member.reports_to_employee_id }
            : {}),
        })),
    }));
  };

  /** Adding someone who is already assigned updates the role instead of duplicating. */
  assign = (projectId: string, employeeId: string, role = ''): void => {
    const project = this.db.prepare("SELECT id FROM project_group WHERE id = ? AND status = 'active'").get(projectId);
    if (!project) throw new Error('项目不存在或已归档');
    const employee = this.db
      .prepare("SELECT id FROM employee WHERE id = ? AND status = 'active'")
      .get(employeeId);
    if (!employee) throw new Error('员工不在岗');

    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id FROM assignment WHERE project_group_id = ? AND employee_id = ? AND status = 'active'")
      .get(projectId, employeeId) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE assignment SET role = COALESCE(NULLIF(?, \'\'), role), updated_at = ? WHERE id = ?')
        .run(role, now, existing.id);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO assignment (id, employee_id, project_group_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(`assign-${crypto.randomUUID()}`, employeeId, projectId, role, now, now);
  };

  removeMember = (projectId: string, employeeId: string): void => {
    const now = Date.now();
    // Direct reports are handed to the departing member's own manager, exactly like a
    // department transfer: a line pointing at someone who is no longer on the project
    // is a dangling permission edge, and `subordinatesOf`-style reads would drop the
    // whole branch silently.
    const assignment = this.db
      .prepare(
        "SELECT id, reports_to_employee_id FROM assignment WHERE project_group_id = ? AND employee_id = ? AND status = 'active'",
      )
      .get(projectId, employeeId) as
      | { id: string; reports_to_employee_id: string | null }
      | undefined;

    this.db.transaction(() => {
      if (assignment) {
        this.db
          .prepare(
            `UPDATE assignment SET reports_to_employee_id = ?, updated_at = ?
              WHERE project_group_id = ? AND reports_to_employee_id = ? AND status = 'active'`,
          )
          .run(assignment.reports_to_employee_id, now, projectId, employeeId);
      }
      this.db
        .prepare(
          "UPDATE assignment SET status = 'removed', reports_to_employee_id = NULL, updated_at = ? WHERE project_group_id = ? AND employee_id = ? AND status = 'active'",
        )
        .run(now, projectId, employeeId);
    })();
  };

  /**
   * Sets the project-internal reporting line (matrix reporting).
   *
   * The department line says who owns your career; this one says who you hand work to
   * inside one project. It is validated the same way the department line is: both ends
   * must be on the project, and the edge cannot close a loop — a project cycle would
   * make two people each other's reviewer.
   */
  setReportsTo = (projectId: string, employeeId: string, managerId: string | null): void => {
    const project = this.db
      .prepare("SELECT id FROM project_group WHERE id = ? AND status = 'active'")
      .get(projectId);
    if (!project) throw new Error('项目不存在或已归档');

    const member = this.db
      .prepare(
        "SELECT id FROM assignment WHERE project_group_id = ? AND employee_id = ? AND status = 'active'",
      )
      .get(projectId, employeeId);
    if (!member) throw new Error('该员工不在这个项目里');

    const manager = managerId || null;
    if (manager) {
      if (manager === employeeId) throw new Error('不能把自己设为项目内汇报对象');
      const managerRow = this.db
        .prepare(
          "SELECT 1 AS ok FROM assignment WHERE project_group_id = ? AND employee_id = ? AND status = 'active'",
        )
        .get(projectId, manager);
      if (!managerRow) throw new Error('项目内汇报对象必须是本项目的在岗成员');

      // Walk up the project chain; a cycle here would make the project's own
      // review/report structure unreadable.
      const seen = new Set<string>();
      let cursor: string | null = manager;
      while (cursor) {
        if (cursor === employeeId) throw new Error('项目内汇报线不能成环');
        if (seen.has(cursor)) return;
        seen.add(cursor);
        cursor = this.reportsToOf(projectId, cursor);
      }
    }

    this.db
      .prepare(
        'UPDATE assignment SET reports_to_employee_id = ?, updated_at = ? WHERE project_group_id = ? AND employee_id = ? AND status = ?',
      )
      .run(manager, Date.now(), projectId, employeeId, 'active');
  };

  /** Who this person hands work to inside one project, if anyone. */
  private reportsToOf = (projectId: string, employeeId: string): string | null =>
    (
      this.db
        .prepare(
          "SELECT reports_to_employee_id FROM assignment WHERE project_group_id = ? AND employee_id = ? AND status = 'active'",
        )
        .get(projectId, employeeId) as { reports_to_employee_id: string | null } | undefined
    )?.reports_to_employee_id ?? null;

  /** Direct reports inside one project (the matrix edge, not the department one). */
  subordinatesIn = (projectId: string, managerId: string): ProjectMember[] => {
    const project = this.list().find((entry) => entry.id === projectId);
    if (!project) return [];
    return project.members.filter(
      (member) => member.reportsToEmployeeId === managerId && member.status === 'active',
    );
  };

  archive = (projectId: string): void => {
    const now = Date.now();
    this.db.prepare("UPDATE project_group SET status = 'archived', updated_at = ? WHERE id = ?").run(now, projectId);
    this.db
      .prepare(
        "UPDATE assignment SET status = 'removed', reports_to_employee_id = NULL, updated_at = ? WHERE project_group_id = ? AND status = 'active'",
      )
      .run(now, projectId);
  };

  /**
   * F8（§5.6）：预算硬停停的是**任职**，不是员工。
   *
   * 项目预算超了 → 只暂停这个项目的任职，他在别的项目照常干活；
   * 员工预算超了 → 只停他自己的任职。恢复时按 reason 精确找回那批人。
   */
  pauseAssignments = (filter: { projectId?: string; employeeId?: string }, reason: string): number => {
    const now = Date.now();
    const clauses = ["status = 'active'"];
    const where: (string | number)[] = [];
    if (filter.projectId) {
      clauses.push('project_group_id = ?');
      where.push(filter.projectId);
    }
    if (filter.employeeId) {
      clauses.push('employee_id = ?');
      where.push(filter.employeeId);
    }
    // A company-wide stop is the boss's call, not a side effect of one charge.
    if (where.length === 0) throw new Error('暂停任职必须指定项目或员工');

    return this.db
      .prepare(
        `UPDATE assignment SET status = 'paused', pause_reason = ?, paused_at = ?, updated_at = ?
          WHERE ${clauses.join(' AND ')}`,
      )
      .run(reason, now, now, ...where).changes;
  };

  /** 解除硬停：把因同一个原因被暂停的任职放回去。返回恢复条数。 */
  resumeAssignments = (filter: { projectId?: string; employeeId?: string }, reason: string): number => {
    const clauses = ["status = 'paused'", 'pause_reason = ?'];
    const where: (string | number)[] = [reason];
    if (filter.projectId) {
      clauses.push('project_group_id = ?');
      where.push(filter.projectId);
    }
    if (filter.employeeId) {
      clauses.push('employee_id = ?');
      where.push(filter.employeeId);
    }

    return this.db
      .prepare(
        `UPDATE assignment SET status = 'active', pause_reason = NULL, paused_at = NULL, updated_at = ?
          WHERE ${clauses.join(' AND ')}`,
      )
      .run(Date.now(), ...where).changes;
  };

  /** Project ids an employee is currently on — the only ones allowed in its context. */
  activeProjectIdsOf = (employeeId: string): string[] =>    (
      this.db
        .prepare(
          `SELECT a.project_group_id FROM assignment a
             JOIN project_group p ON p.id = a.project_group_id
            WHERE a.employee_id = ? AND a.status = 'active' AND p.status = 'active'`,
        )
        .all(employeeId) as { project_group_id: string }[]
    ).map((row) => row.project_group_id);
}
