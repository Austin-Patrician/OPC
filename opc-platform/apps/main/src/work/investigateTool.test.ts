import { describe, expect, it } from 'vitest';
import { createInvestigateToolExtension, MAX_INVESTIGATIONS } from './investigateTool';
import type { SubagentAnswer, SubagentRequest } from './subagent';

/**
 * 子代理的三道闸门（原文 §2.2）。
 *
 * 它们不是"防滥用"，是**成本结构**：每次 `investigate` 都是一整轮工具调用，是唯一能把
 * 单个任务的成本放大一个数量级的机制。所以深度、并发、次数必须由代码管，不能靠提示词
 * 请求模型自律。
 *
 * 还有一条同样是结构性的：**失败不传染**。子代理没查出来是一次返回值，不是父任务失败
 * ——否则一次可恢复的探索会花掉最贵的单位（尝试次数）。
 */
interface FakeTool {
  name: string;
  execute: (args: unknown, api: unknown, context: unknown) => Promise<{
    isError?: boolean;
    output?: { text: string }[];
  }>;
}

function textOf(result: { output?: { text: string }[] }): string {
  return result.output?.map((entry) => entry.text).join('\n') ?? '';
}

interface Harness {
  tool: FakeTool;
  calls: SubagentRequest[];
  steps: string[];
}

function harness(
  options: {
    taskId?: string | undefined;
    run?: (input: { taskId: string; question: string; expects: string }) => Promise<SubagentAnswer>;
  } = {},
): Harness {
  const calls: SubagentRequest[] = [];
  const steps: string[] = [];
  const extension = createInvestigateToolExtension({
    taskId: () => options.taskId,
    run:
      options.run ??
      (async (input) => {
        calls.push(input as SubagentRequest);
        return { answer: '端口 8081 已被占用', written: [], tokens: 120, costUsd: 0 };
      }),
    log: (_taskId, text) => {
      steps.push(text);
    },
  });
  return { tool: ((extension.tools ?? []) as unknown as FakeTool[])[0]!, calls, steps };
}

describe('investigate 工具', () => {
  it('拿回结论，并把账记在父任务上', async () => {
    const { tool, steps } = harness({ taskId: 'task-a' });
    const result = await tool.execute({ question: '8081 为什么起不来' }, {}, {});

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('端口 8081 已被占用');
    expect(textOf(result)).toContain('120 tokens');
    // 对 Router 透明，但对人和 Watchdog 必须可见。
    expect(steps[0]).toBe('[查 1] 8081 为什么起不来');
    expect(steps[1]).toContain('[查 1] 回来了');
  });

  it('它的产出不算交付物：明确说清那些文件在哪', async () => {
    const { tool } = harness({
      taskId: 'task-b',
      run: async () => ({ answer: '查到了', written: ['notes.md'], tokens: 10, costUsd: 0.01 }),
    });
    const result = await tool.execute({ question: '查一下这个文件' }, {}, {});

    expect(textOf(result)).toContain('notes.md');
    expect(textOf(result)).toContain('不在你的交付目录');
    expect(textOf(result)).toContain('$0.0100');
  });

  it('一次只能有一个在跑：串行与深度是同一个开关', async () => {
    // 第一次故意挂着不返回；之后的调用立刻返回（否则"回来之后可以再派"永远等不到）。
    const releases: (() => void)[] = [];
    let calls = 0;
    const { tool } = harness({
      taskId: 'task-c',
      run: async () => {
        calls += 1;
        if (calls > 1) return { answer: '好的', written: [], tokens: 0, costUsd: 0 };
        await new Promise<void>((resolve) => releases.push(resolve));
        return { answer: '好的', written: [], tokens: 0, costUsd: 0 };
      },
    });

    const first = tool.execute({ question: '第一件事' }, {}, {});
    const second = await tool.execute({ question: '第二件事' }, {}, {});

    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('已经有一个子代理在查了');

    releases[0]!();
    await first;
    // 回来之后可以再派。
    const third = await tool.execute({ question: '第三件事' }, {}, {});
    expect(third.isError).toBeFalsy();
  });

  it('一个任务最多三次：第四次让它自己查', async () => {
    const { tool } = harness({ taskId: 'task-d' });
    for (let index = 0; index < MAX_INVESTIGATIONS; index += 1) {
      const result = await tool.execute({ question: `第 ${index} 件事` }, {}, {});
      expect(result.isError).toBeFalsy();
    }
    const fourth = await tool.execute({ question: '第四件事' }, {}, {});
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toContain('剩下的自己查');
  });

  it('失败不传染：父还能自己查，或者在没有这个事实的情况下继续', async () => {
    const { tool, steps } = harness({
      taskId: 'task-e',
      run: async () => {
        throw new Error('模型超时');
      },
    });
    const result = await tool.execute({ question: '查一个查不到的东西' }, {}, {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('子代理没查成（模型超时）');
    expect(textOf(result)).toContain('你可以自己查');
    expect(steps.at(-1)).toContain('没查成');
  });

  it('没有在跑的任务、或者问题太短，都不派', async () => {
    const none = harness({ taskId: undefined });
    expect((await none.tool.execute({ question: '查点什么' }, {}, {})).isError).toBe(true);
    expect(none.calls).toHaveLength(0);

    const short = harness({ taskId: 'task-g' });
    expect((await short.tool.execute({ question: '查' }, {}, {})).isError).toBe(true);
    expect(short.calls).toHaveLength(0);
  });
});
