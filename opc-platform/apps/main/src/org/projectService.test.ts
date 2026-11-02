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

describe('project lifecycle', () => {
  it('hides archived projects from the index unless asked for them', () => {
    const { project } = team();
    projects.archive(project.id);

    expect(projects.list().some((entry) => entry.id === project.id)).toBe(false);
    expect(projects.list({ includeArchived: true }).some((entry) => entry.id === project.id)).toBe(true);
  });

  it('keeps paused and done projects in the index, with their team', () => {
    const { project, worker } = team();

    projects.setStatus(project.id, 'paused');
    const paused = projects.list().find((entry) => entry.id === project.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.members.some((member) => member.employeeId === worker.id)).toBe(true);

    projects.setStatus(project.id, 'done');
    expect(projects.list().find((entry) => entry.id === project.id)?.status).toBe('done');
    // A finished project keeps its people — they are still assigned, the work is over.
    expect(memberOf(project.id, worker.id)?.employeeId).toBe(worker.id);
  });

  it('stops feeding a paused project into member context without unassigning anyone', () => {
    const { project, worker } = team();
    expect(projects.activeProjectIdsOf(worker.id)).toContain(project.id);

    projects.setStatus(project.id, 'paused');
    expect(projects.activeProjectIdsOf(worker.id)).not.toContain(project.id);

    projects.setStatus(project.id, 'active');
    expect(projects.activeProjectIdsOf(worker.id)).toContain(project.id);
  });

  it('refuses to move an archived project and leaves it terminal', () => {
    const { project } = team();
    projects.archive(project.id);

    expect(() => projects.setStatus(project.id, 'active')).toThrow('已归档的项目不能改状态');
  });

  it('refuses an unknown status', () => {
    const { project } = team();

    expect(() => projects.setStatus(project.id, 'retired' as never)).toThrow('未知的项目状态');
  });
});

describe('project milestones', () => {
  const milestonesOf = (projectId: string) =>
    projects.list({ includeArchived: true }).find((entry) => entry.id === projectId)?.milestones ?? [];

  it('stores checkpoints in due-date order with undated ones last', () => {
    const { project } = team();
    projects.addMilestone(project.id, { title: '发布', dueAt: 2_000 });
    projects.addMilestone(project.id, { title: '内测' });
    projects.addMilestone(project.id, { title: '公测', dueAt: 1_000 });

    expect(milestonesOf(project.id).map((entry) => entry.title)).toEqual(['公测', '发布', '内测']);
  });

  it('completes with a timestamp and clears it on reopen', () => {
    const { project } = team();
    projects.addMilestone(project.id, { title: '内测上线' });
    const id = milestonesOf(project.id)[0]!.id;

    projects.updateMilestone(id, { done: true });
    const done = milestonesOf(project.id)[0]!;
    expect(done.done).toBe(true);
    expect(done.completedAt).toBeTypeOf('number');

    projects.updateMilestone(id, { done: false });
    const reopened = milestonesOf(project.id)[0]!;
    expect(reopened.done).toBe(false);
    expect(reopened.completedAt).toBeUndefined();
  });

  it('renames and reschedules without touching completion', () => {
    const { project } = team();
    projects.addMilestone(project.id, { title: '内测', dueAt: 1_000 });
    const id = milestonesOf(project.id)[0]!.id;

    projects.updateMilestone(id, { title: '公测', dueAt: 5_000 });

    expect(milestonesOf(project.id)[0]).toMatchObject({ id, title: '公测', dueAt: 5_000, done: false });
  });

  it('removes a checkpoint', () => {
    const { project } = team();
    projects.addMilestone(project.id, { title: '内测' });
    const id = milestonesOf(project.id)[0]!.id;

    projects.removeMilestone(id);

    expect(milestonesOf(project.id)).toEqual([]);
  });

  it('refuses empty titles and unknown milestones', () => {
    const { project } = team();

    expect(() => projects.addMilestone(project.id, { title: '   ' })).toThrow('里程碑标题不能为空');
    expect(() => projects.updateMilestone('ms-missing', { done: true })).toThrow('里程碑不存在');
    expect(() => projects.removeMilestone('ms-missing')).toThrow('里程碑不存在');
  });

  it('is read-only once the project is archived', () => {
    const { project } = team();
    projects.addMilestone(project.id, { title: '内测' });
    const id = milestonesOf(project.id)[0]!.id;
    projects.archive(project.id);

    expect(() => projects.addMilestone(project.id, { title: '公测' })).toThrow('项目不存在或已归档');
    expect(() => projects.updateMilestone(id, { done: true })).toThrow('项目不存在或已归档');
    expect(() => projects.removeMilestone(id)).toThrow('项目不存在或已归档');
    // Archiving keeps the history it was hiding.
    expect(milestonesOf(project.id).map((entry) => entry.title)).toEqual(['内测']);
  });
});
