import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { WorkTask } from '@opc/shared/domain';
import { buildPrompt, buildRetryFeedbackPrompt, HarnessBrain } from './harnessBrain';

/**
 * 提示词是契约：执行体只看得到这一段字。
 *
 * 这里锁的是顺序与口气——你中途改的方向必须**晚于**原始说明出现，并且明确写着
 * "冲突时以这里为准"。否则 `steer_line` 就只是把一句话存进了数据库，执行体照旧
 * 按原来的说明干活，你会以为自己的话没被听见。
 */
function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'task-1',
    title: '写一个返回 ok 的服务',
    brief: '用 node 内置 http，监听 3000',
    deliverableSpec: 'server.js 返回 ok',
    assigneeId: 'w-1',
    assigneeName: '小助手',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 5_000,
    acceptanceCommand: ['node', 'verify.mjs'],
    acceptanceTemplate: 'http-ok',
    status: 'running',
    workspaceRelPath: 'tasks/task-1',
    createdAt: 0,
    updatedAt: 0,
    artifacts: [],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...overrides,
  };
}

describe('执行体看到的提示词', () => {
  it('没人改过方向时，不出现那一段', () => {
    const prompt = buildPrompt(task());
    expect(prompt).toContain('说明：用 node 内置 http，监听 3000');
    expect(prompt).not.toContain('用户在做这件事的过程中改了方向');
  });

  it('改过的方向排在原始说明之后，并声明冲突时以它为准', () => {
    const prompt = buildPrompt(
      task({
        steering: [{ note: '改成 8080，不要 3000', at: 1 }],
        facts: [{ statement: '交付必须带 README', scopeType: 'global' }],
      }),
    );

    const briefAt = prompt.indexOf('说明：');
    const steeringAt = prompt.indexOf('用户在做这件事的过程中改了方向');
    const factsAt = prompt.indexOf('工作台的规定');

    expect(steeringAt).toBeGreaterThan(briefAt);
    expect(prompt).toContain('- 改成 8080，不要 3000');
    // 规定排在最后：它是长期约束，改方向是"这一次"的话。
    expect(factsAt).toBeGreaterThan(steeringAt);
    expect(prompt).toContain('以这里为准');
  });

  it('核心画像与长期铁律单独一段，口吻是"必须遵守"', () => {
    const prompt = buildPrompt(
      task({ memoryCore: '- [铁律] 代码里不要写注释' }),
    );

    expect(prompt).toContain('用户环境、习惯与长期铁律（必须遵守）');
    expect(prompt).toContain('- [铁律] 代码里不要写注释');
    expect(prompt).not.toContain('历史避坑提醒');
  });

  it('顺序：改过的方向 > 核心画像与铁律 > 历史避坑 > 工作台的规定 > 相关专题', () => {
    const prompt = buildPrompt(
      task({
        steering: [{ note: '改成 8080', at: 1 }],
        memoryCore: '- [铁律] 结论放最前面',
        memoryPlaybook: ['[端口] 避免：直接占用 3000 → 正确做法：先检查端口'],
        facts: [{ statement: '交付必须带 README', scopeType: 'global' }],
        memoryTopics: ['[项目架构 / 接口] 使用强类型 IPC'],
      }),
    );

    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('用户在做这件事的过程中改了方向')).toBeLessThan(at('用户环境、习惯与长期铁律'));
    expect(at('用户环境、习惯与长期铁律')).toBeLessThan(at('历史避坑提醒'));
    expect(at('历史避坑提醒')).toBeLessThan(at('工作台的规定'));
    expect(at('工作台的规定')).toBeLessThan(at('相关专题与背景知识'));
  });

  it('没有避坑与核心记忆时不留空标题', () => {
    const prompt = buildPrompt(task());
    expect(prompt).not.toContain('历史避坑提醒');
    expect(prompt).not.toContain('长期铁律');
  });

  /**
   * 原始记录（§3.3）：给 ID + 摘要，全文用 recall 取。
   *
   * 它排在「交付物」之后、「要求」之前——这是**证据**，不是又一条要求。放在要求后面，
   * 模型会把它读成附加约束；放在最前面，它会以为那是任务本身。
   */
  it('原始记录单独一段，排在交付物之后、要求之前，并且带 recall 入口', () => {
    const prompt = buildPrompt(
      task({
        records: [
          {
            kind: 'event',
            id: 'ev-3f2a',
            title: 'im/message',
            excerpt: '健康检查的端口改成 8081',
          },
        ],
      }),
    );

    expect(prompt).toContain('这件事的原始记录（要看全文就 recall <id>）');
    expect(prompt).toContain('- event ev-3f2a · im/message');
    expect(prompt).toContain('  健康检查的端口改成 8081');

    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('交付物：')).toBeLessThan(at('这件事的原始记录'));
    expect(at('这件事的原始记录')).toBeLessThan(at('要求：'));
  });

  it('摘要的多行被缩进，不会被读成并列条目', () => {
    const prompt = buildPrompt(
      task({
        records: [
          { kind: 'event', id: 'ev-1', title: 'im/message', excerpt: '第一行\n…（略去 9 行）…' },
        ],
      }),
    );
    expect(prompt).toContain('  第一行');
    expect(prompt).toContain('  …（略去 9 行）…');
  });

  it('没有原始记录时不留空标题', () => {
    expect(buildPrompt(task())).not.toContain('原始记录');
  });

  /**
   * 子任务的产出（团队收口）。
   *
   * 它排在原始记录之后、"要求"之前：已经做完的那部分活既不是背景，也不是又一条要求。
   * 最后那句"别照着重新做一遍"是给这一层用的——子任务各自有工作目录，父读不到里面的
   * 东西，不说清楚模型会花几步去撞墙。
   */
  it('子任务的产出单独一段，排在原始记录之后、要求之前', () => {
    const prompt = buildPrompt(
      task({
        records: [{ kind: 'event', id: 'ev-1', title: 'im/message', excerpt: '群里说报错' }],
        children: [
          {
            id: 'task-c1',
            title: '写 server.js',
            status: 'accepted',
            verdict: 'pass',
            reason: '退出码 0（90ms）',
            artifacts: ['server.js'],
          },
        ],
      }),
    );

    expect(prompt).toContain('子任务的产出（你是这条线的收口人，交付物要把它们合进去）');
    expect(prompt).toContain('- 写 server.js · task-c1 · 通过了验收');
    expect(prompt).toContain('产物：server.js');
    expect(prompt).toContain('结论：退出码 0（90ms）');
    expect(prompt).toContain('别照着重新做一遍');

    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('这件事的原始记录')).toBeLessThan(at('子任务的产出'));
    expect(at('子任务的产出')).toBeLessThan(at('要求：'));
  });

  it('没有闸门的子任务被标出来，不被当成功', () => {
    const prompt = buildPrompt(
      task({
        children: [
          { id: 'task-c1', title: '查一下日志', status: 'accepted', verdict: null, reason: '', artifacts: [] },
        ],
      }),
    );
    expect(prompt).toContain('没有闸门能判它对不对');
  });

  it('没有子任务时不留空标题', () => {
    expect(buildPrompt(task())).not.toContain('子任务的产出');
  });

  /**
   * 回答请示（W3）单独一段，排在"改方向"之前。
   *
   * 混进改方向那一段，模型会以为需求变了，于是**重做一遍**；而它该做的是接着做。
   */
  it('回答和改方向分成两段：一个是对问话的回复，一个是换了需求', () => {
    const prompt = buildPrompt(
      task({
        steering: [
          { note: '回答（我问的「A 快 B 稳，要哪个」）：选稳的那个', at: 1, kind: 'answer' },
          { note: '主题色不要用蓝的', at: 2, kind: 'steer' },
        ],
      }),
    );

    expect(prompt).toContain('他回答了你请示的问题（照这个做，不要再问一遍）');
    expect(prompt).toContain('- 回答（我问的「A 快 B 稳，要哪个」）：选稳的那个');
    expect(prompt).toContain('用户在做这件事的过程中改了方向');
    expect(prompt).toContain('- 主题色不要用蓝的');

    const at = (needle: string) => prompt.indexOf(needle);
    // 回答在前：它是"我之前问的那件事有答案了"，不是新要求。
    expect(at('他回答了你请示的问题')).toBeLessThan(at('用户在做这件事的过程中改了方向'));
    // 回答只出现在自己那一段，不重复出现在改方向里。
    expect(prompt.split('选稳的那个')).toHaveLength(2);
  });

  it('只有回答、没有改方向时，不留空标题', () => {
    const prompt = buildPrompt(
      task({ steering: [{ note: '回答：选稳的那个', at: 1, kind: 'answer' }] }),
    );
    expect(prompt).toContain('他回答了你请示的问题');
    expect(prompt).not.toContain('改了方向');
  });

  it('改过两次就两条都在，按说的顺序', () => {
    const prompt = buildPrompt(
      task({
        steering: [
          { note: '先给最小可运行版本', at: 1 },
          { note: '再加一个 /health', at: 2 },
        ],
      }),
    );

    expect(prompt.indexOf('先给最小可运行版本')).toBeLessThan(prompt.indexOf('再加一个 /health'));
  });

  it('当 objective/brief/deliverable 完全相同时自动去重，不重复拼接 3 遍', () => {
    const body = '将输入的英文简历翻译为中文 PDF 并输出到 output/resume.pdf';
    const prompt = buildPrompt(
      task({
        brief: body,
        deliverableSpec: body,
        contract: {
          objective: body,
          deliverable: body,
          outputs: [{ kind: 'file', path: 'output\\resume.pdf', description: '中文简历 PDF' }],
        },
      }),
    );

    expect(prompt.split(body)).toHaveLength(2);
    expect(prompt).toContain('- 文件 output/resume.pdf：中文简历 PDF');
  });

  it('buildRetryFeedbackPrompt 精简输出截断纠偏与工作区已有文件列表', () => {
    const retryPrompt = buildRetryFeedbackPrompt(
      task({
        contract: {
          objective: '翻译简历',
          deliverable: '中文 PDF',
          outputs: [{ kind: 'file', path: 'output/resume.pdf', description: '中文简历' }],
        },
      }),
      {
        attempt: 1,
        reason: '缺少文件交付物：output/resume.pdf',
        evidence: { command: ['opc', 'output-contract'], exitCode: 1, stdoutTail: '', stderrTail: '' },
        truncatedNoTools: true,
        existingFiles: ['output/中文版.pdf'],
      },
    );

    expect(retryPrompt).toContain('上一轮（第 1 次尝试）未通过系统验收');
    expect(retryPrompt).toContain('思考过长触及输出上限被截断');
    expect(retryPrompt).toContain('output/中文版.pdf');
    expect(retryPrompt).toContain('- 文件 output/resume.pdf：中文简历');
    expect(retryPrompt).not.toContain('验收命令退出码');
  });
});

