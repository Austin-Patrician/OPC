import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { WorkTask } from '@opc/shared/domain';
import { buildPrompt, HarnessBrain } from './harnessBrain';

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

  /**
   * 做事规矩（P5）：用户要求过的格式与流程。
   *
   * 它和"相关经验"必须分两段写——经验是**建议**（"可直接使用"），规矩是**约束**
   * （"必须遵守"）。当初就是因为混在一起、语气是建议，模型执行起来打了折。
   */
  it('做事规矩单独一段，口气是"必须遵守"，不是"可以参考"', () => {
    const prompt = buildPrompt(
      task({ procedural: [{ kind: 'format', content: '代码里不要写注释' }] }),
    );

    expect(prompt).toContain('用户要求过的做事规矩（必须遵守）');
    expect(prompt).toContain('- 代码里不要写注释');
    // 不能混进"相关经验"那一段。
    const ruleAt = prompt.indexOf('用户要求过的做事规矩');
    const memoryAt = prompt.indexOf('你想起的相关经验');
    expect(memoryAt).toBe(-1);
    expect(ruleAt).toBeGreaterThan(-1);
  });

  it('顺序：改过的方向 > 常驻约束 > 做事规矩 > 工作台的规定', () => {
    const prompt = buildPrompt(
      task({
        steering: [{ note: '改成 8080', at: 1 }],
        standing: [{ content: '称呼用「你」' }],
        procedural: [{ kind: 'format', content: '结论放最前面' }],
        facts: [{ statement: '交付必须带 README', scopeType: 'global' }],
      }),
    );

    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('用户在做这件事的过程中改了方向')).toBeLessThan(at('用户要求过、一直有效'));
    expect(at('用户要求过、一直有效')).toBeLessThan(at('用户要求过的做事规矩'));
    expect(at('用户要求过的做事规矩')).toBeLessThan(at('工作台的规定'));
  });

  it('没有做事规矩时不留空标题', () => {
    expect(buildPrompt(task())).not.toContain('做事规矩');
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
});
