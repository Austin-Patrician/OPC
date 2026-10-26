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

  reserve = (input: {
    budget: Budget;
    taskId: string;
    employeeId: string;
    tokens: number;
    expiresAt: number;
  }): void => {
    const now = Date.now();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO budget_reservation (id, budget_id, task_id, employee_id, tokens, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `res-${crypto.randomUUID()}`,
          input.budget.id,
          input.taskId,
          input.employeeId,
          input.tokens,
          input.expiresAt,
          now,
        );
      this.db
        .prepare('UPDATE budget SET reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE id = ?')
        .run(input.tokens, now, input.budget.id);
      this.ledger(input.budget, {
        taskId: input.taskId,
        employeeId: input.employeeId,
        tokens: input.tokens,
        costUsd: 0,
        kind: 'reserve',
        at: now,
      });
    });
    run();
  };

  /**
   * Charge what was actually spent and give the reservation back.
   *
   * `actualTokens` is charged to *every* budget that held a reservation for this
   * task: company and employee spend are two independent axes over the same run,
   * not a split of one number.
   */
  settle = (taskId: string, actualTokens: number, costUsd = 0): void => {
    const reservations = this.reservationsFor(taskId);
    if (reservations.length === 0) return;
    const now = Date.now();

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
        this.ledger(toBudget(row), {
          taskId,
          employeeId: reservation.employee_id,
          tokens: actualTokens,
          costUsd,
          kind: 'settle',
          at: now,
        });
      }
    });
    run();
  };

  /** Frees every reservation this task holds; used whenever work does not deliver. */
  release = (taskId: string): void => {
    const reservations = this.reservationsFor(taskId);
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

  private reservationsFor(taskId: string): ReservationRow[] {
    return this.db
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
