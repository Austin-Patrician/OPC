/**
 * 用量差分的两件小算术。
 *
 * 抽出来的原因很具体：执行体和它派出去的**子代理**都要记同一笔账。两处各写一遍，
 * 迟早有一处忘了把缓存价算进去——而那种错误在账本上看不出来，只会显得"今天便宜"。
 */

import type { PricingMode } from '@opc/shared/domain';

interface UsageModelEntryLike {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    totalFromProvider?: boolean;
  };
}

interface UsageLike {
  models?: Record<string, UsageModelEntryLike>;
}

/** pi 的 usage 是按 provider/model 累计的，只能取两次快照的差。 */
export function diffUsage(
  before: UsageLike,
  after: UsageLike,
): { input: number; output: number } {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce(
      (total, entry) => ({ input: total.input + entry.input, output: total.output + entry.output }),
      { input: 0, output: 0 },
    );
  const from = sum(before);
  const to = sum(after);
  return {
    input: Math.max(0, to.input - from.input),
    output: Math.max(0, to.output - from.output),
  };
}

/** 两次快照之间的完整 token 差分（含缓存与推理 token）。 */
export function diffTokenDetails(
  before: UsageLike,
  after: UsageLike,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
} {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
    }>(
      (acc, entry) => ({
        input: acc.input + (entry.input ?? 0),
        output: acc.output + (entry.output ?? 0),
        cacheRead: acc.cacheRead + (entry.cacheRead ?? 0),
        cacheWrite: acc.cacheWrite + (entry.cacheWrite ?? 0),
        reasoning: acc.reasoning + (entry.reasoning ?? 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    );
  const from = sum(before);
  const to = sum(after);
  const input = Math.max(0, to.input - from.input);
  const output = Math.max(0, to.output - from.output);
  const cacheRead = Math.max(0, to.cacheRead - from.cacheRead);
  const cacheWrite = Math.max(0, to.cacheWrite - from.cacheWrite);
  const reasoning = Math.max(0, to.reasoning - from.reasoning);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: input + output + cacheRead + cacheWrite,
  };
}

/** pi 报过钱就用它（它知道缓存价与分档价），没报才按单价算。 */
export function diffCost(before: UsageLike, after: UsageLike): number {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce((total, entry) => total + (entry.cost?.total ?? 0), 0);
  return Math.max(0, sum(after) - sum(before));
}

/** 区分服务商真实计费金额（totalFromProvider === true）与本地/内置单价估算金额。 */
export function diffCostBreakdown(
  before: UsageLike,
  after: UsageLike,
): { providerCostUsd: number; configuredCostUsd: number; totalCostUsd: number } {
  let providerCostUsd = 0;
  let configuredCostUsd = 0;
  for (const [key, afterEntry] of Object.entries(after.models ?? {})) {
    const beforeCost = before.models?.[key]?.cost?.total ?? 0;
    const afterCost = afterEntry.cost?.total ?? 0;
    const delta = Math.max(0, afterCost - beforeCost);
    if (delta <= 0) continue;
    if (afterEntry.cost?.totalFromProvider === true) {
      providerCostUsd += delta;
    } else {
      configuredCostUsd += delta;
    }
  }
  return {
    providerCostUsd,
    configuredCostUsd,
    totalCostUsd: providerCostUsd + configuredCostUsd,
  };
}

export interface TokenPricingRates {
  inputUsdPerM?: number;
  outputUsdPerM?: number;
  cacheReadUsdPerM?: number;
  cacheWriteUsdPerM?: number;
}

/** 根据百万 token 单价计算费用，未配置单价或非正数时返回 0。 */
export function calculateTokenCost(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  price: TokenPricingRates | undefined,
): number {
  if (!price) return 0;
  const inRate = price.inputUsdPerM ?? 0;
  const outRate = price.outputUsdPerM ?? 0;
  const crRate = price.cacheReadUsdPerM ?? inRate;
  const cwRate = price.cacheWriteUsdPerM ?? inRate;
  const total =
    ((tokens.input ?? 0) * inRate +
      (tokens.output ?? 0) * outRate +
      (tokens.cacheRead ?? 0) * crRate +
      (tokens.cacheWrite ?? 0) * cwRate) /
    1_000_000;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** 按全局计价策略（服务商优先 / 仅服务商 / 仅本地单价）解析最终计费金额与来源。 */
export function resolveChargedCost(
  mode: PricingMode,
  providerCostUsd: number | undefined,
  configuredCostUsd: number | undefined,
): { chargedCostUsd?: number; costSource: 'provider' | 'configured' | 'unpriced' } {
  const provider =
    providerCostUsd !== undefined && Number.isFinite(providerCostUsd) && providerCostUsd > 0
      ? providerCostUsd
      : undefined;
  const configured =
    configuredCostUsd !== undefined && Number.isFinite(configuredCostUsd) && configuredCostUsd > 0
      ? configuredCostUsd
      : undefined;
  const chargedCostUsd =
    mode === 'provider_only'
      ? provider
      : mode === 'configured_only'
        ? configured
        : (provider ?? configured);
  const costSource =
    chargedCostUsd === undefined
      ? 'unpriced'
      : chargedCostUsd === provider && provider !== undefined
        ? 'provider'
        : 'configured';
  return {
    ...(chargedCostUsd !== undefined ? { chargedCostUsd } : {}),
    costSource,
  };
}

/** 一次调用的钱：pi 报的就用 pi 的，否则按配置的单价算。 */
export function priceUsage(
  before: UsageLike,
  after: UsageLike,
  price: { inputUsdPerM: number; outputUsdPerM: number },
): { tokens: number; costUsd: number } {
  const delta = diffUsage(before, after);
  const tokens = delta.input + delta.output;
  const reported = diffCost(before, after);
  const costUsd =
    reported > 0 ? reported : calculateTokenCost(delta, price);
  return { tokens, costUsd };
}
