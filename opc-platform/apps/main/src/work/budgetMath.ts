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
