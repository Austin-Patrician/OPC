import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetRepository } from '../data/budgetRepository';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { OrgService } from '../org/orgService';
import { ProjectService } from '../org/projectService';
import { periodKeyOf } from './budgetMath';
import { BudgetService } from './budgetService';
import { PayrollService } from './payroll';

/**
 * The payroll view is a read model, so these tests are about the three ways such a
 * view lies: double-counting the same run, pricing a cap with no price, and calling a
 * projection a fact.
 */

let dir: string;
let db: CompanyDatabase;
let org: OrgService;
let budgets: BudgetService;
let payroll: PayrollService;

const NOW = Date.UTC(2026, 9, 15, 9, 0, 0); // 2026-10-15, mid-month

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-payroll-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
  budgets = new BudgetService(new BudgetRepository(db));
  payroll = new PayrollService({ db, budgets, org, now: () => NOW });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Writes one settled ledger row on the employee axis, the way a real run would. */
function settle(employeeId: string, tokens: number, costUsd: number, scope: 'employee' | 'company' = 'employee') {
  budgets.ensureForEmployee(employeeId);
  const all = budgets.list();
  const target =
    scope === 'employee'
      ? all.find((entry) => entry.scope === 'employee' && entry.scopeId === employeeId)!
      : all.find((entry) => entry.scope === 'company')!;
  db.prepare(
    `INSERT INTO budget_ledger (id, budget_id, scope, scope_id, task_id, employee_id, tokens, cost_usd, kind, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'settle', ?)`,
  ).run(
    `led-${Math.random().toString(36).slice(2)}`,
    target.id,
    scope,
    target.scopeId,
    employeeId,
    tokens,
    costUsd,
    NOW,
  );
}

/**
 * Settles one run across every axis it would really be charged on, exactly like
 * `BudgetRepository.settle`: the same tokens and money on project, department,
 * employee and company, one ledger row each.
 */
function settleRun(input: {
  employeeId: string;
  departmentId?: string;
  projectId?: string;
  tokens: number;
  costUsd: number;
  at?: number;
}) {
  const at = input.at ?? NOW;
  const axes: { scope: 'employee' | 'department' | 'project' | 'company'; scopeId: string }[] = [
    ...(input.projectId ? [{ scope: 'project' as const, scopeId: input.projectId }] : []),
    ...(input.departmentId ? [{ scope: 'department' as const, scopeId: input.departmentId }] : []),
    { scope: 'employee', scopeId: input.employeeId },
    { scope: 'company', scopeId: 'company-local' },
  ];

  for (const axis of axes) {
    // `ensureFor*` writes the row for the *current* period, which is what the run would
    // have done at the time; `at` only moves the ledger timestamp for the month tests.
    budgets.setLimit(axis.scope, axis.scopeId, 10_000_000);
  }

  const rows = budgets.list();
  for (const axis of axes) {
    const budget = rows.find((row) => row.scope === axis.scope && row.scopeId === axis.scopeId)!;
    db.prepare(
      `INSERT INTO budget_ledger (id, budget_id, scope, scope_id, task_id, employee_id, tokens, cost_usd, kind, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'settle', ?)`,
    ).run(
      `led-${Math.random().toString(36).slice(2)}`,
      budget.id,
      axis.scope,
      axis.scopeId,
      input.employeeId,
      input.tokens,
      input.costUsd,
      at,
    );
  }
}

function team() {
  const department = org.createDepartment({ name: '工程部' });
  const first = org.hire({ name: '李雷', role: '全栈工程师', departmentId: department.id });
  const second = org.hire({ name: '韩梅梅', role: '测试工程师', departmentId: department.id });
  return { department, first, second };
}

