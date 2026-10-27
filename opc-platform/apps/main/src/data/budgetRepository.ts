import type { Budget, BudgetScope } from '@opc/shared/domain';
import crypto from 'node:crypto';
import { evaluateBudget } from '../work/budgetMath';
import type { CompanyDatabase } from './companyDatabase';
import { COMPANY_ID } from './schema';

/**
 * Why the data layer imports from `work/`: `evaluateBudget` is pure arithmetic over
 * a snapshot (no IO, no imports beyond the shared types), so the brake rule lives in
 * one place instead of being re-derived by the repository. The dependency arrow is
 * data → pure rule, never data → service.
 */

/** Defaults are deliberately finite: an unbounded employee is a billing incident. */
const WARN_AT = 0.8;
const HARD_STOP_AT = 1;

interface BudgetRow {
  id: string;
  scope: string;
  scope_id: string;
  period_key: string;
  limit_tokens: number;
  used_tokens: number;
  reserved_tokens: number;
  warn_at: number;
  hard_stop_at: number;
  is_stopped: number;
  updated_at: number;
}

interface ReservationRow {
  id: string;
  budget_id: string;
  task_id: string;
  employee_id: string;
  tokens: number;
  expires_at: number;
}

/** The two axes that can pause a person's work when they trip (§5.6). */
export interface StoppedBudget {
  scope: BudgetScope;
  scopeId: string;
}

export interface BudgetAlertRow {
  id: string;
  budgetId: string;
  scope: BudgetScope;
  scopeId: string;
  periodKey: string;
  level: 'warn' | 'stop';
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  createdAt: number;
}

/** `YYYY-MM` in local time: the budget period the boss thinks in. */
export function budgetPeriodKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Reserve → settle, persisted.
 *
 * `used_tokens` and `reserved_tokens` are running totals; `budget_ledger` is the
 * append-only trail behind them. Both are updated in one transaction, so a crash can
 * never leave money charged without a receipt (§8.1).
 */
export class BudgetRepository {
  constructor(private readonly db: CompanyDatabase) {}

  list = (): Budget[] =>
    (this.db.prepare('SELECT * FROM budget ORDER BY scope, scope_id').all() as BudgetRow[]).map(
      toBudget,
    );

  find = (scope: BudgetScope, scopeId: string, periodKey = budgetPeriodKey()): Budget | undefined => {
    const row = this.db
      .prepare('SELECT * FROM budget WHERE scope = ? AND scope_id = ? AND period_key = ?')
      .get(scope, scopeId, periodKey) as BudgetRow | undefined;
    return row ? toBudget(row) : undefined;
  };

  ensureCompanyBudget = (limitTokens: number): void =>
    this.ensure('company', COMPANY_ID, limitTokens);

  ensureEmployeeBudget = (employeeId: string, limitTokens: number): void =>
    this.ensure('employee', employeeId, limitTokens);

  /** Project budgets are created on first charge, like employees' (§8.1). */
  ensureProjectBudget = (projectGroupId: string, limitTokens: number): void =>
    this.ensure('project', projectGroupId, limitTokens);

  ensureDepartmentBudget = (departmentId: string, limitTokens: number): void =>
    this.ensure('department', departmentId, limitTokens);

