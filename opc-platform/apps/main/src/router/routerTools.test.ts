import { createRegistry } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import type { ChatContentBlock, RouterResponse } from '@opc/shared/domain';
import type { RouterToolDeps } from './routerTools';
import { createRouterTools } from './routerTools';
import type { RouterWorkerCapability } from './routerCapabilities';

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
    reply?: (text: string, target?: string, content?: ChatContentBlock[]) => void;
    workerCapabilities?: () => readonly RouterWorkerCapability[] | Promise<readonly RouterWorkerCapability[]>;
    schedules?: RouterToolDeps['schedules'];
  } = {},
) {
  const calls: string[] = [];
  const replies: string[] = [];
  const steered: string[] = [];
  const remembered: string[] = [];
  const forgotten: string[] = [];
  const extension = createRouterTools({
    openLine: (input) => {
      calls.push(`open:${input.contract.objective}`);
      return { ok: true, threadId: 'th-1', workerId: 'w-1', taskId: 'task-1' };
    },
    reply: (response: string | RouterResponse, target, content) => {
      const text = typeof response === 'string'
        ? response
        : response.blocks.filter((block): block is Extract<ChatContentBlock, { type: 'markdown' }> => block.type === 'markdown').map((block) => block.text).join('\n\n');
      replies.push(text);
      overrides.reply?.(text, target, content);
    },
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
    remember: (text, options) => {
      remembered.push(options?.standing ? `[常驻] ${text}` : text);
      return Promise.resolve({ ok: true, id: 'mem-1' });
    },
    forget: (id) => {
      forgotten.push(id);
      return Promise.resolve({ ok: id.startsWith('mem-') });
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
    workerCapabilities: overrides.workerCapabilities,
    schedules: overrides.schedules ?? {
      create: (draft) => ({ id: 'schedule-1', title: draft.title, instruction: draft.instruction,
        rule: draft.rule, timezone: draft.timezone ?? 'UTC', status: 'active', nextRunAt: 1,
        lastRunAt: null, createdAt: 1, updatedAt: 1 }),
      list: () => [], update: () => { throw new Error('not implemented'); },
      cancel: () => { throw new Error('not implemented'); },
    },
  });
  const registry = createRegistry();
  registry.install(extension);
  return { registry, extension, calls, replies, steered, remembered, forgotten };
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
  it('协调、记忆与计划工具不包含执行类工具', () => {
    const { registry } = host();
    const names = registry
      .snapshot()
      .tools()
      .map((entry) => entry.tool.name)
      .sort();

    expect(names).toEqual([
      'ask_user',
      'cancel_schedule',
      'close_line',
      'create_schedule',
      'forget_memory',
      'list_lines',
      'list_schedules',
      'ontology_command',
      'open_line_of_work',
      'recall',
      'recall_memory',
      'remember',
      'reply_to_user',
      'steer_line',
      'update_schedule',
    ]);

    // §2.1：Router 可以不配备 Bash 工具。这里它是真的没有——不是没调用，是不存在。
    expect(names.some((name) => /bash|shell|write|edit|read_file/i.test(name))).toBe(false);
  });

  it('把内部调度和执行体汇报隔离在用户可见回复之外', async () => {
    const { extension } = host();
    const text = await extension.sections![0]!.render({} as never, {} as never);
    expect(text).toContain('不要向用户解释你如何派活');
    expect(text).toContain('执行体汇报是供你判断的内部材料');
    expect(text).toContain('不要发送开始确认');
    expect(text).toContain('通常一到三句');
  });

  it('把 Worker 的有效工具作为动态元数据提供给 Router，而不把工具装进 Router', async () => {
    const { extension, registry } = host({
      workerCapabilities: async () => [
        { name: '桌面执行体', template: 'ops', tools: ['desktop_list_apps', 'desktop_snapshot'] },
      ],
    });
    const capabilitySection = extension.sections?.find((section) => section.key === 'worker-capabilities');
    expect(capabilitySection).toBeDefined();
    const text = await capabilitySection!.render({} as never, {} as never);

    expect(text).toContain('桌面执行体 · ops：desktop_list_apps、desktop_snapshot');
    expect(registry.snapshot().tools().map((entry) => entry.tool.name)).not.toContain('desktop_snapshot');
  });

  it('在每次 prompt render 时重新读取 Worker 目录', async () => {
    let revision = 0;
    const { extension } = host({
      workerCapabilities: () => {
        revision += 1;
        return [{ name: `执行体-${revision}`, template: 'ops', tools: ['desktop_snapshot'] }];
      },
    });
    const capabilitySection = extension.sections?.find((section) => section.key === 'worker-capabilities');
    expect(capabilitySection).toBeDefined();
    if (!capabilitySection) throw new Error('缺少 Worker 能力目录 section');

    expect(await capabilitySection.render({} as never, {} as never)).toContain('执行体-1');
    expect(await capabilitySection.render({} as never, {} as never)).toContain('执行体-2');
  });

  it('向 Router 暴露定时计划管理工具，但计划内容本身不启动 Worker', async () => {
    const created: string[] = [];
    const { registry } = host({
      schedules: {
        create: (draft) => {
          created.push(draft.instruction);
          return { id: 'schedule-x', title: draft.title, instruction: draft.instruction, rule: draft.rule,
            timezone: draft.timezone ?? 'Asia/Shanghai', status: 'active', nextRunAt: 1_800_000_000_000,
            lastRunAt: null, createdAt: 1, updatedAt: 1 };
        },
        list: () => [], update: () => { throw new Error('unused'); }, cancel: () => { throw new Error('unused'); },
      },
    });
    await run(registry, 'create_schedule', {
      title: '看邮件', instruction: '检查 Gmail 新邮件', rule: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai',
    });
    expect(created).toEqual(['检查 Gmail 新邮件']);
  });

  it('派活立刻返回 id，不返回任何执行结果', async () => {
    const { registry, calls } = host();
    const result = await run(registry, 'open_line_of_work', {
      contract: {
        objective: '整理 Q3 财报',
        deliverable: '整理 Q3 财报',
        outputs: [{ kind: 'text', description: '完成后的文本结论' }],
      },
      thread_key: 'folder:inbox/q3.md',
    });

    expect(calls).toEqual(['open:整理 Q3 财报']);
    const text = result.output.map((block) => block.text).join('');
    expect(text).toContain('后台任务已启动');
    expect(text).toContain('不要发送开始确认');
    expect(text).not.toContain('th-1');
    expect(text).not.toContain('w-1');
    expect(text).not.toContain('task-1');
  });

  it('说话是唯一能让你看见它的动作', async () => {
    const { registry, replies } = host();
    await run(registry, 'reply_to_user', { text: '三条线都在跑。' });
    expect(replies).toEqual(['三条线都在跑。']);
  });

  it('按顺序把富媒体内容块交给桌面回复出口，不拼进用户输入文本', async () => {
    const received: ChatContentBlock[][] = [];
    const { registry } = host({ reply: (text, _target, content) => {
      expect(text).toBe('图表在下面');
      if (content) received.push(content);
    } });
    const blocks = [
      { type: 'markdown', text: '先看结论' },
      { type: 'image', url: 'https://example.com/chart.png', alt: '图表' },
    ];
    await run(registry, 'reply_to_user', { text: '图表在下面', content: blocks });
    expect(received).toEqual([[
      { type: 'markdown', text: '先看结论' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/chart.png' }, alt: '图表', title: undefined },
    ]]);
    expect(JSON.stringify(received)).not.toContain('opc-content-envelope');
  });

  it('可以把受信任的原始信道地址交给回复出口', async () => {
    const targets: (string | undefined)[] = [];
    const { registry } = host({ reply: (_text, target) => targets.push(target) });
    await run(registry, 'reply_to_user', { text: '回原处', reply_target: 'github:acme/api#12' });
    expect(targets).toEqual(['github:acme/api#12']);
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

  it('常驻约束要显式开口：standing 不设就只是普通记忆', async () => {
    const { registry, remembered } = host();

    await run(registry, 'remember', { text: '回答不要客套' });
    await run(registry, 'remember', { text: '称呼用「你」', standing: true });

    // 常驻层每一轮都进上下文，位置有限——所以它不能是默认行为。
    expect(remembered).toEqual(['回答不要客套', '[常驻] 称呼用「你」']);
  });

  it('撤掉一条记忆：转给服务层，撤回执不撒谎', async () => {
    const { registry, forgotten } = host();

    await run(registry, 'forget_memory', { id: 'mem-1' });
    expect(forgotten).toEqual(['mem-1']);

    const missing = (await run(registry, 'forget_memory', { id: 'not-a-memory' })) as { isError?: boolean };
    expect(missing.isError).toBe(true);
  });

  it('想不起来就说没有，不编造一条', async () => {
    const { registry } = host();
    const result = await run(registry, 'recall_memory', { query: '没有相关的事' });
    expect(result.output.map((block) => block.text).join('')).toBe('没有相关的记录。');
  });
});