describe('payroll', () => {
  it('reports one line per active employee, with the period key', () => {
    const { first, second } = team();

    const view = payroll.overview();

    expect(view.periodKey).toBe(periodKeyOf(NOW));
    expect(view.lines.map((line) => line.employeeId).sort()).toEqual([first.id, second.id].sort());
    expect(view.headcount).toBe(2);
    expect(view.totalSpentUsd).toBe(0);
  });

  it('counts the employee axis once, not once per budget axis', () => {
    const { first } = team();
    // A real run settles four axes with identical numbers; only one of them is this
    // person's own spend, and summing all four would quadruple the bill.
    settle(first.id, 1000, 0.5, 'employee');
    settle(first.id, 1000, 0.5, 'company');

    const view = payroll.overview();
    const line = view.lines.find((entry) => entry.employeeId === first.id)!;

    expect(line.tokensUsed).toBe(1000);
    expect(line.spentUsd).toBeCloseTo(0.5);
    expect(view.totalSpentUsd).toBeCloseTo(0.5);
  });

  it('leaves the money cap unset until there is a price to convert with', () => {
    const { first } = team();
    budgets.setLimit('employee', first.id, 100_000);

    const unpriced = payroll.overview().lines.find((entry) => entry.employeeId === first.id)!;
    // 0 would read as "this person is free"; absent says "not priced yet".
    expect(unpriced.limitTokens).toBe(100_000);
    expect(unpriced.budgetUsd).toBeUndefined();
    expect(unpriced.spentUsd).toBe(0);

    settle(first.id, 10_000, 1.0);
    const priced = payroll.overview().lines.find((entry) => entry.employeeId === first.id)!;
    // 100k tokens at the observed $0.0001/token.
    expect(priced.budgetUsd).toBeCloseTo(10);
  });

  it('labels the month-end number as a projection of the current pace', () => {
    const { first } = team();
    settle(first.id, 10_000, 1.0);

    const line = payroll.overview().lines.find((entry) => entry.employeeId === first.id)!;

    // Day 15 of 31: straight line, so roughly double the spend so far. The token
    // projection is rounded to whole tokens, hence the tolerance.
    expect(line.projectedUsd).toBeGreaterThan(line.spentUsd);
    expect(line.projectedUsd).toBeCloseTo((line.spentUsd / 15) * 31, 2);
  });

  it('shares add up to the company total', () => {
    const { first, second } = team();
    settle(first.id, 3000, 3);
    settle(second.id, 1000, 1);

    const view = payroll.overview();

    expect(view.totalSpentUsd).toBeCloseTo(4);
    expect(view.lines[0]?.employeeId).toBe(first.id); // strongest spender first
    expect(view.lines[0]?.share).toBeCloseTo(0.75);
    expect(view.lines.reduce((sum, line) => sum + line.share, 0)).toBeCloseTo(1);
  });

  it('does not put departed employees on the payroll', () => {
    const { first, second } = team();
    settle(first.id, 500, 0.25);
    org.fire(second.id);

    const view = payroll.overview();

    expect(view.lines.map((line) => line.employeeId)).toEqual([first.id]);
    // Their spend is history, not a line item: the ledger keeps it, the payroll does not.
    expect(view.totalSpentUsd).toBeCloseTo(0.25);
  });

  it('counts only the current month, not every settled row ever written', () => {
    const { first } = team();
    settle(first.id, 1000, 1);

    // A row that belongs to last month: it has its own `budget` row with that period,
    // which is where the month lives — the ledger itself has no period column.
    const now = Date.now();
    db.prepare(
      `INSERT INTO budget (id, scope, scope_id, period_key, limit_tokens, used_tokens,
                           reserved_tokens, warn_at, hard_stop_at, is_stopped, created_at, updated_at)
       VALUES ('budget-last-month', 'employee', ?, '2026-09', 10000000, 5000, 0, 0.8, 1, 0, ?, ?)`,
    ).run(first.id, now, now);
    db.prepare(
      `INSERT INTO budget_ledger (id, budget_id, scope, scope_id, task_id, employee_id, tokens, cost_usd, kind, created_at)
       VALUES ('led-last-month', 'budget-last-month', 'employee', ?, NULL, ?, 5000, 5, 'settle', ?)`,
    ).run(first.id, first.id, Date.UTC(2026, 8, 20));

    const view = payroll.overview();
    const line = view.lines.find((entry) => entry.employeeId === first.id)!;

    // Last month's $5 is not on this month's payroll.
    expect(line.spentUsd).toBeCloseTo(1);
    expect(view.totalSpentUsd).toBeCloseTo(1);
  });
});

