/**
 * 用量差分的两件小算术。
 *
 * 抽出来的原因很具体：执行体和它派出去的**子代理**都要记同一笔账。两处各写一遍，
 * 迟早有一处忘了把缓存价算进去——而那种错误在账本上看不出来，只会显得"今天便宜"。
 */

interface UsageLike {
  models?: Record<string, { input: number; output: number; cost?: { total?: number } }>;
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

/** pi 报过钱就用它（它知道缓存价与分档价），没报才按单价算。 */
export function diffCost(before: UsageLike, after: UsageLike): number {
  const sum = (usage: UsageLike) =>
    Object.values(usage.models ?? {}).reduce((total, entry) => total + (entry.cost?.total ?? 0), 0);
  return Math.max(0, sum(after) - sum(before));
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
    reported > 0
      ? reported
      : (delta.input / 1_000_000) * price.inputUsdPerM +
        (delta.output / 1_000_000) * price.outputUsdPerM;
  return { tokens, costUsd };
}
