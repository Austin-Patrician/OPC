import { describe, expect, it } from 'vitest';
import { classifyTerminal, FAILURE_ADVICE, FAILURE_LABEL, isRetryable } from './failure';

/**
 * 失败分类（`09-worker-spec.md` §3.7）。
 *
 * 这一层不看模型、不看时间，所以可以被钉死——而它必须被钉死，因为它决定了三件
 * 人都能感觉到的事：要不要重试、线停在哪个状态、要不要打扰人。
 */

describe('classifyTerminal', () => {
  it('闸门过了就不是失败', () => {
    expect(classifyTerminal({ outcome: 'completed', verdict: 'pass' })).toBeNull();
  });

  it('跑完但判不了对错 = 缺判据，不是缺工作', () => {
    expect(classifyTerminal({ outcome: 'completed', verdict: 'fail', unverified: true })).toBe(
      'unverified',
    );
  });

  it('跑完了、判了、没过 = 验收未通过', () => {
    expect(classifyTerminal({ outcome: 'completed', verdict: 'fail', unverified: false })).toBe(
      'rejected',
    );
  });

  it('被中止不算它一笔失败', () => {
    expect(classifyTerminal({ outcome: 'aborted' })).toBe('cancelled');
  });

  it('运行时层面的问题都算可重试：faulted / orphaned / failed', () => {
    for (const outcome of ['faulted', 'orphaned', 'failed'] as const) {
      expect(classifyTerminal({ outcome })).toBe('retryable');
    }
  });
});

describe('isRetryable', () => {
  it('只有"运行时中断"和"验收没过"值得再跑一次', () => {
    expect(isRetryable('retryable')).toBe(true);
    expect(isRetryable('rejected')).toBe(true);
  });

  it('起不来的、交回的、被取消的、缺判据的，重跑没有意义', () => {
    for (const kind of ['blocked', 'cancelled', 'handed_back', 'needs_decision', 'unverified'] as const) {
      expect(isRetryable(kind)).toBe(false);
    }
  });

  it('没分类（老任务）不假装可重试', () => {
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('措辞', () => {
  it('七类都有标签和建议：界面不该出现一个没有解释的空种类', () => {
    for (const kind of Object.keys(FAILURE_LABEL) as (keyof typeof FAILURE_LABEL)[]) {
      expect(FAILURE_LABEL[kind].length).toBeGreaterThan(0);
      expect(FAILURE_ADVICE[kind].length).toBeGreaterThan(0);
    }
    expect(Object.keys(FAILURE_LABEL)).toHaveLength(7);
  });
});
