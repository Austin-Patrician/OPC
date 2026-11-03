import { describe, expect, it } from 'vitest';
import { createRecallToolExtension, type RecallOutcome } from './recallTool';

/**
 * `recall`：执行体回源头看。
 *
 * 提示词里给的是摘要，这里给全文。两个断言不是为了格式，是为了**边界**：
 * 执行体只能读自己这条线上的东西；而且"越界"和"打错 id"必须说成两句不同的话——
 * 一句教它边界在哪，一句让它别慌。
 */
interface FakeTool {
  name: string;
  execute: (args: unknown, api: unknown, context: unknown) => Promise<{
    isError?: boolean;
    output?: { text: string }[];
  }>;
}

function tool(deps: {
  taskId?: string | undefined;
  recall?: (input: { taskId: string; id: string; page: number }) => RecallOutcome;
}): FakeTool {
  const extension = createRecallToolExtension({
    taskId: () => deps.taskId,
    recall:
      deps.recall ??
      (() => ({ found: true as const, text: '（没有用到）' })),
  });
  return ((extension.tools ?? []) as unknown as FakeTool[])[0]!;
}

function textOf(result: { isError?: boolean; output?: { text: string }[] }): string {
  return result.output?.map((entry) => entry.text).join('\n') ?? '';
}

describe('recall 工具', () => {
  it('把 id 与页码交给宿主，取到什么就返回什么', async () => {
    const calls: { taskId: string; id: string; page: number }[] = [];
    const result = await tool({
      taskId: 'task-1',
      recall: (input) => {
        calls.push(input);
        return { found: true, text: '健康检查的端口改成 8081' };
      },
    }).execute({ id: 'ev-1', page: 2 }, {}, {});

    expect(calls).toEqual([{ taskId: 'task-1', id: 'ev-1', page: 2 }]);
    expect(textOf(result)).toContain('8081');
  });

  it('不给页码就是第 1 页：模型经常只写 id', async () => {
    let seen = 0;
    await tool({
      taskId: 'task-1',
      recall: (input) => {
        seen = input.page;
        return { found: true, text: 'x' };
      },
    }).execute({ id: 'ev-1' }, {}, {});
    expect(seen).toBe(1);
  });

  it('越界与打错说的是两句不同的话', async () => {
    const outOfScope = await tool({
      taskId: 'task-1',
      recall: () => ({ found: false, reason: 'out-of-scope' }),
    }).execute({ id: 'ev-9' }, {}, {});
    const notFound = await tool({
      taskId: 'task-1',
      recall: () => ({ found: false, reason: 'not-found' }),
    }).execute({ id: 'ev-9' }, {}, {});

    expect(outOfScope.isError).toBe(true);
    expect(textOf(outOfScope)).toContain('不在这条工作线上');
    expect(textOf(notFound)).toContain('找不到');
    expect(textOf(outOfScope)).not.toBe(textOf(notFound));
  });

  it('没有在跑的任务就说清楚，不去猜作用域', async () => {
    const result = await tool({ taskId: undefined }).execute({ id: 'ev-1' }, {}, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('没有在跑的任务');
  });

  it('空 id 不查库', async () => {
    let asked = false;
    const result = await tool({
      taskId: 'task-1',
      recall: () => {
        asked = true;
        return { found: true, text: '' };
      },
    }).execute({ id: '   ' }, {}, {});
    expect(asked).toBe(false);
    expect(result.isError).toBe(true);
  });
});
