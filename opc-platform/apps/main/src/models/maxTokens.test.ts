import { describe, expect, it } from 'vitest';
import { resolveModelMaxTokens } from './runtime';

describe('resolveModelMaxTokens', () => {
  it('推理模型不再被锁死在 8192，而是分配最高 32768 输出预算', () => {
    expect(resolveModelMaxTokens({ contextWindow: 128_000, reasoning: true })).toBe(32_000);
    expect(resolveModelMaxTokens({ contextWindow: 200_000, reasoning: true })).toBe(32_768);
    expect(resolveModelMaxTokens({ contextWindow: 32_000, reasoning: true })).toBe(16_000);
  });

  it('非推理模型按比例分配且默认可达 16384', () => {
    expect(resolveModelMaxTokens({ contextWindow: 128_000, reasoning: false })).toBe(16_000);
    expect(resolveModelMaxTokens({ contextWindow: 200_000, reasoning: false })).toBe(16_384);
    expect(resolveModelMaxTokens({ contextWindow: 32_000, reasoning: false })).toBe(4_096);
  });

  it('存在内置 catalog maxTokens 时尊重且不超过 contextWindow 一半', () => {
    expect(
      resolveModelMaxTokens({ contextWindow: 200_000, reasoning: true, builtinMaxTokens: 64_000 }),
    ).toBe(64_000);
    expect(
      resolveModelMaxTokens({ contextWindow: 64_000, reasoning: true, builtinMaxTokens: 64_000 }),
    ).toBe(32_000);
  });
});
