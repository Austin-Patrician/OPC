import { describe, expect, it } from 'vitest';
import { matchBuiltinModel, normalizeModelId, type BuiltinModelEntry } from './pricingMatch';

const entry = (providerId: string, modelId: string): BuiltinModelEntry => ({
  providerId,
  modelId,
  inputUsdPerM: 1,
  outputUsdPerM: 2,
  cacheReadUsdPerM: 0.1,
  cacheWriteUsdPerM: 0.2,
});

describe('model id normalisation', () => {
  it('strips vendor prefixes, dates and variant suffixes', () => {
    expect(normalizeModelId('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(normalizeModelId('gpt-4o-latest')).toBe('gpt-4o');
    expect(normalizeModelId('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe('claude-3-5-sonnet');
    expect(normalizeModelId('gpt-4o@2024-08-06')).toBe('gpt-4o');
  });

  it('keeps meaningful version numbers', () => {
    expect(normalizeModelId('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
  });
});

describe('builtin matching', () => {
  const catalogue = [entry('openai', 'gpt-4o'), entry('anthropic', 'claude-sonnet-4-5')];

  it('prefers the same provider and id', () => {
    expect(matchBuiltinModel(catalogue, { providerId: 'openai', modelId: 'gpt-4o' })?.providerId).toBe('openai');
  });

  it('falls back to the same id on another provider (one model, many gateways)', () => {
    expect(
      matchBuiltinModel(catalogue, { providerId: 'my-gateway', modelId: 'gpt-4o' })?.providerId,
    ).toBe('openai');
  });

  it('matches through normalisation', () => {
    expect(
      matchBuiltinModel(catalogue, { providerId: 'my-gateway', modelId: 'openai/gpt-4o-2024-08-06' })?.modelId,
    ).toBe('gpt-4o');
  });

  it('returns undefined instead of guessing', () => {
    expect(matchBuiltinModel(catalogue, { providerId: 'x', modelId: 'totally-new-model' })).toBeUndefined();
  });
});
