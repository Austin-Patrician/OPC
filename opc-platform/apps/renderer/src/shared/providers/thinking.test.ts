import { describe, expect, it } from 'vitest';
import { FALLBACK_THINKING_LEVELS, thinkingLevelsFor } from './thinking';

/**
 * 模型 → 思考档位。
 *
 * 重点是**听 pi 的**：目录里给了档位就用它（xhigh / max 只在映射允许时出现），
 * 只有目录里没有这个模型时才退回默认三档。`['off']` 是 pi 表示"不支持思考"的方式，
 * 必须折算成"不给档位控件"。
 */
describe('思考档位', () => {
  it('用 pi 给的档位，不做二次加工', () => {
    expect(thinkingLevelsFor({ id: 'claude', reasoning: true }, ['off', 'low', 'medium', 'high'])).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(
      thinkingLevelsFor({ id: 'gpt', reasoning: true }, ['low', 'medium', 'high', 'xhigh', 'max']),
    ).toContain('xhigh');
  });

  it('pi 说只有 off：等于不支持思考，一个档位都不给', () => {
    expect(thinkingLevelsFor({ id: 'plain', reasoning: true }, ['off'])).toEqual([]);
  });

  it('模型明确不支持思考时，忽略目录里给的东西', () => {
    expect(thinkingLevelsFor({ id: 'plain', reasoning: false }, ['low', 'high'])).toEqual([]);
  });

  it('目录里没有这个模型（手填的）时退回默认三档', () => {
    expect(thinkingLevelsFor({ id: 'my-relay-model', reasoning: true })).toEqual(
      FALLBACK_THINKING_LEVELS,
    );
  });

  it('能力未知也按支持处理：默认三档，而不是不许选', () => {
    expect(thinkingLevelsFor({ id: 'legacy-row' })).toEqual(FALLBACK_THINKING_LEVELS);
  });

  it('返回的是副本，调用方改了不会污染来源', () => {
    const levels = thinkingLevelsFor({ id: 'x', reasoning: true }, ['low', 'medium', 'high']);
    levels.pop();
    expect(thinkingLevelsFor({ id: 'x', reasoning: true }, ['low', 'medium', 'high'])).toHaveLength(3);
  });
});