  /**
   * Reserve across every axis in one transaction.
   *
   * Admission is checked by the caller (`BudgetService`) for all axes *before* any
   * reservation is written, so a task is never half-charged.
   */
  reserve = (input: {
    budgets: readonly Budget[];
    taskId: string;
    employeeId: string;
    tokens: number;
    expiresAt: number;
  }): void => {
    if (input.budgets.length === 0) return;
    const now = Date.now();
    const run = this.db.transaction(() => {
      for (const budget of input.budgets) {
        this.db
          .prepare(
            `INSERT INTO budget_reservation (id, budget_id, task_id, employee_id, tokens, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `res-${crypto.randomUUID()}`,
            budget.id,
            input.taskId,
            input.employeeId,
            input.tokens,
            input.expiresAt,
            now,
          );
        this.db
          .prepare('UPDATE budget SET reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE id = ?')
          .run(input.tokens, now, budget.id);
        this.ledger(budget, {
          taskId: input.taskId,
          employeeId: input.employeeId,
          tokens: input.tokens,
          costUsd: 0,
          kind: 'reserve',
          at: now,
        });
      }
    });
    run();
  };

  /**
   * Charge what was actually spent and give the reservation back.
   *
   * `actualTokens` is charged to *every* budget that held a reservation for this
   * task: employee, project, department and company spend are independent axes over
   * the same run, not a split of one number.
   *
   * Returns the axes that tripped their hard stop, so the caller can apply F8
   * (pause the assignment) — a budget stop is not just a refusal, it is a state.
   */
  settle = (taskId: string, actualTokens: number, costUsd = 0): StoppedBudget[] => {
    const reservations = this.reservationsFor(taskId);
    if (reservations.length === 0) return [];
    const now = Date.now();
    const stopped: StoppedBudget[] = [];

    const run = this.db.transaction(() => {
      for (const reservation of reservations) {
        this.db.prepare('DELETE FROM budget_reservation WHERE id = ?').run(reservation.id);
        this.db
          .prepare(
            `UPDATE budget SET
               reserved_tokens = MAX(0, reserved_tokens - ?),
               used_tokens = used_tokens + ?,
               is_stopped = CASE WHEN used_tokens + ? >= limit_tokens * hard_stop_at THEN 1 ELSE is_stopped END,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(reservation.tokens, actualTokens, actualTokens, now, reservation.budget_id);

        const row = this.db
          .prepare('SELECT * FROM budget WHERE id = ?')
          .get(reservation.budget_id) as BudgetRow | undefined;
        if (!row) continue;
        const budget = toBudget(row);
        this.ledger(budget, {
          taskId,
          employeeId: reservation.employee_id,
          tokens: actualTokens,
          costUsd,
          kind: 'settle',
          at: now,
        });
        // Thresholds are recorded here, at the only moment they can change.
        this.recordAlerts(budget, now);
        if (budget.isStopped) stopped.push({ scope: budget.scope, scopeId: budget.scopeId });
      }
    });
    run();
    return stopped;
  };

  /** Frees every reservation this task holds; used whenever work does not deliver. */
  release = (taskId: string): void => {    const reservations = this.reservationsFor(taskId);
    if (reservations.length === 0) return;
    const now = Date.now();

    const run = this.db.transaction(() => {
      for (const reservation of reservations) {
        this.db.prepare('DELETE FROM budget_reservation WHERE id = ?').run(reservation.id);
        this.db
          .prepare(
            `UPDATE budget SET reserved_tokens = MAX(0, reserved_tokens - ?), updated_at = ? WHERE id = ?`,
          )
          .run(reservation.tokens, now, reservation.budget_id);

        const row = this.db
          .prepare('SELECT * FROM budget WHERE id = ?')
          .get(reservation.budget_id) as BudgetRow | undefined;
        if (!row) continue;
        this.ledger(toBudget(row), {
          taskId,
          employeeId: reservation.employee_id,
          tokens: reservation.tokens,
          costUsd: 0,
          kind: 'release',
          at: now,
        });
      }
    });
    run();
  };

  /**
   * Reclaims reservations whose task is gone or whose expiry passed. Without this a
   * crash mid-run would consume quota forever (§2.4, risk R2).
   */
  releaseOrphans = (isLive: (taskId: string) => boolean, now = Date.now()): number => {
    const rows = this.db.prepare('SELECT id, budget_id, task_id, employee_id, tokens, expires_at FROM budget_reservation').all() as ReservationRow[];
    const stale = rows.filter((row) => row.expires_at <= now || !isLive(row.task_id));

    for (const reservation of stale) {
      // `release` works per task, so a task with several budgets is freed once.
      this.release(reservation.task_id);
    }
    return new Set(stale.map((row) => row.task_id)).size;
  };

  private ensure = (scope: BudgetScope, scopeId: string, limitTokens: number): void => {
    const periodKey = budgetPeriodKey();
    const existing = this.db
      .prepare('SELECT id FROM budget WHERE scope = ? AND scope_id = ? AND period_key = ?')
      .get(scope, scopeId, periodKey);
    if (existing) return;

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO budget (id, scope, scope_id, period_key, limit_tokens, used_tokens, reserved_tokens,
                             warn_at, hard_stop_at, is_stopped, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)
         ON CONFLICT(scope, scope_id, period_key) DO NOTHING`,
      )
      .run(
        `budget-${scope}-${scopeId}-${periodKey}`,
        scope,
        scopeId,
        periodKey,
        Math.max(1, Math.round(limitTokens)),
        WARN_AT,
        HARD_STOP_AT,
        now,
        now,
      );
  };

  /** Open alerts, newest first: what the boss has not seen yet. */
  alerts = (limit = 40): BudgetAlertRow[] => {
    const rows = this.db
      .prepare(
        `SELECT id, scope, scope_id, period_key, level, used_tokens, limit_tokens, ratio, created_at
           FROM budget_alert ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      budget_id: string;
      scope: string;
      scope_id: string;
      period_key: string;
      level: string;
      used_tokens: number;
      limit_tokens: number;
      ratio: number;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      budgetId: row.budget_id,
      scope: row.scope as BudgetScope,
      scopeId: row.scope_id,
      periodKey: row.period_key,
      level: row.level as 'warn' | 'stop',
      usedTokens: row.used_tokens,
      limitTokens: row.limit_tokens,
      ratio: row.ratio,
      createdAt: row.created_at,
    }));
  };

  /**
   * 老板调整额度。Raising the limit **un-latches** a stop when the ratio falls back
   * under the threshold: `is_stopped` is a state, not a scar, and the whole point of
   * topping up is to let the person work again.
   */
  setLimit = (scope: BudgetScope, scopeId: string, limitTokens: number): void => {
    const limit = Math.max(1, Math.round(limitTokens));
    this.db
      .prepare(
        `UPDATE budget SET
           limit_tokens = ?,
           is_stopped = CASE WHEN used_tokens + reserved_tokens >= ? * hard_stop_at THEN 1 ELSE 0 END,
           updated_at = ?
         WHERE scope = ? AND scope_id = ? AND period_key = ?`,
      )
      .run(limit, limit, Date.now(), scope, scopeId, budgetPeriodKey());
  };

  /**
   * Records a threshold crossing once per level per month. Deduplicated by the unique
   * index rather than by a read: two charges in the same millisecond must not both
   * write a warn.
   */
  private recordAlerts(budget: Budget, now: number): void {
    const evaluation = evaluateBudget(budget);
    const ratio = evaluation.usedRatio;
    const level = budget.state === 'stopped' ? 'stop' : budget.state === 'warn' ? 'warn' : undefined;
    if (!level) return;

    this.db
      .prepare(
        `INSERT INTO budget_alert (id, budget_id, scope, scope_id, period_key, level,
                                   used_tokens, limit_tokens, ratio, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(budget_id, level, period_key) DO NOTHING`,
      )
      .run(
        `alert-${crypto.randomUUID()}`,
        budget.id,
        budget.scope,
        budget.scopeId,
        budget.periodKey,
        level,
        budget.usedTokens,
        budget.limitTokens,
        ratio,
        now,
      );
  }

  private reservationsFor(taskId: string): ReservationRow[] {    return this.db
      .prepare('SELECT id, budget_id, task_id, employee_id, tokens, expires_at FROM budget_reservation WHERE task_id = ?')
      .all(taskId) as ReservationRow[];
  }

  private ledger(
    budget: Budget,
    entry: {
      taskId: string;
      employeeId: string;
      tokens: number;
      costUsd: number;
      kind: 'reserve' | 'settle' | 'release';
      at: number;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO budget_ledger (id, budget_id, scope, scope_id, task_id, employee_id, tokens, cost_usd, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `ledger-${crypto.randomUUID()}`,
        budget.id,
        budget.scope,
        budget.scopeId,
        entry.taskId,
        entry.employeeId,
        Math.round(entry.tokens),
        entry.costUsd,
        entry.kind,
        entry.at,
      );
  }
}

function toBudget(row: BudgetRow): Budget {
  const evaluation = evaluateBudget({
    limitTokens: row.limit_tokens,
    usedTokens: row.used_tokens,
    reservedTokens: row.reserved_tokens,
    warnAt: row.warn_at,
    hardStopAt: row.hard_stop_at,
    isStopped: row.is_stopped === 1,
  });

  return {
    id: row.id,
    scope: row.scope as BudgetScope,
    scopeId: row.scope_id,
    periodKey: row.period_key,
    limitTokens: row.limit_tokens,
    usedTokens: row.used_tokens,
    reservedTokens: row.reserved_tokens,
    availableTokens: evaluation.availableTokens,
    warnAt: row.warn_at,
    hardStopAt: row.hard_stop_at,
    isStopped: row.is_stopped === 1,
    state: evaluation.state,
    updatedAt: row.updated_at,
  };
}
