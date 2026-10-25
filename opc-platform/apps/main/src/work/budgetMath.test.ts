import { describe, expect, it } from 'vitest';
import { evaluateBudget } from './budgetMath';

const base = {
  limitTokens: 10_000,
  usedTokens: 0,
  reservedTokens: 0,
  warnAt: 0.8,
  hardStopAt: 1,
  isStopped: false,
};

describe('evaluateBudget', () => {
  it('admits a reservation only when the tokens are free', () => {
    const budget = evaluateBudget({ ...base, reservedTokens: 4_000 });

    expect(budget.availableTokens).toBe(6_000);
    expect(budget.canReserve(6_000)).toBe(true);
    expect(budget.canReserve(6_001)).toBe(false);
    expect(budget.availableTokens).toBe(6_000);
  });

  it('treats used + reserved as spent (no double counting)', () => {
    const budget = evaluateBudget({ ...base, usedTokens: 7_000, reservedTokens: 2_000 });
    expect(budget.availableTokens).toBe(1_000);
    expect(budget.canReserve(1_000)).toBe(true);
    expect(budget.canReserve(1_001)).toBe(false);
  });

  it('never reports negative availability', () => {
    const budget = evaluateBudget({ ...base, usedTokens: 12_000 });
    expect(budget.availableTokens).toBe(0);
    expect(budget.canReserve(1)).toBe(false);
  });

  it('warns at the threshold without blocking', () => {
    const budget = evaluateBudget({ ...base, usedTokens: 8_500 });
    expect(budget.state).toBe('warn');
    expect(budget.canReserve(1_000)).toBe(true);
  });

  it('stops at the hard-stop ratio and stays stopped once latched', () => {
    expect(evaluateBudget({ ...base, usedTokens: 10_000 }).state).toBe('stopped');
    expect(evaluateBudget({ ...base, usedTokens: 10_000 }).canReserve(1)).toBe(false);

    const latched = evaluateBudget({ ...base, usedTokens: 0, isStopped: true });
    expect(latched.state).toBe('stopped');
    expect(latched.canReserve(1)).toBe(false);
  });

  it('refuses zero or negative requests', () => {
    const budget = evaluateBudget(base);
    expect(budget.canReserve(0)).toBe(false);
    expect(budget.canReserve(-100)).toBe(false);
  });
});