describe('cost centres', () => {
  it('reads each axis on its own, never summing the four rows of one run', () => {
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '李雷', role: '全栈工程师', departmentId: department.id });
    const project = new ProjectService(db).create({ name: '结算重构', departmentId: department.id });
    new ProjectService(db).assign(project.id, person.id, '后端');

    // One run: project + department + employee + company, all the same numbers.
    settleRun({ employeeId: person.id, departmentId: department.id, projectId: project.id, tokens: 2000, costUsd: 2 });

    const view = payroll.costCenters();

    // Each view sees the run exactly once.
    expect(view.totalSpentUsd).toBeCloseTo(2);
    expect(view.departments).toHaveLength(1);
    expect(view.departments[0]).toMatchObject({ id: department.id, name: '工程部', kind: 'department' });
    expect(view.departments[0]?.spentUsd).toBeCloseTo(2);
    expect(view.departments[0]?.tokensUsed).toBe(2000);
    expect(view.projects[0]?.spentUsd).toBeCloseTo(2);
    // Four rows on the ledger, but nobody is billed four times.
    expect(view.unattributedDepartmentUsd).toBe(0);
    expect(view.unattributedProjectUsd).toBe(0);
  });

  it('reports spend that no department axis recorded instead of hiding it', () => {
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '李雷', role: '全栈工程师', departmentId: department.id });

    settleRun({ employeeId: person.id, departmentId: department.id, tokens: 1000, costUsd: 1 });
    // A run where the department was not known at settle time (no department axis row).
    settleRun({ employeeId: person.id, tokens: 500, costUsd: 0.5 });

    const view = payroll.costCenters();

    expect(view.totalSpentUsd).toBeCloseTo(1.5);
    expect(view.departments[0]?.spentUsd).toBeCloseTo(1);
    // The 0.5 is visible as unattributed, so the two reports still reconcile.
    expect(view.unattributedDepartmentUsd).toBeCloseTo(0.5);
    expect(view.unattributedProjectUsd).toBeCloseTo(1.5);
  });

  it('keeps an archived department’s spend, labelled with its name', () => {
    const department = org.createDepartment({ name: '旧工程部' });
    const person = org.hire({ name: '李雷', role: '全栈工程师', departmentId: department.id });
    settleRun({ employeeId: person.id, departmentId: department.id, tokens: 1000, costUsd: 1 });
    org.fire(person.id);
    org.archiveDepartment(department.id);

    const line = payroll.costCenters().departments[0]!;

    // Money that was already spent does not disappear because the team was dissolved.
    expect(line.name).toBe('旧工程部');
    expect(line.spentUsd).toBeCloseTo(1);
    expect(line.headcount).toBe(0);
  });

  it('counts the people a cost centre currently holds', () => {
    const department = org.createDepartment({ name: '工程部' });
    const first = org.hire({ name: '甲', role: '工程师', departmentId: department.id });
    org.hire({ name: '乙', role: '工程师', departmentId: department.id });
    const project = new ProjectService(db).create({ name: '重构', departmentId: department.id });
    new ProjectService(db).assign(project.id, first.id, '后端');

    settleRun({ employeeId: first.id, departmentId: department.id, projectId: project.id, tokens: 100, costUsd: 0.1 });

    const view = payroll.costCenters();

    expect(view.departments[0]?.headcount).toBe(2);
    expect(view.projects[0]?.headcount).toBe(1);
  });

  it('prices each cost centre’s cap from its own observed rate', () => {
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '甲', role: '工程师', departmentId: department.id });
    settleRun({ employeeId: person.id, departmentId: department.id, tokens: 1000, costUsd: 2 });

    const line = payroll.costCenters().departments[0]!;

    // 10M tokens at $0.002/token.
    expect(line.budgetUsd).toBeCloseTo(20_000);
    expect(line.projectedUsd).toBeGreaterThan(line.spentUsd);
  });
});
