import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { Router, composeInput, threadKeyOf, type RouterDeps } from './router';
import { DEFAULT_INLINE_BUDGET, spillText } from './inline';
import type { SemanticScreenResult, SemanticScreener } from './semanticGate';
import type { ChatAttachmentRef } from '@opc/shared/domain';

/**
 * 调度循环。
 *
 * 这一层**不含模型**，所以这里的用例都不碰 LLM——它们锁的是确定性部分：
 *
 *   - 程序层把噪声挡在模型之前（§3.1 Fast Path）
 *   - 已经订阅的事件直通给执行体，不花 Router 一个 token（§3.2 Fast Path）
 *   - 语义门（可选的分类器）只判"值不值得占用上下文"，判失败就全放行
 *   - 剩下的事件和未播报的汇报合成**一条**输入（§2.1 批处理）
 *   - 交不进去时回滚标记，宁可重讲一次也不丢（宁可重复不可丢失）
 */
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let now: number;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-router-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  now = 1_700_000_000_000;
  seq = 0;
  threads = new ThreadRepository(db, { now: () => (now += 1_000), id: () => `id-${(seq += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(overrides: Partial<RouterDeps> = {}) {
  const delivered: string[] = [];
  const passed: string[] = [];
  const router = new Router({
    threads,
    deliver: (text) => delivered.push(text),
    passthrough: (intent) => passed.push(intent.event.id),
    ...overrides,
  });
  return { router, delivered, passed };
}

describe('调度循环', () => {
  it('队列空的时候一个 token 都不花', async () => {
    const { router, delivered } = make();
    const report = await router.tick();
    expect(delivered).toHaveLength(0);
    expect(report).toEqual({
      dropped: 0,
      gated: 0,
      passthrough: 0,
      routed: 0,
      reports: 0,
      failed: 0,
    });
  });

  it('程序层丢掉的噪声见不到 Router', async () => {
    threads.enqueueEvent({ kind: 'im.typing', source: 'im' });
    const { router, delivered } = make({
      prefilter: (event) => (event.kind === 'im.typing' ? 'drop' : 'keep'),
    });

    const report = await router.tick();
    expect(report.dropped).toBe(1);
    expect(delivered).toHaveLength(0);
    expect(threads.listThreads()).toHaveLength(0);
  });

  it('定时计划事件绕过噪声与语义预筛，直接送入 Router 判断', async () => {
    threads.enqueueEvent({ source: 'manual', kind: 'schedule.due', payload: {
      title: '检查邮件', instruction: '查看最近的新邮件', scheduledFor: now, timezone: 'Asia/Shanghai',
    } });
    const { router, delivered } = make({
      prefilter: () => 'drop',
      semantic: async () => { throw new Error('定时计划不应经过语义预筛'); },
    });
    const report = await router.tick();
    expect(report.routed).toBe(1);
    expect(delivered.join('\n')).toContain('查看最近的新邮件');
    expect(delivered.join('\n')).toContain('用户提前创建的定时请求');
  });

  it('一批事件合成一条输入，不是一条一个调用', async () => {
    for (const text of ['第一件', '第二件', '第三件']) {
      threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text } });
    }
    const { router, delivered } = make();

    const report = await router.tick();
    expect(report.routed).toBe(3);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('新事件（3）');
    expect(delivered[0]).toContain('第一件');
    expect(delivered[0]).toContain('第三件');
  });

  it('把原始信道回复地址带进 Router 输入', async () => {
    threads.enqueueEvent({
      source: 'github',
      kind: 'issue_comment.created',
      payload: {
        text: '请回复到 PR',
        replyTarget: {
          adapterId: 'github',
          source: 'github',
          address: 'github:acme/api#12',
        },
      },
    });
    const { router, delivered } = make();
    await router.tick();
    expect(delivered[0]).toContain('原始信道回复地址（只能原样使用）：github:acme/api#12');
  });

  it('已订阅的线上再来事件，直通给执行体，不经过 Router', async () => {
    const thread = threads.createThread({
      title: '季度财报',
      goal: '整理 Q3 财报',
      threadKey: 'folder:inbox/q3.md',
    });
    const worker = threads.createWorker({ name: '执行体', threadId: thread.id });
    threads.subscribe(thread.id, worker.id);
    threads.enqueueEvent({
      source: 'folder',
      kind: 'file',
      payload: { path: 'inbox/q3.md', threadKey: 'folder:inbox/q3.md' },
    });

    const { router, delivered, passed } = make();
    const report = await router.tick();

    expect(report.passthrough).toBe(1);
    expect(report.routed).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(passed).toHaveLength(1);
  });

  it('直通没有接住时不确认事件，退回 Slow Path', async () => {
    const thread = threads.createThread({
      title: '季度财报',
      goal: '整理 Q3 财报',
      threadKey: 'folder:inbox/q3.md',
    });
    const worker = threads.createWorker({ name: '执行体', threadId: thread.id });
    threads.subscribe(thread.id, worker.id);
    threads.enqueueEvent({
      source: 'folder',
      kind: 'file',
      payload: { path: 'inbox/q3.md', threadKey: 'folder:inbox/q3.md' },
    });

    const { router, delivered, passed } = make({ passthrough: () => false });
    const report = await router.tick();

    expect(report.passthrough).toBe(0);
    expect(report.routed).toBe(1);
    expect(passed).toHaveLength(0);
    expect(delivered).toHaveLength(1);
  });

  it('重入 tick 返回同一轮，不会把同一批事件交两次', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '只交一次' } });
    let deliveries = 0;
    const router = new Router({
      threads,
      deliver: async () => {
        deliveries += 1;
        await Promise.resolve();
      },
    });

    const first = router.tick();
    const second = router.tick();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(deliveries).toBe(1);
  });

  it('没订阅的线仍然走 Router——直通是优化，不是正确性', async () => {
    const thread = threads.createThread({
      title: '季度财报',
      goal: '整理 Q3 财报',
      threadKey: 'folder:inbox/q3.md',
    });
    // 有线程、没订阅者：归属还不确定，必须让 Router 判。
    threads.enqueueEvent({
      source: 'folder',
      kind: 'file',
      payload: { path: 'inbox/q3.md', threadKey: 'folder:inbox/q3.md' },
    });

    const { router, delivered, passed } = make();
    const report = await router.tick();

    expect(thread.id).toBeTruthy();
    expect(report.passthrough).toBe(0);
    expect(report.routed).toBe(1);
    expect(passed).toHaveLength(0);
    expect(delivered).toHaveLength(1);
  });

  it('终态的线不再接手过路事件——那些是新工作', async () => {
    const thread = threads.createThread({
      title: '旧事',
      goal: '旧事',
      threadKey: 'folder:inbox/old.md',
    });
    const worker = threads.createWorker({ name: '执行体', threadId: thread.id });
    threads.subscribe(thread.id, worker.id);
    threads.setState(thread.id, 'done');

    threads.enqueueEvent({
      source: 'folder',
      kind: 'file',
      payload: { path: 'inbox/old.md', threadKey: 'folder:inbox/old.md' },
    });

    const { router, passed } = make();
    const report = await router.tick();
    expect(passed).toHaveLength(0);
    expect(report.routed).toBe(1);
  });

  it('汇报会被带进上下文，而且只讲一次', async () => {
    const thread = threads.createThread({ title: '整理 Q3 财报', goal: '整理' });
    // `notify` 而不是 `silent`：这一条是"你该知道一下"，所以它要走 Router 讲出去。
    threads.addReport({ threadId: thread.id, level: 'notify', title: '做完了', body: '产出 report.md' });

    const { router, delivered } = make();
    const first = await router.tick();
    expect(first.reports).toBe(1);
    expect(delivered[0]).toContain('执行体汇报（1');
    expect(delivered[0]).toContain('产出 report.md');
    expect(delivered[0]).toContain('· report · 做完了');

    // 第二轮没有新东西：讲过的不会再讲一遍。
    const second = await router.tick();
    expect(second.reports).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it('线级关闭摘要只留档，不进入 Router 通知输入', async () => {
    const thread = threads.createThread({ title: '在飞书回复张帆：好咧', source: 'manual' });
    const summary = '仍未发出；当前会话身份无法确认。';
    threads.addReport({ threadId: thread.id, level: 'silent', title: thread.title, body: summary });

    const { router, delivered } = make();
    const report = await router.tick();

    expect(report.reports).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(threads.listReportsOf(thread.id, 1)[0]?.body).toBe(summary);
  });

  it('带聊天卡片的问题不再生成第二条 Router 回复', async () => {
    const thread = threads.createThread({ title: '请示' });
    threads.addReport({ threadId: thread.id, level: 'decide', kind: 'question', title: '需要你选择', body: 'A 还是 B？' });

    const { router, delivered } = make();
    const report = await router.tick();

    expect(report.reports).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(threads.listUnannouncedReports()).toHaveLength(0);
  });

  it('Router 报告上下文包含报告类型与任务关联', () => {
    const thread = threads.createThread({ title: '处理文件' });
    const report = threads.addReport({
      threadId: thread.id,
      taskId: 'task-42',
      level: 'notify',
      title: '完成',
    });

    expect(composeInput([], [report])).toContain('· report · 任务 task-42 · 完成');
  });

  it('要求 Router 核对执行体汇报，不把工具调用或未变化标题当成效果证据', () => {
    const text = composeInput([], []);
    expect(text).toContain('汇报非核验');
    expect(text).toContain('recall task:<taskId>');
    expect(text).toContain('标题未变不证按键无效');
    expect(text).toContain('效果未确认');
  });

  it('交不进去就回滚：宁可重复一遍，不可丢一次', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    const thread = threads.createThread({ title: '线', goal: '线' });
    threads.addReport({ threadId: thread.id, level: 'notify', title: '进展' });

    let attempts = 0;
    const router = new Router({
      threads,
      deliver: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('会话挂了');
      },
    });

    const failed = await router.tick();
    expect(failed.routed).toBe(0);
    expect(failed.failed).toBe(1);

    // 事件回到 pending，汇报回到未播报。
    const retried = await router.tick();
    expect(retried.routed).toBe(1);
    expect(retried.reports).toBe(1);
  });

  it('异步交付失败也回滚 routed 和 announced', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '网络失败' } });
    const router = new Router({
      threads,
      deliver: async () => {
        throw new Error('异步会话挂了');
      },
    });

    const failed = await router.tick();
    expect(failed.routed).toBe(0);
    expect(failed.failed).toBe(1);
    expect(threads.listPendingEvents(10)).toHaveLength(1);
  });
});

describe('语义门（§3.1 Slow Path 的前半）', () => {
  /** 只判前 N 条：模拟"分类器说这几条是噪声"。 */
  const dropFirst =
    (count: number): SemanticScreener =>
    async (events): Promise<SemanticScreenResult> => ({
      keep: events.slice(count),
      dropped: events.slice(0, count),
    });

  it('被门判掉的噪声既不见 Router，也不花 Router 的上下文', async () => {
    for (const text of ['心跳', '在吗']) {
      threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text } });
    }
    const { router, delivered } = make({ semantic: dropFirst(1) });

    const report = await router.tick();
    expect(report.gated).toBe(1);
    expect(report.routed).toBe(1);
    expect(delivered[0]).toContain('在吗');
    expect(delivered[0]).not.toContain('心跳');
  });

  it('门自己炸了就全放行——省钱的层没有丢活的权力', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    const { router, delivered } = make({
      semantic: () => Promise.reject(new Error('分类器没配')),
    });

    const report = await router.tick();
    expect(report.gated).toBe(0);
    expect(report.routed).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('门报告"这批判不了"时也是全放行，但要说一句为什么', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    const { router, delivered } = make({
      semantic: async (events) => ({ keep: [...events], dropped: [], error: '没有决策模型' }),
    });

    const report = await router.tick();
    expect(report.routed).toBe(1);
    expect(report.gated).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it('没开语义门时根本不调用它——所以"关掉"就是真的没花钱', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    const { router, delivered } = make();
    const report = await router.tick();
    expect(report.routed).toBe(1);
    expect(delivered).toHaveLength(1);
  });
});

/**
 * 常驻层（`07-memory.md` 的 L0）。
 *
 * 它要证明的不是"能放进去"，是**每一轮都在**——不管这一轮的事件是什么。这就是
 * 公理 A4：必须每轮生效的东西不能依赖模型主动去取。
 */
describe('常驻约束', () => {
  it('每一轮都在输入里，和这一轮发生了什么无关', async () => {
    const { router, delivered } = make({ standing: () => ['称呼用「你」', '回答不要客套'] });
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '这个文件怎么回事' } });

    await router.tick();

    expect(delivered[0]).toContain('用户要求过、一直有效的（2 条');
    expect(delivered[0]).toContain('称呼用「你」');
    expect(delivered[0]).toContain('回答不要客套');
  });

  it('和"工作台的规矩"分开列：一个是人写的，一个是从使用里学的', async () => {
    const text = composeInput([], [], ['文档放 README 里就够了'], ['回答不要客套']);
    expect(text).toContain('工作台的规矩（1');
    expect(text).toContain('用户要求过、一直有效的（1 条');
  });

  it('没有常驻约束时不留空标题', () => {
    const text = composeInput([], [], ['文档放 README 里就够了']);
    expect(text).not.toContain('用户要求过');
  });
});

describe('上下文打包（Inline & Spill）', () => {
  it('短内容全放进去，长内容给摘要并留 recall 入口', () => {
    expect(spillText('短', 'recall x', 600)).toBe('短');
    const long = '整'.repeat(2_000);
    const packed = spillText(long, 'recall evt-1', 600);
    expect(packed.length).toBeLessThan(long.length);
    expect(packed).toContain('recall evt-1');
  });

  /**
   * 这条是**性能断言**，不是格式断言：一次输入的成本必须由预算封顶，而不是由
   * "这一轮恰好来了多少条 × 每条多少字"决定。没有它，40 条长事件能悄悄吃掉 24k 字符。
   */
  it('四十条长事件合起来也不超过预算', () => {
    const body = '这是一段很长的正文。\n'.repeat(400);
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `evt-${index}`,
      source: 'folder' as const,
      kind: 'file',
      payload: { text: body },
      threadId: null,
      triage: 'pending' as const,
      createdAt: 0,
      triagedAt: null,
    }));

    const text = composeInput(events, []);
    // 正文部分被压在预算内；其余是 id、标题、指令这些固定开销。
    const overhead = 6_000;
    expect(text.length).toBeLessThan(DEFAULT_INLINE_BUDGET.total + overhead);
    // 每条仍然留得住"去哪读全的"。
    expect(text).toContain('recall evt-39');
  });

  it('事件带 id 与并线键，模型才能顺着引用往下跳', () => {
    const text = composeInput(
      [
        {
          id: 'evt-1',
          source: 'folder',
          kind: 'file',
          payload: { path: 'inbox/a.md', threadKey: 'folder:inbox/a.md' },
          threadId: null,
          triage: 'pending',
          createdAt: 0,
          triagedAt: null,
        },
      ],
      [],
    );
    // id 就是链式召回的入口：模型看到 evt-1 就能 recall 出整条线。
    expect(text).toContain('evt-1');
    expect(text).toContain('folder:inbox/a.md');
  });

  it('把用户附件引用带进 Router 输入，并传给下一条工作线', async () => {
    const attachment = {
      id: 'att-1',
      name: 'zhihu_home.png',
      path: '/tmp/chat-attachments/zhihu_home.png',
      size: 123,
      source: 'file' as const,
    };
    let context: { attachments: readonly ChatAttachmentRef[] } | undefined;
    const router = new Router({
      threads,
      deliver: (text, _targets, input) => {
        expect(text).toContain('zhihu_home.png');
        context = input;
      },
    });
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '识别这张图', attachments: [attachment] } });

    await router.tick();

    expect(context?.attachments).toEqual([attachment]);
  });

  it('长内容不整段塞进窗口，截断处留 recall 入口', () => {
    const text = composeInput(
      [
        {
          id: 'evt-2',
          source: 'im',
          kind: 'user_message',
          payload: { text: '整'.repeat(2_000), threadKey: 'im:topic-1' },
          threadId: null,
          triage: 'pending',
          createdAt: 0,
          triagedAt: null,
        },
      ],
      [],
    );
    // 单条也不许超过 ceiling（1200 字正文）+ 规模尾巴。
    expect(text.length).toBeLessThan(1_600);
    expect(text).toContain('recall evt-2');
  });

  it('工作台的规矩每轮都带进来——规矩只有干活的人知道是不够的', () => {
    const text = composeInput([], [], ['文档放 README 里就够了', '别单开 wiki']);
    expect(text).toContain('工作台的规矩（2');
    expect(text).toContain('别单开 wiki');
  });

  it('没有 threadKey 的事件永远不并线', () => {
    expect(
      threadKeyOf({
        id: 'e',
        source: 'im',
        kind: 'user_message',
        payload: { text: '在吗' },
        threadId: null,
        triage: 'pending',
        createdAt: 0,
        triagedAt: null,
      }),
    ).toBeNull();
  });
});

/**
 * 负载：Router 的调用次数只跟"新的事件流"和"要开口说的汇报"增长，不跟事件总量增长。
 *
 * 这是原文 §3.3 的要点，也是这一层最容易退化的地方——只要有人往 Router 的输入里多塞
 * 一类东西，成本就悄悄变成线性的，而功能一点没坏，测试也不会红。所以这里数的是
 * **Router 被打扰了几次**，不是"功能对不对"。
 */
describe('Router 的负载', () => {
  function subscribedLine(key: string) {
    const thread = threads.createThread({ title: key, threadKey: key });
    const worker = threads.createWorker({ name: '李雷', threadId: thread.id });
    threads.subscribe(thread.id, worker.id);
    return { thread, worker };
  }

  it('同一身份上 20 条事件，一次都不打扰 Router', async () => {
    const { thread } = subscribedLine('github:acme/api#1');
    for (let index = 0; index < 20; index += 1) {
      threads.enqueueEvent({
        source: 'github',
        kind: 'comment.created',
        payload: { threadKey: 'github:acme/api#1', text: `第 ${index} 条评论` },
      });
    }
    const { router, delivered, passed } = make();

    const report = await router.tick();

    expect(report.passthrough).toBe(20);
    expect(report.routed).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(passed).toHaveLength(20);
    // 归属已经确定，事件不该再在 Router 的上下文里出现一遍。
    expect(threads.listPendingEvents(50)).toHaveLength(0);
    expect(threads.getThread(thread.id)?.lastActivityAt).toBeGreaterThan(0);
  });

  it('20 条没有归属的事件才是一次 Router 调用', async () => {
    for (let index = 0; index < 20; index += 1) {
      threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: `第 ${index} 句` } });
    }
    const { router, delivered } = make();

    const report = await router.tick();

    expect(report.routed).toBe(20);
    // 一条输入，不是二十条：上下文就是这个循环的缓存。
    expect(delivered).toHaveLength(1);
  });

  it('一次成功交付不惊动 Router：silent 汇报是记录，不是话', async () => {
    const { thread } = subscribedLine('folder:inbox/a.md');
    threads.addReport({ threadId: thread.id, level: 'silent', title: '做完了', body: 'server.js' });

    const { router, delivered } = make();
    const report = await router.tick();

    expect(report.reports).toBe(0);
    expect(delivered).toHaveLength(0);
    // 记录还在：安静不等于被删掉。
    expect(threads.listReportsOf(thread.id)).toHaveLength(1);
  });

  it('需要你知道的汇报才进 Router，而且和事件是同一份输入', async () => {
    const { thread } = subscribedLine('folder:inbox/b.md');
    threads.addReport({ threadId: thread.id, level: 'decide', title: '要不要发', body: '两个版本' });
    threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/b.md' } });

    const { router, delivered } = make();
    const report = await router.tick();

    expect(report.reports).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('执行体汇报');
    expect(delivered[0]).toContain('要不要发');
  });
});
