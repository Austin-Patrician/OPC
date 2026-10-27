import type { BudgetState } from '@opc/shared/domain';

export interface BudgetSnapshot {
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  warnAt: number;
  hardStopAt: number;
  isStopped: boolean;
}

export interface BudgetEvaluation {
  state: BudgetState;
  availableTokens: number;
  usedRatio: number;
  /** Tokens still free after honouring a new reservation. */
  remainingAfter: number;
  canReserve: (requestedTokens: number) => boolean;
}

/**
 * Pure budget math. Kept out of SQLite so the rules are testable and identical
 * for every scope (company / employee / department / project later).
 *
 * Rules:
 *  - available = limit − used − reserved (never negative)
 *  - a reservation is admitted only when available ≥ requested
 *  - `is_stopped` refuses everything (hard stop already tripped)
 *  - `warn` is advisory only: it never blocks
 */
export interface BudgetForecast {
  /** Straight-line projection to the end of the period (today's rate × days). */
  projectedTokens: number;
  willExceed: boolean;
  /** Days of the period already spent, never 0 (day 1 counts as one). */
  elapsedDays: number;
  daysInPeriod: number;
}

/**
 * §8.3 预算预测: 按当前速度跑到月末会用多少。
 *
 * A straight line, not a curve on purpose: on day 2 the honest answer is "if we keep
 * this pace". `willExceed` is the only thing the UI needs to say out loud; the number
 * itself is shown so the boss can disagree with it.
 */
export function forecastPeriod(input: {
  usedTokens: number;
  limitTokens: number;
  periodKey: string;
  now: number;
}): BudgetForecast {
  const current = periodKeyOf(input.now);
  if (input.periodKey !== current) {
    // A past or future period: no pace to extrapolate from.
    return {
      projectedTokens: input.usedTokens,
      willExceed: input.usedTokens >= input.limitTokens,
      elapsedDays: 0,
      daysInPeriod: 0,
    };
  }

  const date = new Date(input.now);
  const daysInPeriod = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const elapsedDays = Math.max(1, date.getDate());
  const rate = input.usedTokens / elapsedDays;
  const projectedTokens = Math.round(rate * daysInPeriod);

  return {
    projectedTokens,
    willExceed: projectedTokens > input.limitTokens,
    elapsedDays,
    daysInPeriod,
  };
}

/** `YYYY-MM`, matching `budget_period` rows written by the repository. */
export function periodKeyOf(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function evaluateBudget(snapshot: BudgetSnapshot): BudgetEvaluation {
  const availableTokens = Math.max(
    0,
    snapshot.limitTokens - snapshot.usedTokens - snapshot.reservedTokens,
  );
  const usedRatio = snapshot.limitTokens <= 0 ? 1 : snapshot.usedTokens / snapshot.limitTokens;

  const state: BudgetState = snapshot.isStopped
    ? 'stopped'
    : usedRatio >= snapshot.hardStopAt
      ? 'stopped'
      : usedRatio >= snapshot.warnAt
        ? 'warn'
        : 'ok';

  return {
    state,
    availableTokens,
    usedRatio,
    remainingAfter: availableTokens,
    canReserve: (requestedTokens: number) =>
      !snapshot.isStopped &&
      usedRatio < snapshot.hardStopAt &&
      requestedTokens > 0 &&
      availableTokens >= requestedTokens,
  };
}
