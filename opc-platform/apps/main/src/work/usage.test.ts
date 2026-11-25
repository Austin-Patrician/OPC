import { describe, expect, it } from 'vitest';
import {
  calculateTokenCost,
  diffCostBreakdown,
  diffTokenDetails,
  resolveChargedCost,
} from './usage';

describe('usage accounting helpers', () => {
  it('separates provider-billed cost from local/catalog cost deltas', () => {
    const before = {
      models: {
        'openrouter/openai/gpt-4o': {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          cost: { total: 0.002, totalFromProvider: true },
        },
        'relay/custom': {
          input: 50,
          output: 10,
          cost: { total: 0.001, totalFromProvider: false },
        },
      },
    };
    const after = {
      models: {
        'openrouter/openai/gpt-4o': {
          input: 1100,
          output: 220,
          cacheRead: 110,
          cacheWrite: 50,
          reasoning: 30,
          cost: { total: 0.012, totalFromProvider: true },
        },
        'relay/custom': {
          input: 250,
          output: 60,
          cost: { total: 0.004, totalFromProvider: false },
        },
      },
    };

    expect(diffTokenDetails(before, after)).toEqual({
      input: 1200,
      output: 250,
      cacheRead: 100,
      cacheWrite: 50,
      reasoning: 30,
      total: 1600,
    });

    const cost = diffCostBreakdown(before, after);
    expect(cost.providerCostUsd).toBeCloseTo(0.01, 10);
    expect(cost.configuredCostUsd).toBeCloseTo(0.003, 10);
    expect(cost.totalCostUsd).toBeCloseTo(0.013, 10);
  });

  it('computes token cost with cache rates and falls back safely to input rate', () => {
    const cost = calculateTokenCost(
      { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 },
      { inputUsdPerM: 3, outputUsdPerM: 15, cacheReadUsdPerM: 0.3, cacheWriteUsdPerM: 3.75 },
    );
    expect(cost).toBeCloseTo(3 + 7.5 + 0.6 + 0.375, 10);

    expect(calculateTokenCost({ input: 1000, output: 500 }, { inputUsdPerM: 0, outputUsdPerM: 0 })).toBe(0);
    expect(calculateTokenCost({ input: 1000, output: 500 }, undefined)).toBe(0);
  });

  it('resolves charged cost according to PricingMode policy', () => {
    expect(resolveChargedCost('provider_first', 0.02, 0.05)).toEqual({
      chargedCostUsd: 0.02,
      costSource: 'provider',
    });
    expect(resolveChargedCost('provider_first', undefined, 0.05)).toEqual({
      chargedCostUsd: 0.05,
      costSource: 'configured',
    });
    expect(resolveChargedCost('provider_only', undefined, 0.05)).toEqual({
      costSource: 'unpriced',
    });
    expect(resolveChargedCost('configured_only', 0.02, 0.05)).toEqual({
      chargedCostUsd: 0.05,
      costSource: 'configured',
    });
    expect(resolveChargedCost('provider_first', undefined, undefined)).toEqual({
      costSource: 'unpriced',
    });
  });
});
