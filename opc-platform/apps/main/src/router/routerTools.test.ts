import { createRegistry } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { createRouterTools } from './routerTools';

/**
 * Router 的工具带。
 *
 * 这里锁的是 §2.1 那条边界：**Router 是序点，不是人手**。它没有 bash、没有
 * 文件读写——如果哪天有人图省事把它和执行体的注册表合并，这个用例会先炸。
 *
 * 它也锁 Router 唯一的外观信道：只有 `reply_to_user` 能让你看见它。没有这个
 * 约束，Router 的推理很容易漏进聊天，v1 的"单会话阻塞"就是这么回来的。
 */
function host(
  overrides: {
    steerLine?: () => Promise<{ ok: boolean; reason?: string; live: number; queued: number }>;
  } = {},
) {
  const calls: string[] = [];
  const replies: string[] = [];
  const steered: string[] = [];
  const remembered: string[] = [];
  const extension = createRouterTools({
    openLine: (input) => {
      calls.push(`open:${input.goal}`);
      return { ok: true, threadId: 'th-1', workerId: 'w-1', taskId: 'task-1' };
    },
    reply: (text) => replies.push(text),
    recall: (id) => `thread ${id}`,
    lines: () => [
      {
        threadId: 'th-1',
        title: '整理财报',
        state: 'running',
        attention: 'silent',
        lastActivityAt: 0,
        latestReport: null,
      },
    ],
    steerLine:
      overrides.steerLine ??
      ((threadId) => {
        steered.push(threadId);
        return Promise.resolve({ ok: true, live: 1, queued: 0 });
      }),
    askUser: () => ({ ok: true }),
    closeLine: () => ({ ok: true }),
    remember: (text) => {
      remembered.push(text);
      return Promise.resolve({ ok: true, id: 'mem-1' });
    },
    recallMemory: (query) =>
      Promise.resolve(
        query.includes('没有')
          ? { ok: true, items: [] }
          : {
              ok: true,
              items: [
                {
                  id: 'mem-1',
                  kind: 'preference',
                  content: '他说文档放 README 里',
                  createdAt: 1_700_000_000_000,
                  sourceType: 'consolidation',
                  relevance: 0.4,
                },
              ],
            },
      ),
  });
  const registry = createRegistry();
  registry.install(extension);
  return { registry, calls, replies, steered, remembered };
}

/** 直接调工具的 execute：这正是模型会做的事。 */
async function run(registry: ReturnType<typeof createRegistry>, name: string, args: unknown) {
  const found = registry
    .snapshot()
    .tools()
    .find((entry) => entry.tool.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return (found.tool as unknown as { execute: (a: unknown) => Promise<{ output: { text: string }[] }> })
    .execute(args);
}

describe('Router 的工具带', () => {
  it('九个动作，一个执行类工具都没有', () => {
    const { registry } = host();
    const names = registry
      .snapshot()
      .tools()
      .map((entry) => entry.tool.name)
      .sort();

    expect(names).toEqual([
      'ask_user',
      'close_line',
      'list_lines',
      'open_line_of_work',
      'recall',
      'recall_memory',
      'remember',
      'reply_to_user',
      'steer_line',
    ]);

    // §2.1：Router 可以不配备 Bash 工具。这里它是真的没有——不是没调用，是不存在。
    expect(names.some((name) => /bash|shell|write|edit|read_file/i.test(name))).toBe(false);
  });

  it('派活立刻返回 id，不返回任何执行结果', async () => {
    const { registry, calls } = host();
    const result = await run(registry, 'open_line_of_work', {
      goal: '整理 Q3 财报',
      thread_key: 'folder:inbox/q3.md',
    });

    expect(calls).toEqual(['open:整理 Q3 财报']);
    const text = result.output.map((block) => block.text).join('');
    expect(text).toContain('thread=th-1');
    expect(text).toContain('task=task-1');
    // 「跑完会回来汇报」——这一轮不等它。
    expect(text).toContain('跑完会回来汇报');
  });

  it('说话是唯一能让你看见它的动作', async () => {
    const { registry, replies } = host();
    await run(registry, 'reply_to_user', { text: '三条线都在跑。' });
    expect(replies).toEqual(['三条线都在跑。']);
  });

  it('recall 按 id 往下跳，不需要模型先知道全貌', async () => {
    const { registry } = host();
    const result = await run(registry, 'recall', { id: 'th-1' });
    expect(result.output.map((block) => block.text).join('')).toContain('thread th-1');
  });

  it('list_lines 给出全局：哪条线在动', async () => {
    const { registry } = host();
    const result = await run(registry, 'list_lines', {});
    const text = result.output.map((block) => block.text).join('');
    expect(text).toContain('整理财报');
    expect(text).toContain('running');
  });

  it('改方向走 steer_line，而且如实说这句话落在了哪里', async () => {
    const { registry, steered } = host();
    const result = await run(registry, 'steer_line', { thread_id: 'th-1', note: '用方案 B' });

    expect(steered).toEqual(['th-1']);
    const text = result.output.map((block) => block.text).join('');
    // live > 0：正在跑的活这一轮就能看到。
    expect(text).toContain('正在跑的活');
  });

  it('改不了方向时说清楚为什么，而不是假装带到了', async () => {
    const { registry } = host({
      steerLine: () =>
        Promise.resolve({ ok: false, reason: '这条线上的活已经收尾了', live: 0, queued: 0 }),
    });
    const result = (await run(registry, 'steer_line', { thread_id: 'th-1', note: '换个做法' })) as {
      isError?: boolean;
      output: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.output.map((block) => block.text).join('')).toContain('已经收尾');
  });

  it('记忆的两个动作：记住一件事，再按一句话回想起来', async () => {
    const { registry, remembered } = host();

    const saved = await run(registry, 'remember', { text: '他说文档放 README 里就够了' });
    expect(remembered).toEqual(['他说文档放 README 里就够了']);
    expect(saved.output.map((block) => block.text).join('')).toContain('记住了');

    const found = await run(registry, 'recall_memory', { query: '文档放哪' });
    expect(found.output.map((block) => block.text).join('')).toContain('README');
  });

  it('想不起来就说没有，不编造一条', async () => {
    const { registry } = host();
    const result = await run(registry, 'recall_memory', { query: '没有相关的事' });
    expect(result.output.map((block) => block.text).join('')).toBe('没有相关的记录。');
  });
});
