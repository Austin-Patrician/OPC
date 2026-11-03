import type { DecisionClassifyResult, TriggerEvent } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import type { DecisionService } from '../models/decisionService';
import { createDecisionGate, keepAll } from './semanticGate';

/**
 * 语义门：只回答"这值得惊动 Router 吗"。
 *
 * 这个文件的重点全在一件事上：**它没有丢活的权力**。判不动、判失败、答案缺失，
 * 都必须落到"放行"。所以用例里有一半是在给分类器喂坏数据。
 */
function event(id: string, text = '有件事'): TriggerEvent {
  return {
    id,
    source: 'im',
    kind: 'user_message',
    payload: { text },
    threadId: null,
    triage: 'pending',
    createdAt: 0,
    triagedAt: null,
  };
}

/** 一个假的分类器：按传入的概率顺序回答，或者直接失败。 */
function classifier(
  answer:
    | { probabilities: number[] }
    | { error: string }
    | { ok: false; error: string }
    | 'throws',
): DecisionService {
  return {
    classify: async (input: { questions: Record<string, unknown> }): Promise<DecisionClassifyResult> => {
      if (answer === 'throws') throw new Error('网络没了');
      if ('error' in answer) return { ok: false, error: answer.error };
      const answers: NonNullable<DecisionClassifyResult['answers']> = {};
      let index = 0;
      for (const key of Object.keys(input.questions)) {
        answers[key] = { type: 'bool', probability: answer.probabilities[index] ?? 0 };
        index += 1;
      }
      return { ok: true, answers };
    },
  } as unknown as DecisionService;
}

describe('语义门', () => {
  it('概率过线的判成噪声，其余放行', async () => {
    const gate = createDecisionGate({
      decisions: classifier({ probabilities: [0.95, 0.1] }),
      threshold: () => 0.7,
    });

    const result = await gate([event('a', '心跳'), event('b', '把报告写出来')]);
    expect(result.dropped.map((item) => item.id)).toEqual(['a']);
    expect(result.keep.map((item) => item.id)).toEqual(['b']);
  });

  it('阈值跟着设置走，同一个概率换个阈值就是另一个结论', async () => {
    const decisions = classifier({ probabilities: [0.6] });
    expect((await createDecisionGate({ decisions, threshold: () => 0.5 })([event('a')])).dropped).toHaveLength(1);
    expect((await createDecisionGate({ decisions, threshold: () => 0.9 })([event('a')])).dropped).toHaveLength(0);
  });

  it('分类器调用失败：全放行，并说一句为什么', async () => {
    const gate = createDecisionGate({ decisions: classifier('throws'), threshold: () => 0.5 });
    const result = await gate([event('a'), event('b')]);
    expect(result.dropped).toHaveLength(0);
    expect(result.keep).toHaveLength(2);
    expect(result.error).toContain('网络没了');
  });

  it('没有可用的决策模型：全放行', async () => {
    const gate = createDecisionGate({
      decisions: classifier({ ok: false, error: '请先添加并选择一个决策模型' }),
      threshold: () => 0.5,
    });
    const result = await gate([event('a')]);
    expect(result.keep).toHaveLength(1);
    expect(result.error).toContain('决策模型');
  });

  it('答案缺失不算"零概率"以外的任何东西——一条都不能丢', async () => {
    const decisions = {
      classify: async (): Promise<DecisionClassifyResult> => ({ ok: true, answers: {} }),
    } as unknown as DecisionService;
    const result = await createDecisionGate({ decisions, threshold: () => 0.5 })([event('a')]);
    expect(result.keep).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('一次调用判一批，而不是一条一个调用', async () => {
    let calls = 0;
    const decisions = {
      classify: async (input: {
        questions: Record<string, unknown>;
      }): Promise<DecisionClassifyResult> => {
        calls += 1;
        const answers: NonNullable<DecisionClassifyResult['answers']> = {};
        for (const key of Object.keys(input.questions)) answers[key] = { type: 'bool', probability: 0 };
        return { ok: true, answers };
      },
    } as unknown as DecisionService;

    const events = Array.from({ length: 25 }, (_, index) => event(`e-${index}`));
    const result = await createDecisionGate({ decisions, threshold: () => 0.5 })(events);
    expect(result.keep).toHaveLength(25);
    // 25 条按 10 条一批，三次调用摊薄到每条 0.12 次。
    expect(calls).toBe(3);
  });

  it('关着的时候是 keepAll：一条都不动', async () => {
    const events = [event('a'), event('b')];
    const result = await keepAll(events);
    expect(result.keep).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
