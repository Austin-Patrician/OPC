import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyDatabase } from '../data/companyDatabase';
import { openCompanyDatabase } from '../data/companyDatabase';
import { OrgService } from './orgService';
import { ProjectService } from './projectService';

/**
 * Matrix reporting: a project has its own reporting line, which may differ from the
 * department one. These tests pin the three properties that make it usable — both ends
 * must be on the project, it cannot loop, and it never outlives the person it points at.
 */

let dir: string;
let db: CompanyDatabase;
let org: OrgService;
let projects: ProjectService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-projects-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
  projects = new ProjectService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function team() {
  const department = org.createDepartment({ name: '工程部' });
  const lead = org.hire({ name: '甲', role: '技术负责人', departmentId: department.id });
  const worker = org.hire({ name: '乙', role: '工程师', departmentId: department.id });
  const outsider = org.hire({ name: '丙', role: '工程师', departmentId: department.id });
  const project = projects.create({ name: '结算重构', departmentId: department.id });
  projects.assign(project.id, lead.id, '项目负责人');
  projects.assign(project.id, worker.id, '后端');
  return { department, lead, worker, outsider, project };
}

const memberOf = (projectId: string, employeeId: string) =>
  projects.list().find((entry) => entry.id === projectId)?.members.find((m) => m.employeeId === employeeId);

describe('project reporting line', () => {
  it('records who a member hands work to inside the project', () => {
    const { project, lead, worker } = team();

    projects.setReportsTo(project.id, worker.id, lead.id);

    expect(memberOf(project.id, worker.id)?.reportsToEmployeeId).toBe(lead.id);
    expect(projects.subordinatesIn(project.id, lead.id).map((m) => m.employeeId)).toEqual([worker.id]);
  });

  it('is independent of the department reporting line', () => {
    const { project, lead, worker } = team();
    // In the org chart nobody manages the worker yet…
    expect(org.everyone().find((member) => member.id === worker.id)?.reportsToEmployeeId).toBeUndefined();

    projects.setReportsTo(project.id, worker.id, lead.id);

    // …while inside the project they report to the lead.
    expect(memberOf(project.id, worker.id)?.reportsToEmployeeId).toBe(lead.id);
    expect(org.everyone().find((member) => member.id === worker.id)?.reportsToEmployeeId).toBeUndefined();
  });

  it('clears the line with null', () => {
    const { project, lead, worker } = team();
    projects.setReportsTo(project.id, worker.id, lead.id);

    projects.setReportsTo(project.id, worker.id, null);

    expect(memberOf(project.id, worker.id)?.reportsToEmployeeId).toBeUndefined();
  });

  it('refuses a manager who is not on the project', () => {
    const { project, worker, outsider } = team();

    expect(() => projects.setReportsTo(project.id, worker.id, outsider.id)).toThrow(
      '项目内汇报对象必须是本项目的在岗成员',
    );
  });

  it('refuses a member who is not on the project', () => {
    const { project, lead, outsider } = team();

    expect(() => projects.setReportsTo(project.id, outsider.id, lead.id)).toThrow('该员工不在这个项目里');
  });

  it('refuses to make someone their own manager, or close a loop', () => {
    const { project, lead, worker } = team();
    projects.setReportsTo(project.id, worker.id, lead.id);

    expect(() => projects.setReportsTo(project.id, worker.id, worker.id)).toThrow(
      '不能把自己设为项目内汇报对象',
    );
    expect(() => projects.setReportsTo(project.id, lead.id, worker.id)).toThrow('项目内汇报线不能成环');

    // The refused write must not have partially applied.
    expect(memberOf(project.id, lead.id)?.reportsToEmployeeId).toBeUndefined();
  });

  it('hands direct reports to the departing member’s own manager', () => {
    const { project, lead, worker, outsider } = team();
    projects.assign(project.id, outsider.id, '测试');
    projects.setReportsTo(project.id, worker.id, lead.id);
    projects.setReportsTo(project.id, outsider.id, worker.id);

    projects.removeMember(project.id, worker.id);

    // `outsider` pointed at `worker`; it now points at `worker`'s manager, not at a ghost.
    expect(memberOf(project.id, outsider.id)?.reportsToEmployeeId).toBe(lead.id);
    expect(memberOf(project.id, worker.id)).toBeUndefined();
  });

  it('drops the line when the project is archived', () => {
    const { project, lead, worker } = team();
    projects.setReportsTo(project.id, worker.id, lead.id);

    projects.archive(project.id);

    const row = db
      .prepare('SELECT reports_to_employee_id, status FROM assignment WHERE project_group_id = ?')
      .all(project.id) as { reports_to_employee_id: string | null; status: string }[];
    expect(row.every((entry) => entry.reports_to_employee_id === null)).toBe(true);
    expect(row.every((entry) => entry.status === 'removed')).toBe(true);
  });

  it('survives a role change on the same project', () => {
    const { project, lead, worker } = team();
    projects.setReportsTo(project.id, worker.id, lead.id);

    // Re-assigning updates the role; it must not wipe the reporting line.
    projects.assign(project.id, worker.id, '架构');

    expect(memberOf(project.id, worker.id)?.role).toBe('架构');
    expect(memberOf(project.id, worker.id)?.reportsToEmployeeId).toBe(lead.id);
  });
});
