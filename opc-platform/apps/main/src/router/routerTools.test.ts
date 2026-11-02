import { createRegistry } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { createRouterTools } from './routerTools';

/**
 * Router 的工具带。
 *
 * 这里锁的是 §2.1 那条边界：**Router 是序点，不是人手**。它没有 bash、没有
 * 文件读写——如果哪天有人图省事把它和执行体的注册表合并，这个用例会先炸。
 *
 * 它也锁 Router 唯一的外观信道：只有 `reply_to_boss` 能让老板看见它。没有这个
 * 约束，Router 的推理很容易漏进聊天，v1 的"单会话阻塞"就是这么回来的。
 */
function host() {
  const calls: string[] = [];
  const replies: string[] = [];
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
    steerLine: () => ({ ok: true }),
    askBoss: () => ({ ok: true }),
    closeLine: () => ({ ok: true }),
  });
  const registry = createRegistry();
  registry.install(extension);
  return { registry, calls, replies };
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
  it('只有七个动作，而且一个执行类工具都没有', () => {
    const { registry } = host();
    const names = registry
      .snapshot()
      .tools()
      .map((entry) => entry.tool.name)
      .sort();

    expect(names).toEqual([
      'ask_boss',
      'close_line',
      'list_lines',
      'open_line_of_work',
      'recall',
      'reply_to_boss',
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

  it('说话是唯一能让老板看见它的动作', async () => {
    const { registry, replies } = host();
    await run(registry, 'reply_to_boss', { text: '三条线都在跑。' });
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
});
