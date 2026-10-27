import type { Budget, BudgetAlert, BudgetErrorCode, BudgetScope } from '@opc/shared/domain';
import { evaluateBudget } from './budgetMath';
import type { BudgetRepository, StoppedBudget } from '../data/budgetRepository';

/** Defaults are deliberately finite: an unbounded employee is a billing incident. */
const DEFAULT_COMPANY_LIMIT = 5_000_000;
const DEFAULT_EMPLOYEE_LIMIT = 300_000;
/** A project is the axis that actually decides money (§8.1), so it gets a real cap. */
const DEFAULT_PROJECT_LIMIT = 1_000_000;
const DEFAULT_DEPARTMENT_LIMIT = 2_000_000;

/** v1.0 is one company per install (§1.3); its row id is a constant. */
const COMPANY_SCOPE_ID = 'company-local';

/** Which axes one run is charged on. */
export interface BudgetChargeInput {
  employeeId: string;
  taskId: string;
  estTokens: number;
  /** Set when the work belongs to a project (§4.3 assignment). */
  projectGroupId?: string;
  /** The assignee's department; charged when known. */
  departmentId?: string;
  allowOverdraft?: boolean;
}

export class BudgetBlockedError extends Error {
  constructor(
    readonly code: BudgetErrorCode,
    readonly budget: Budget | undefined,
    readonly requestedTokens: number,
  ) {
    super(
      code === 'BUDGET_STOPPED'
        ? `该员工本月预算已停用（${budget?.usedTokens ?? 0}/${budget?.limitTokens ?? 0} tokens）`
        : `预算不足：可用 ${budget?.availableTokens ?? 0}，本次需要 ${requestedTokens}`,
    );
    this.name = 'BudgetBlockedError';
  }
}

/**
 * The brake pedal.
 *
 * Reserve → run → settle. A run is only admitted when every scope it charges has
 * the tokens free, so two concurrent dispatches cannot both spend the last slice.
 */
export class BudgetService {
  constructor(private readonly repository: BudgetRepository) {}

  /** Company + the employee axis. Called on hire and before every charge. */
  ensureForEmployee(employeeId: string): void {
    this.repository.ensureCompanyBudget(readLimit('OPC_BUDGET_COMPANY_LIMIT', DEFAULT_COMPANY_LIMIT));
    this.repository.ensureEmployeeBudget(
      employeeId,
      readLimit('OPC_BUDGET_EMPLOYEE_LIMIT', DEFAULT_EMPLOYEE_LIMIT),
    );
  }

  ensureForProject(projectGroupId: string): void {
    this.repository.ensureProjectBudget(
      projectGroupId,
      readLimit('OPC_BUDGET_PROJECT_LIMIT', DEFAULT_PROJECT_LIMIT),
    );
  }

  ensureForDepartment(departmentId: string): void {
    this.repository.ensureDepartmentBudget(
      departmentId,
      readLimit('OPC_BUDGET_DEPARTMENT_LIMIT', DEFAULT_DEPARTMENT_LIMIT),
    );
  }

  list = (): Budget[] => this.repository.list();

  alerts = (limit = 40): BudgetAlert[] => this.repository.alerts(limit);

  /** 老板调整额度（`setLimit` 会解除已经落下的硬停）。 */
  setLimit = (scope: BudgetScope, scopeId: string, limitTokens: number): void => {
    // The row is created on first charge, so a limit set *before* any spend must
    // create it — otherwise "set a cap up front" silently updates nothing.
    if (scope === 'project') this.ensureForProject(scopeId);
    else if (scope === 'department') this.ensureForDepartment(scopeId);
    else if (scope === 'employee') this.ensureForEmployee(scopeId);
    else this.repository.ensureCompanyBudget(readLimit('OPC_BUDGET_COMPANY_LIMIT', DEFAULT_COMPANY_LIMIT));

    this.repository.setLimit(scope, scopeId, limitTokens);
  };

  employeeBudget(employeeId: string): Budget | undefined {
    this.ensureForEmployee(employeeId);
    return this.repository.find('employee', employeeId);
  }

  /**
   * Every axis this run is charged on, in the order the doc lists them (§8.1):
   * project → department → employee → company. Missing rows are created here, so a
   * new project or department gets its own cap the first time it spends.
   */
  private axesFor(input: BudgetChargeInput): Budget[] {
    this.ensureForEmployee(input.employeeId);
    if (input.projectGroupId) this.ensureForProject(input.projectGroupId);
    if (input.departmentId) this.ensureForDepartment(input.departmentId);

    const axes: Budget[] = [];
    const push = (scope: BudgetScope, scopeId: string | undefined) => {
      if (!scopeId) return;
      const budget = this.repository.find(scope, scopeId);
      if (budget) axes.push(budget);
    };

    push('project', input.projectGroupId);
    push('department', input.departmentId);
    push('employee', input.employeeId);
    push('company', COMPANY_SCOPE_ID);
    return axes;
  }

  /**
   * Throws `BudgetBlockedError` when any charged axis refuses the reservation.
   *
   * Every axis is checked before any is written: a task must never be admitted
   * because only the project axis happened to have room.
   *
   * `allowOverdraft` is for mandatory system steps (manager sign-off): the
   * reservation is still recorded and settled from real usage, but a hard stop does
   * not silently drop the step. Normal work never passes it.
   */
  reserve(input: BudgetChargeInput): void {
    const axes = this.axesFor(input);

    for (const budget of axes) {
      // `state` folds the latched flag and the used-ratio threshold together, so a
      // spent month reports "stopped" rather than a vague "not enough tokens".
      const evaluation = evaluateBudget(budget);
      if (input.allowOverdraft) continue;
      if (evaluation.state === 'stopped') {
        throw new BudgetBlockedError('BUDGET_STOPPED', budget, input.estTokens);
      }
      if (!evaluation.canReserve(input.estTokens)) {
        throw new BudgetBlockedError('BUDGET_EXCEEDED', budget, input.estTokens);
      }
    }

    this.repository.reserve({
      budgets: axes,
      taskId: input.taskId,
      employeeId: input.employeeId,
      tokens: input.estTokens,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }

  /**
   * Charge real usage. The return value is F8: the axes that are now hard-stopped,
   * which the caller turns into "pause the assignment, not the employee" (§5.6).
   */
  settle(taskId: string, actualTokens: number, costUsd = 0): StoppedBudget[] {
    return this.repository.settle(taskId, actualTokens, costUsd);
  }

  release(taskId: string): void {
    this.repository.release(taskId);
  }

  /**
   * Releases every reservation whose task is no longer live (or that outlived its
   * expiry). Returns how many were freed.
   */
  releaseOrphans(isLive: (taskId: string) => boolean): number {
    return this.repository.releaseOrphans(isLive);
  }
}

function readLimit(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}
