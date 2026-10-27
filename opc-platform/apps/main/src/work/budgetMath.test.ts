import { describe, expect, it } from 'vitest';
import { evaluateBudget, forecastPeriod } from './budgetMath';

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

describe('forecastPeriod', () => {
  it('projects straight to the end of the month from today\'s pace', () => {
    const now = new Date(2025, 0, 10, 12).getTime(); // 10 Jan, 31-day month
    const forecast = forecastPeriod({
      usedTokens: 100_000,
      limitTokens: 500_000,
      periodKey: '2025-01',
      now,
    });

    // 100k over 10 days → 310k over 31 days.
    expect(forecast.elapsedDays).toBe(10);
    expect(forecast.daysInPeriod).toBe(31);
    expect(forecast.projectedTokens).toBe(310_000);
    expect(forecast.willExceed).toBe(false);
  });

  it('flags an overrun, and does not claim a pace for another period', () => {
    const now = new Date(2025, 0, 20, 12).getTime();
    expect(
      forecastPeriod({ usedTokens: 400_000, limitTokens: 500_000, periodKey: '2025-01', now })
        .willExceed,
    ).toBe(true);

    // A past period has no pace: the answer is what was spent, nothing more.
    const past = forecastPeriod({
      usedTokens: 400_000,
      limitTokens: 500_000,
      periodKey: '2024-12',
      now,
    });
    expect(past.projectedTokens).toBe(400_000);
    expect(past.elapsedDays).toBe(0);
  });

  it('treats day one as one day, never divides by zero', () => {
    const now = new Date(2025, 1, 1, 1).getTime(); // 1 Feb, 28-day month
    const forecast = forecastPeriod({ usedTokens: 5_000, limitTokens: 100_000, periodKey: '2025-02', now });
    expect(forecast.elapsedDays).toBe(1);
    expect(forecast.daysInPeriod).toBe(28);
    expect(forecast.projectedTokens).toBe(140_000);
    expect(forecast.willExceed).toBe(true);
  });
});