/**
 * 插话走的是运行时的 inbox（`whenBusy: 'steer'`），不是我们自己打断 generation。
 *
 * 这是 §8.2「随时介入」唯一能落在**正在跑**的活上的机制，所以它必须被钉住：
 * 提交时带上 `whenBusy: 'steer'`、内容里带着你的原话、没有在跑的会话时如实返回
 * false（那时只能靠 `task.steering` 那条持久化的路）。
 */
describe('把话插进正在跑的活', () => {
  function fakeRuntime() {
    const submitted: { content: unknown; whenBusy?: string }[] = [];
    let finishFirst: (() => void) | undefined;
    const conversation = {
      id: 'conv-1',
      submit: async (draft: { content: unknown; whenBusy?: string }) => {
        submitted.push(draft);
        const index = submitted.length;
        return {
          wait: () =>
            index === 1
              ? new Promise((resolve) => {
                  finishFirst = () => resolve({ status: 'done' });
                })
              : new Promise(() => undefined),
        };
      },
    };
    const harness = {
      createConversation: async () => conversation,
      usage: async () => ({}),
    };
    return { submitted, harness, finish: () => finishFirst?.() };
  }

  it('正在跑的时候插进去，没在跑就说不', async () => {
    const { submitted, harness, finish } = fakeRuntime();
    const brain = new HarnessBrain({
      harnessFor: async () => ({ harness: harness as never }),
      context: async () => ({}) as never,
      model: () => ({ providerId: 'p', modelId: 'm' }),
      thinking: () => 'low',
      price: () => ({ inputUsdPerM: 0, outputUsdPerM: 0 }),
      onTokens: () => undefined,
    });

    const running = brain.execute({
      task: task(),
      workspaceDir: tmpdir(),
      log: () => undefined,
    });
    // 让 execute 走到"会话已开、正在跑"那一步。
    for (let tick = 0; tick < 20 && submitted.length === 0; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(submitted).toHaveLength(1);

    expect(await brain.interject('task-1', '改成 8080，不要 3000')).toBe(true);
    expect(submitted[1]?.whenBusy).toBe('steer');
    expect(String(submitted[1]?.content)).toContain('改成 8080，不要 3000');

    // 没有在跑的会话就如实说"插不进去"，别假装带到了。
    expect(await brain.interject('task-不存在', '换个做法')).toBe(false);

    finish();
    await running;
    // 跑完就从表里删掉：再插话不该插进一条已经结束的会话。
    expect(await brain.interject('task-1', '还有一句')).toBe(false);
  });

  it('把 durable submission 的最终 assistant 文本回传给任务结果', async () => {
    const answerEntry = {
      model: [{ role: 'assistant', content: [{ type: 'text', text: '这是最终汇报正文。' }] }],
    };
    const conversation = {
      id: 'conv-answer',
      submit: async () => ({
        wait: async () => ({ type: 'input', status: 'done', answer: 'entry-answer' }),
      }),
      commit: async (change: (tx: { entry: (id: string) => Promise<typeof answerEntry> }) => unknown) =>
        change({ entry: async () => answerEntry }),
    };
    const harness = {
      createConversation: async () => conversation,
      commit: async () => undefined,
      conversation: async () => conversation,
      usage: async () => ({}),
    };
    const brain = new HarnessBrain({
      harnessFor: async () => ({ harness: harness as never }),
      context: async () => ({}) as never,
      model: () => ({ providerId: 'p', modelId: 'm' }),
      thinking: () => 'low',
      price: () => ({ inputUsdPerM: 0, outputUsdPerM: 0 }),
      onTokens: () => undefined,
    });

    const result = await brain.execute({
      task: task(),
      workspaceDir: tmpdir(),
      durableTaskId: 'durable-task-1',
      log: () => undefined,
    });

    expect(result.answer).toBe('这是最终汇报正文。');
  });

  it('当 stopReason=length 且 0 工具调用时标记 truncatedNoTools，同任务重试自动降级 thinking 为 low 并发送精简重试提示', async () => {
    const submitted: Array<{ content: unknown }> = [];
    const configured: Array<{ thinkingLevel?: string }> = [];
    const truncatedEntry = {
      model: [{ role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: 'long...' }] }],
    };
    const conversation = {
      id: 'conv-retry',
      configure: async (next: { thinkingLevel?: string }) => {
        configured.push(next);
      },
      submit: async (draft: { content: unknown }) => {
        submitted.push(draft);
        return {
          wait: async () => ({ type: 'input', status: 'done', answer: 'entry-1' }),
        };
      },
      commit: async (change: (tx: { entry: (id: string) => Promise<typeof truncatedEntry> }) => unknown) =>
        change({ entry: async () => truncatedEntry }),
    };
    const harness = {
      createConversation: async () => conversation,
      commit: async () => undefined,
      conversation: async () => conversation,
      usage: async () => ({}),
    };
    const brain = new HarnessBrain({
      harnessFor: async () => ({ harness: harness as never }),
      context: async () => ({}) as never,
      model: () => ({ providerId: 'p', modelId: 'm' }),
      thinking: () => 'high',
      price: () => ({ inputUsdPerM: 0, outputUsdPerM: 0 }),
      onTokens: () => undefined,
    });

    const first = await brain.execute({
      task: task(),
      workspaceDir: tmpdir(),
      durableTaskId: 'durable-trunc-1',
      log: () => undefined,
    });
    expect(first.truncatedNoTools).toBe(true);
    expect(first.stopReason).toBe('length');

    await brain.execute({
      task: task(),
      workspaceDir: tmpdir(),
      durableTaskId: 'durable-trunc-1',
      feedback: {
        attempt: 1,
        reason: '缺少文件交付物：output/a.pdf',
        evidence: { command: ['opc', 'output-contract'], exitCode: 1, stdoutTail: '', stderrTail: '' },
        truncatedNoTools: true,
        existingFiles: ['output/b.pdf'],
      },
      log: () => undefined,
    });

    expect(configured).toEqual([{ model: { provider: 'p', modelId: 'm' }, thinkingLevel: 'low', cwd: tmpdir() }]);
    expect(String(submitted[1]?.content)).toContain('思考过长触及输出上限被截断');
    expect(String(submitted[1]?.content)).toContain('output/b.pdf');
    expect(String(submitted[1]?.content)).not.toContain('你要完成下面的交付契约');
  });
});
