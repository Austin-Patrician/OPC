import { describe, expect, it } from 'vitest';
import type {
  DecisionAnswer,
  DecisionClassifyInput,
  DecisionClassifyResult,
} from '@opc/shared/domain';
import { createDecisionToolExtension } from './decisionTool';

interface ToolResult {
  isError?: boolean;
  output?: { text: string }[];
  details?: Record<string, unknown>;
}

interface FakeTool {
  name: string;
  execute: (args: unknown, api: unknown, context: unknown) => Promise<ToolResult>;
}

type Classify = (input: DecisionClassifyInput) => Promise<DecisionClassifyResult>;

function toolWith(classify: Classify): FakeTool {
  const extension = createDecisionToolExtension({ classify });
  return ((extension.tools ?? []) as unknown as FakeTool[])[0]!;
}

function answers(entries: Record<string, DecisionAnswer>): DecisionClassifyResult {
  return { ok: true, model: 'jev-latest', answers: entries, usage: { inputTokens: 1842, outputTokens: 0 } };
}

const questions = [
  {
    name: 'needs_reply',
    type: 'bool' as const,
    instructions: '需要回复吗？',
    criteria: { true: '提出了问题', false: '通知类内容' },
  },
  {
    name: 'intent',
    type: 'choice' as const,
    instructions: '主要意图？',
    criteria: { refund: '要求退款', bug: '报告缺陷' },
  },
  {
    name: 'urgency',
    type: 'score' as const,
    instructions: '有多紧急？',
    criteria: ['可以等', '本周内'],
  },
];

