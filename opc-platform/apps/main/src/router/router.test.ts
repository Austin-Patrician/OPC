import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { Router, composeInput, spill, threadKeyOf, type RouterDeps } from './router';

/**
 * 调度循环。
 *
 * 这一层**不含模型**，所以这里的用例都不碰 LLM——它们锁的是确定性部分：
 *
 *   - 程序层把噪声挡在模型之前（§3.1 Fast Path）
 *   - 已经订阅的事件直通给执行体，不花 Router 一个 token（§3.2 Fast Path）
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
  it('队列空的时候一个 token 都不花', () => {
    const { router, delivered } = make();
    const report = router.tick();
    expect(delivered).toHaveLength(0);
    expect(report).toEqual({ dropped: 0, passthrough: 0, routed: 0, reports: 0, failed: 0 });
  });

  it('程序层丢掉的噪声见不到 Router', () => {
    threads.enqueueEvent({ kind: 'im.typing', source: 'im' });
    const { router, delivered } = make({
      prefilter: (event) => (event.kind === 'im.typing' ? 'drop' : 'keep'),
    });

    const report = router.tick();
    expect(report.dropped).toBe(1);
    expect(delivered).toHaveLength(0);
    expect(threads.listThreads()).toHaveLength(0);
  });

  it('一批事件合成一条输入，不是一条一个调用', () => {
    for (const text of ['第一件', '第二件', '第三件']) {
      threads.enqueueEvent({ source: 'im', kind: 'boss_message', payload: { text } });
    }
    const { router, delivered } = make();

    const report = router.tick();
    expect(report.routed).toBe(3);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('新事件（3）');
    expect(delivered[0]).toContain('第一件');
    expect(delivered[0]).toContain('第三件');
  });

  it('已订阅的线上再来事件，直通给执行体，不经过 Router', () => {
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
    const report = router.tick();

    expect(report.passthrough).toBe(1);
    expect(report.routed).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(passed).toHaveLength(1);
  });

  it('没订阅的线仍然走 Router——直通是优化，不是正确性', () => {
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
    const report = router.tick();

    expect(thread.id).toBeTruthy();
    expect(report.passthrough).toBe(0);
    expect(report.routed).toBe(1);
    expect(passed).toHaveLength(0);
    expect(delivered).toHaveLength(1);
  });

  it('终态的线不再接手过路事件——那些是新工作', () => {
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
    const report = router.tick();
    expect(passed).toHaveLength(0);
    expect(report.routed).toBe(1);
  });

  it('汇报会被带进上下文，而且只讲一次', () => {
    const thread = threads.createThread({ title: '整理 Q3 财报', goal: '整理' });
    threads.addReport({ threadId: thread.id, level: 'silent', title: '做完了', body: '产出 report.md' });

    const { router, delivered } = make();
    const first = router.tick();
    expect(first.reports).toBe(1);
    expect(delivered[0]).toContain('执行体汇报（1');
    expect(delivered[0]).toContain('产出 report.md');

    // 第二轮没有新东西：讲过的不会再讲一遍。
    const second = router.tick();
    expect(second.reports).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it('交不进去就回滚：宁可重复一遍，不可丢一次', () => {
    threads.enqueueEvent({ source: 'im', kind: 'boss_message', payload: { text: '在吗' } });
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

    const failed = router.tick();
    expect(failed.routed).toBe(0);
    expect(failed.failed).toBe(1);

    // 事件回到 pending，汇报回到未播报。
    const retried = router.tick();
    expect(retried.routed).toBe(1);
    expect(retried.reports).toBe(1);
  });
});

describe('上下文打包（Inline & Spill）', () => {
  it('短内容全放进去，长内容截断并留 recall 入口', () => {
    expect(spill('短', 'recall x')).toBe('短');
    const long = '整'.repeat(2_000);
    const packed = spill(long, 'recall evt-1');
    expect(packed.length).toBeLessThan(long.length);
    expect(packed).toContain('recall evt-1');
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

  it('长内容不整段塞进窗口，截断处留 recall 入口', () => {
    const text = composeInput(
      [
        {
          id: 'evt-2',
          source: 'im',
          kind: 'boss_message',
          payload: { text: '整'.repeat(2_000), threadKey: 'im:topic-1' },
          threadId: null,
          triage: 'pending',
          createdAt: 0,
          triagedAt: null,
        },
      ],
      [],
    );
    expect(text.length).toBeLessThan(1_200);
    expect(text).toContain('recall evt-2');
  });

  it('没有 threadKey 的事件永远不并线', () => {
    expect(
      threadKeyOf({
        id: 'e',
        source: 'im',
        kind: 'boss_message',
        payload: { text: '在吗' },
        threadId: null,
        triage: 'pending',
        createdAt: 0,
        triagedAt: null,
      }),
    ).toBeNull();
  });
});
