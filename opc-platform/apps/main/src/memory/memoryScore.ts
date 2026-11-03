/**
 * Pure retrieval maths, so ranking is testable without a database and stays
 * swappable: today lexical scoring, tomorrow vector similarity feeding the same
 * scoring function.
 */
export interface MemoryCandidate {
  id: string;
  content: string;
  kind: string;
  scopeType: string;
  strength: number;
  createdAt: number;
  lastRecalledAt: number | null;
  recallCount: number;
  /** Optional cosine similarity in [0,1] when an embedding exists. */
  similarity?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** Half-life decay: memory that is never recalled fades, but never reaches zero. */
export const DECAY_HALF_LIFE_DAYS = 30;

export function decayedStrength(
  baseStrength: number,
  lastRecalledAt: number | null,
  createdAt: number,
  now: number,
): number {
  const anchor = lastRecalledAt ?? createdAt;
  const ageDays = Math.max(0, (now - anchor) / DAY);
  const factor = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
  // A floor keeps very old memories retrievable rather than silently deleted.
  return Math.max(0.05, baseStrength * factor);
}

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);

function bigrams(text: string): string[] {
  const clean = text.toLowerCase().replace(/\s+/g, '');
  const grams: string[] = [];
  for (let index = 0; index < clean.length - 1; index += 1) grams.push(clean.slice(index, index + 2));
  return grams;
}

/** Term overlap plus CJK bigrams (CJK has no spaces, so tokens alone under-match). */
export function lexicalScore(query: string, content: string): number {
  const queryTokens = new Set(tokensOf(query));
  for (const gram of bigrams(query)) queryTokens.add(gram);
  if (queryTokens.size === 0) return 0;

  const lower = content.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) hits += 1;
  }
  const coverage = hits / queryTokens.size;
  return coverage === 0 ? 0 : Math.min(1, coverage * (0.6 + 0.4 * Math.min(1, hits / 4)));
}

/**
 * Final ordering: vector similarity dominates when present (0.55) because it is
 * semantic; lexical overlap and decayed strength break ties and keep fresh, often
 * used memories on top.
 */
/**
 * 相关度：**这条记忆和这个问题有没有关系**。
 *
 * 它和下面的 `scoreCandidate` 是两件事，必须分开。混在一起的后果是真实的：
 * 总分里有一项 `strength * 0.15`，于是一条排版新鲜、内容毫不相干的记忆也能拿到 0.15 分，
 * 而过滤门槛是 0.02——**噪声过滤从来没有生效过**，自动召回每次都硬凑满 5 条。
 */
export function relevanceOf(candidate: MemoryCandidate, query: string): number {
  const lexical = lexicalScore(query, candidate.content);
  const semantic = candidate.similarity ?? 0;
  return semantic * 0.55 + lexical * 0.3;
}

export function scoreCandidate(candidate: MemoryCandidate, query: string, now: number): number {
  const strength = decayedStrength(candidate.strength, candidate.lastRecalledAt, candidate.createdAt, now);
  const recallBonus = Math.min(0.1, candidate.recallCount * 0.02);
  return relevanceOf(candidate, query) + strength * 0.15 + recallBonus;
}

export interface RankOptions {
  /**
   * 强度门槛。**默认 0：衰减只影响排序，永不影响可达性。**
   *
   * 以前这里是 0.2，于是半衰期 30 天、90 天没被召回的条目会掉到 0.125 并被过滤掉——
   * 一个不通知任何人的删除机制。第 91 天恰好需要它的那次，就是用户流失。
   */
  minStrength?: number;
  /**
   * **相关度**门槛。和强度不是一回事：它挡的是"跟你问的完全不相关"，这有正当理由。
   * 显式回忆起话时传 0，让"一条都对不上"表现为"给出的最相关的几条"，而不是"没有记录"。
   */
  minRelevance?: number;
}

/** Applies scoring, drops noise, returns the top `limit`. */
export function rankMemories(
  candidates: MemoryCandidate[],
  query: string,
  limit: number,
  now: number,
  options: RankOptions = {},
): MemoryCandidate[] {
  const minStrength = options.minStrength ?? 0;
  const minRelevance = options.minRelevance ?? 0.02;
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, query, now),
      relevance: relevanceOf(candidate, query),
      strength: decayedStrength(candidate.strength, candidate.lastRecalledAt, candidate.createdAt, now),
    }))
    // `>=` 而不是 `>`：显式回忆传 0 时必须把「完全不相干」也放进来——那是它的用途。
    .filter((entry) => entry.strength >= minStrength && entry.relevance >= minRelevance)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
