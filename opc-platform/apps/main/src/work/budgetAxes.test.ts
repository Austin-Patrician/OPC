import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgService } from '../org/orgService';
import { ProjectService } from '../org/projectService';
import { BudgetRepository } from '../data/budgetRepository';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { BudgetService } from './budgetService';

/**
 * 双轴预算 (§8.1) + 告警 (§8.3) + F8 的落地动作 (§5.6)。
 *
 * 这里跑的是真数据库：额度、预留、流水、告警、任职状态都是行，不是替身。
 */
let dir: string;
let db: CompanyDatabase;
let org: OrgService;
let projects: ProjectService;
let budgets: BudgetService;
let employee: { id: string; departmentId: string };
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-budget-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
  projects = new ProjectService(db);
  budgets = new BudgetService(new BudgetRepository(db));

  const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
  employee = org.hire({ name: '李雷', role: '全栈工程师', departmentId: department.id });
  const project = projects.create({ name: '官网改版', code: 'WEB', departmentId: department.id });
  projectId = project.id;
  projects.assign(projectId, employee.id, '前端');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 一笔“派活 → 结算”：返回 F8 的硬停结果。 */
function runTask(input: {
  taskId: string;
  estTokens: number;
  actualTokens: number;
  projectGroupId?: string;
  allowOverdraft?: boolean;
}) {
  budgets.reserve({
    employeeId: employee.id,
    taskId: input.taskId,
    estTokens: input.estTokens,
    departmentId: employee.departmentId,
    ...(input.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
    ...(input.allowOverdraft ? { allowOverdraft: true } : {}),
  });
  return budgets.settle(input.taskId, input.actualTokens, 0);
}

describe('axes', () => {
  it('charges project, department, employee and company for one run', () => {
    runTask({ taskId: 't1', estTokens: 1_000, actualTokens: 800, projectGroupId: projectId });

    const find = (scope: 'project' | 'department' | 'employee' | 'company', id: string) =>
      budgets.list().find((budget) => budget.scope === scope && budget.scopeId === id);

    expect(find('project', projectId)?.usedTokens).toBe(800);
    expect(find('department', employee.departmentId)?.usedTokens).toBe(800);
    expect(find('employee', employee.id)?.usedTokens).toBe(800);
    expect(find('company', 'company-local')?.usedTokens).toBe(800);
    // Every axis is a separate ledger, not a split of 800.
    expect(find('project', projectId)?.reservedTokens).toBe(0);
  });

  it('refuses the whole run when any single axis has no room', () => {
    budgets.setLimit('project', projectId, 500);

    expect(() => runWork()).toThrowError(/预算不足/);

    function runWork() {
      budgets.reserve({
        employeeId: employee.id,
        taskId: 't-too-big',
        estTokens: 1_000,
        projectGroupId: projectId,
        departmentId: employee.departmentId,
      });
    }

    // Nothing was reserved on the axes that *did* have room.
    const project = budgets.list().find((budget) => budget.scope === 'project');
    expect(project?.reservedTokens).toBe(0);
  });
});

describe('alerts', () => {
  it('records warn once, then stop once per month', () => {
    budgets.setLimit('employee', employee.id, 1_000);

    runTask({ taskId: 't-warn', estTokens: 900, actualTokens: 850 });
    expect(budgets.alerts().filter((alert) => alert.level === 'warn')).toHaveLength(1);

    // Second charge inside the warning band must not add another row.
    budgets.reserve({
      employeeId: employee.id,
      taskId: 't-warn-2',
      estTokens: 100,
      allowOverdraft: true,
    });
    budgets.settle('t-warn-2', 100, 0);
    expect(budgets.alerts().filter((alert) => alert.level === 'warn')).toHaveLength(1);

    runTask({ taskId: 't-stop', estTokens: 100, actualTokens: 100, allowOverdraft: true });
    const stops = budgets.alerts().filter((alert) => alert.level === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.scope).toBe('employee');
    expect(stops[0]?.limitTokens).toBe(1_000);
  });
});

describe('hard stop (F8)', () => {
  it('reports the stopped axis so the caller can pause the assignment', () => {
    budgets.setLimit('project', projectId, 1_000);

    // The estimate fits; the real spend crosses the line — that is how a stop
    // actually happens in production.
    const stopped = runTask({ taskId: 't-trip', estTokens: 900, actualTokens: 1_000, projectGroupId: projectId });
    expect(stopped).toEqual([{ scope: 'project', scopeId: projectId }]);

    // §5.6: 停的是任职，不是员工。
    expect(projects.pauseAssignments({ projectId }, 'project_budget_exceeded')).toBe(1);
    const project = projects.list().find((item) => item.id === projectId);
    expect(project?.members[0]).toMatchObject({ status: 'paused', pauseReason: 'project_budget_exceeded' });
    // The person is still employed and still on other work.
    expect(org.everyone().find((member) => member.id === employee.id)?.status).toBe('active');
  });

  it('un-latches the stop when the boss raises the limit, and resumes the assignment', () => {
    budgets.setLimit('project', projectId, 1_000);
    runTask({ taskId: 't-trip', estTokens: 900, actualTokens: 1_000, projectGroupId: projectId });
    projects.pauseAssignments({ projectId }, 'project_budget_exceeded');

    budgets.setLimit('project', projectId, 5_000);
    const project = budgets.list().find((budget) => budget.scope === 'project' && budget.scopeId === projectId);
    // 1000 used of 5000 is 20%: the latch is gone, the axis is healthy again.
    expect(project?.state).toBe('ok');

    expect(projects.resumeAssignments({ projectId }, 'project_budget_exceeded')).toBe(1);
    expect(projects.list().find((item) => item.id === projectId)?.members[0]?.status).toBe('active');
  });

  it('a stopped axis refuses new work until it is topped up', () => {
    budgets.setLimit('employee', employee.id, 1_000);
    runTask({ taskId: 't-trip', estTokens: 900, actualTokens: 1_000 });

    expect(() => runTask({ taskId: 't-next', estTokens: 100, actualTokens: 100 })).toThrowError(
      /预算已停用/,
    );

    budgets.setLimit('employee', employee.id, 10_000);
    expect(() => runTask({ taskId: 't-after', estTokens: 100, actualTokens: 100 })).not.toThrow();
  });
});
