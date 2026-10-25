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
export function scoreCandidate(candidate: MemoryCandidate, query: string, now: number): number {
  const lexical = lexicalScore(query, candidate.content);
  const semantic = candidate.similarity ?? 0;
  const strength = decayedStrength(candidate.strength, candidate.lastRecalledAt, candidate.createdAt, now);
  const recallBonus = Math.min(0.1, candidate.recallCount * 0.02);
  return semantic * 0.55 + lexical * 0.3 + strength * 0.15 + recallBonus;
}

/** Applies scoring, drops noise, returns the top `limit`. */
export function rankMemories(
  candidates: MemoryCandidate[],
  query: string,
  limit: number,
  now: number,
  minStrength = 0.2,
): MemoryCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, query, now),
      strength: decayedStrength(candidate.strength, candidate.lastRecalledAt, candidate.createdAt, now),
    }))
    .filter((entry) => entry.strength >= minStrength && entry.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