describe('decide tool', () => {
  it('sends every question in one request and renders the typed answers', async () => {
    const calls: DecisionClassifyInput[] = [];
    const tool = toolWith(async (input) => {
      calls.push(input);
      return answers({
        needs_reply: { type: 'bool', probability: 0.87 },
        intent: {
          type: 'choice',
          choice: 'bug',
          confidence: 0.72,
          probabilities: { refund: 0.08, bug: 0.72, other: 0.2 },
        },
        urgency: { type: 'score', score: 2, confidence: 0.58, legend: { '0': '可以等', '1': '本周内' } },
      });
    });

    const output = await tool.execute({ state: '  客户来信……  ', questions }, {}, {});

    expect(output.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe('客户来信……');
    // Array → name-keyed map, provider-shaped.
    expect(Object.keys(calls[0]?.questions ?? {})).toEqual(['needs_reply', 'intent', 'urgency']);
    expect(calls[0]?.questions.needs_reply).toEqual({
      type: 'bool',
      instructions: '需要回复吗？',
      criteria: { true: '提出了问题', false: '通知类内容' },
    });
    // The agent never picks the model; the host resolves the configured one.
    expect(calls[0]).not.toHaveProperty('modelId');

    const text = output.output?.[0]?.text ?? '';
    expect(text).toContain('决策完成（jev-latest，输入 1842 tokens）');
    expect(text).toContain('- needs_reply: bool true，p=0.87（阈值 0.5）');
    expect(text).toContain('- intent: choice bug，confidence=0.72');
    expect(text).toContain('refund:0.08');
    expect(text).toContain('- urgency: score 2，confidence=0.58');
    expect(text).toContain('0=可以等');
    expect(text).toContain('bool 的 p 是模型给出的概率');
    expect(output.details).toMatchObject({ model: 'jev-latest', threshold: 0.5 });
  });

  it('folds bool answers at the threshold without hiding the probability', async () => {
    const tool = toolWith(async () =>
      answers({
        a: { type: 'bool', probability: 0.49 },
        b: { type: 'bool', probability: 0.51 },
      }),
    );
    const two = [
      { name: 'a', type: 'bool' as const, instructions: 'a?', criteria: { true: 'y', false: 'n' } },
      { name: 'b', type: 'bool' as const, instructions: 'b?', criteria: { true: 'y', false: 'n' } },
    ];

    const low = await tool.execute({ state: 'x', questions: two }, {}, {});
    expect(low.output?.[0]?.text).toContain('- a: bool false，p=0.49（阈值 0.5）');
    expect(low.output?.[0]?.text).toContain('- b: bool true，p=0.51（阈值 0.5）');

    const strict = await tool.execute({ state: 'x', questions: two, threshold: 0.9 }, {}, {});
    expect(strict.output?.[0]?.text).toContain('- b: bool false，p=0.51（阈值 0.9）');
  });

  it('rejects an out-of-range threshold instead of clamping it', async () => {
    let called = 0;
    const tool = toolWith(async () => {
      called += 1;
      return answers({});
    });

    const output = await tool.execute({ state: 'x', questions, threshold: 1.5 }, {}, {});

    expect(output.isError).toBe(true);
    expect(called).toBe(0);
    expect(output.output?.[0]?.text).toContain('threshold 必须在 0 到 1 之间');
  });

  it('rejects an empty or oversized state before calling the provider', async () => {
    let called = 0;
    const tool = toolWith(async () => {
      called += 1;
      return answers({});
    });

    const empty = await tool.execute({ state: '   ', questions }, {}, {});
    expect(empty.isError).toBe(true);
    expect(empty.output?.[0]?.text).toContain('state 不能为空');

    const huge = await tool.execute({ state: 'a'.repeat(24_001), questions }, {}, {});
    expect(huge.isError).toBe(true);
    expect(huge.output?.[0]?.text).toContain('state 过长');
    expect(called).toBe(0);
  });

  it('rejects duplicate or malformed question names', async () => {
    const tool = toolWith(async () => answers({}));
    const bool = (name: string) => ({
      name,
      type: 'bool' as const,
      instructions: 'x?',
      criteria: { true: 'y', false: 'n' },
    });

    const duplicate = await tool.execute({ state: 'x', questions: [bool('a'), bool('a')] }, {}, {});
    expect(duplicate.isError).toBe(true);
    expect(duplicate.output?.[0]?.text).toContain('问题名 "a" 重复');

    const bad = await tool.execute({ state: 'x', questions: [bool('Needs-Reply')] }, {}, {});
    expect(bad.isError).toBe(true);
    expect(bad.output?.[0]?.text).toContain('不合法');
  });

  it('rejects criteria the classifier could not use', async () => {
    const tool = toolWith(async () => answers({}));

    const bool = await tool.execute(
      {
        state: 'x',
        questions: [
          {
            name: 'a',
            type: 'bool',
            instructions: 'x?',
            criteria: { true: '一样', false: '一样' },
          },
        ],
      },
      {},
      {},
    );
    expect(bool.isError).toBe(true);
    expect(bool.output?.[0]?.text).toContain('true 和 false 含义不能相同');

    const choice = await tool.execute(
      {
        state: 'x',
        questions: [
          { name: 'a', type: 'choice', instructions: 'x?', criteria: { only: '只有一个' } },
        ],
      },
      {},
      {},
    );
    expect(choice.isError).toBe(true);
    expect(choice.output?.[0]?.text).toContain('2–12 个选项');

    const score = await tool.execute(
      {
        state: 'x',
        questions: [{ name: 'a', type: 'score', instructions: 'x?', criteria: ['只有一档'] }],
      },
      {},
      {},
    );
    expect(score.isError).toBe(true);
    expect(score.output?.[0]?.text).toContain('2–10 个评分档位');
  });

  it('caps the total size of the question definitions', async () => {
    let called = 0;
    const tool = toolWith(async () => {
      called += 1;
      return answers({});
    });
    const long = 'x'.repeat(120);
    const oversized = Array.from({ length: 8 }, (_, index) => ({
      name: `q${index}`,
      type: 'score' as const,
      instructions: 'rate',
      criteria: Array.from({ length: 10 }, () => long),
    }));

    const output = await tool.execute({ state: 'x', questions: oversized }, {}, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('问题定义过长');
    expect(called).toBe(0);
  });

  it('surfaces a provider failure as a readable error', async () => {
    const tool = toolWith(async () => ({ ok: false, error: 'HTTP 401' }));

    const output = await tool.execute({ state: 'x', questions }, {}, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('决策失败：HTTP 401');
  });

  it('does not throw when classify rejects', async () => {
    const tool = toolWith(async () => {
      throw new Error('socket hang up');
    });

    const output = await tool.execute({ state: 'x', questions }, {}, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('socket hang up');
  });

  it('fails when the model leaves a question unanswered', async () => {
    const tool = toolWith(async () => answers({ needs_reply: { type: 'bool', probability: 0.5 } }));

    const output = await tool.execute({ state: 'x', questions }, {}, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('没有回答这些问题：intent、urgency');
  });
});

describe('createDecisionToolExtension', () => {
  it('exposes exactly one tool named decide', () => {
    const extension = createDecisionToolExtension({ classify: async () => answers({}) });
    expect(extension.name).toBe('opc.decision');
    expect((extension.tools ?? []).map((tool) => tool.name)).toEqual(['decide']);
  });
});
