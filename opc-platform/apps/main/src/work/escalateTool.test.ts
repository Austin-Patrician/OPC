import { describe, expect, it } from 'vitest';
import {
  createEscalateToolExtension,
  createHandBackToolExtension,
  escalationLevel,
} from './escalateTool';

/**
 * 执行体只有终局的那张嘴（E3）。
 *
 * 以前它卡住时只有两条路：猜（跑完一个你不想要的东西）或者失败（一次尝试 + 一笔钱 +
 * Router 一次复盘）。两个工具补上的是第三条路：**说**。
 *
 * 这里最有分量的一条是 `escalationLevel`：同一个任务请示第二次就不再插队。
 * `decide` 的意思是「我要你放下手上的事」，而一个执行体在同一件事上问两次，说明它不该
 * 接这件事。
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

function escalateTool(deps: {
  taskId?: string | undefined;
  escalate?: (input: { taskId: string; question: string; tried: string; suggestion: string }) => {
    level: 'decide' | 'notify';
  };
}): { tool: FakeTool; calls: unknown[] } {
  const calls: unknown[] = [];
  const extension = createEscalateToolExtension({
    taskId: () => deps.taskId,
    escalate:
      deps.escalate ??
      ((input) => {
        calls.push(input);
        return { level: 'decide' as const };
      }),
  });
  return { tool: ((extension.tools ?? []) as unknown as FakeTool[])[0]!, calls };
}

describe('请示', () => {
  it('第一次插队，第二次只记在线上', () => {
    expect(escalationLevel(0)).toBe('decide');
    expect(escalationLevel(1)).toBe('notify');
    expect(escalationLevel(5)).toBe('notify');
  });

  it('把问题、试过什么、建议一起交上去', async () => {
    const { tool, calls } = escalateTool({ taskId: 'task-1' });
    await tool.execute(
      { question: 'A 快 B 稳，要哪个', tried: '两个都跑了一遍', suggestion: '选 B' },
      {},
      {},
    );

    expect(calls[0]).toEqual({
      taskId: 'task-1',
      question: 'A 快 B 稳，要哪个',
      tried: '两个都跑了一遍',
      suggestion: '选 B',
    });
  });

  it('第一次和第二次说的话不一样：它得知道这句话有没有插队', async () => {
    const first = await escalateTool({ taskId: 'task-1' }).tool.execute(
      { question: '两个方案选哪个' },
      {},
      {},
    );
    expect(textOf(first)).toContain('会插进他要处理的事里');

    const second = await escalateTool({
      taskId: 'task-1',
      escalate: () => ({ level: 'notify' as const }),
    }).tool.execute({ question: '再问一次选哪个' }, {}, {});
    expect(textOf(second)).toContain('不会插队');
  });

  it('没有在跑的任务、问题太短，都不问', async () => {
    const none = escalateTool({ taskId: undefined });
    expect((await none.tool.execute({ question: '选哪个' }, {}, {})).isError).toBe(true);
    expect(none.calls).toHaveLength(0);

    const short = escalateTool({ taskId: 'task-1' });
    expect((await short.tool.execute({ question: '?' }, {}, {})).isError).toBe(true);
    expect(short.calls).toHaveLength(0);
  });
});

describe('交回', () => {
  function handBackTool(deps: {
    taskId?: string | undefined;
    ok?: boolean;
  }): FakeTool {
    const extension = createHandBackToolExtension({
      taskId: () => deps.taskId,
      handBack: () =>
        deps.ok === false ? { ok: false, reason: '这条任务不在任何工作线上' } : { ok: true },
    });
    return ((extension.tools ?? []) as unknown as FakeTool[])[0]!;
  }

  it('交回成功之后明确说"别再往下做了"', async () => {
    const result = await handBackTool({ taskId: 'task-1' }).execute({ reason: '目标改了' }, {}, {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('不会再直通给你');
    expect(textOf(result)).toContain('不要再往下做了');
  });

  it('交不了就把原因原样说出来，不让模型自己猜', async () => {
    const result = await handBackTool({ taskId: 'task-1', ok: false }).execute(
      { reason: '目标改了' },
      {},
      {},
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('不在任何工作线上');
  });

  it('没说原因就不交回', async () => {
    const result = await handBackTool({ taskId: 'task-1' }).execute({ reason: '算了' }, {}, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('说清原因');
  });
});
