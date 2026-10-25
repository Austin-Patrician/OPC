import { describe, expect, it } from 'vitest';
import { decayedStrength, lexicalScore, rankMemories } from './memoryScore';

const now = Date.UTC(2026, 0, 1);
const base = {
  kind: 'experience',
  scopeType: 'personal',
  strength: 1,
  createdAt: now,
  lastRecalledAt: null,
  recallCount: 0,
};

describe('memory decay', () => {
  it('halves after one half-life and floors instead of vanishing', () => {
    const halfLife = 30 * 24 * 60 * 60 * 1000;
    expect(decayedStrength(1, null, now - halfLife, now)).toBeCloseTo(0.5, 2);
    expect(decayedStrength(1, null, now - halfLife * 40, now)).toBe(0.05);
  });

  it('recall resets the decay clock', () => {
    const old = now - 90 * 24 * 60 * 60 * 1000;
    expect(decayedStrength(1, now, old, now)).toBeCloseTo(1, 2);
  });
});

describe('lexical scoring', () => {
  it('matches Chinese by bigram overlap', () => {
    expect(lexicalScore('健康检查', '把健康检查服务写成 node:http')).toBeGreaterThan(0.3);
  });

  it('scores unrelated text zero', () => {
    expect(lexicalScore('数据库迁移', '配色只用语义 token')).toBe(0);
  });
});

describe('ranking', () => {
  it('puts the relevant memory first and drops noise', () => {
    const ranked = rankMemories(
      [
        { ...base, id: 'a', content: '健康检查服务必须监听 3000 端口，验收用 curl' },
        { ...base, id: 'b', content: '配色只用语义 token，不写死 hex' },
        { ...base, id: 'c', content: '健康检查服务上次忘了写 package.json' },
      ],
      '健康检查服务要怎么写',
      2,
      now,
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it('prefers vector similarity when embeddings exist', () => {
    const ranked = rankMemories(
      [
        { ...base, id: 'lexical', content: '端口 3000 健康检查' },
        { ...base, id: 'semantic', content: '完全不同的措辞', similarity: 0.95 },
      ],
      '端口 3000 健康检查',
      1,
      now,
    );
    expect(ranked[0]?.id).toBe('semantic');
  });
});
