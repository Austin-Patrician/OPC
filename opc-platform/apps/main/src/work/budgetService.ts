import type { Budget, BudgetErrorCode } from '@opc/shared/domain';
import { evaluateBudget } from './budgetMath';
import type { BudgetRepository } from '../data/budgetRepository';

/** Defaults are deliberately finite: an unbounded employee is a billing incident. */
const DEFAULT_COMPANY_LIMIT = 5_000_000;
const DEFAULT_EMPLOYEE_LIMIT = 300_000;

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

  ensureForEmployee(employeeId: string): void {
    this.repository.ensureCompanyBudget(readLimit('OPC_BUDGET_COMPANY_LIMIT', DEFAULT_COMPANY_LIMIT));
    this.repository.ensureEmployeeBudget(
      employeeId,
      readLimit('OPC_BUDGET_EMPLOYEE_LIMIT', DEFAULT_EMPLOYEE_LIMIT),
    );
  }

  list = (): Budget[] => this.repository.list();

  employeeBudget(employeeId: string): Budget | undefined {
    this.ensureForEmployee(employeeId);
    return this.repository.find('employee', employeeId);
  }

  /** Throws `BudgetBlockedError` when any charged scope refuses the reservation. */
  /**
   * `allowOverdraft` is for mandatory system steps (manager sign-off): the
   * reservation is still recorded and settled from real usage, but a hard stop
   * does not silently drop the step. Normal work never passes it.
   */
  reserve(input: { employeeId: string; taskId: string; estTokens: number; allowOverdraft?: boolean }): void {
    this.ensureForEmployee(input.employeeId);

    const scopes: Budget[] = [];
    const employee = this.repository.find('employee', input.employeeId);
    const company = this.repository.find('company', 'company-local');
    if (employee) scopes.push(employee);
    if (company) scopes.push(company);

    for (const budget of scopes) {
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

    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    for (const budget of scopes) {
      this.repository.reserve({
        budget,
        taskId: input.taskId,
        employeeId: input.employeeId,
        tokens: input.estTokens,
        expiresAt,
      });
    }
  }

  settle(taskId: string, actualTokens: number, costUsd = 0): void {
    this.repository.settle(taskId, actualTokens, costUsd);
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
