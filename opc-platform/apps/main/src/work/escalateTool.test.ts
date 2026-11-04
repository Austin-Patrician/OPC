import { describe, expect, it } from 'vitest';
import {
  countEscalations,
  createEscalateToolExtension,
  createHandBackToolExtension,
  escalationLevel,
  escalationTag,
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
  escalate?: (input: {
    taskId: string;
    question: string;
    tried: string;
    suggestion: string;
    subject?: string;
  }) => {
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

  /**
   * W-G5：等级要按"**同一件事**问过几次"数，不是"这条任务问过几次"。
   *
   * 以前按任务数：第一个问题降级之后，第二个真正的新问题也只能拿到 `notify`，
   * 于是一件该打断他的事被静音了。subject 就是"这件事叫什么"。
   */
  it('同一件事第二次降级；换一件事照样插队', () => {
    const steps = [
      { text: '请示[deploy.target]：蓝绿还是滚动' },
      { text: '请示：这条没有 subject' },
    ];
    expect(countEscalations(steps, 'deploy.target')).toBe(1);
    expect(countEscalations(steps, 'acceptance')).toBe(0);
    expect(countEscalations(steps, undefined)).toBe(1);
    expect(countEscalations([], undefined)).toBe(0);
  });

  it('subject 归一：去空白、空格换连字符、封顶 40 字', () => {
    expect(escalationTag('deploy.target')).toBe('[deploy.target]');
    expect(escalationTag('  deploy  target ')).toBe('[deploy-target]');
    expect(escalationTag(undefined)).toBe('');
    expect(escalationTag('   ')).toBe('');
    expect(escalationTag('x'.repeat(80))).toBe(`[${'x'.repeat(40)}]`);
  });

  it('没有 subject 的老请示与带 subject 的新请示互不干扰', () => {
    const tagged = [{ text: '请示[deploy.target]：A' }];
    expect(countEscalations(tagged, undefined)).toBe(0);
    expect(countEscalations([{ text: '请示：老写法' }], 'deploy.target')).toBe(0);
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

  it('把 subject 一起交上去：宿主靠它判断是不是同一件事', async () => {
    const { tool, calls } = escalateTool({ taskId: 'task-1' });
    await tool.execute({ question: '蓝绿还是滚动', subject: '  deploy.target  ' }, {}, {});
    expect(calls[0]).toMatchObject({ subject: 'deploy.target' });
  });

  it('没写 subject 就不带这个字段：老调用方与老数据都不受影响', async () => {
    const { tool, calls } = escalateTool({ taskId: 'task-1' });
    await tool.execute({ question: '缺验收标准' }, {}, {});
    expect(calls[0]).not.toHaveProperty('subject');
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
