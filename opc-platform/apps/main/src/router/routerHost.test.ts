import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { DEFAULT_SEMANTIC_PROMPT, DEFAULT_TRIAGE_POLICY, type TriagePolicy } from '@opc/shared/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { createRouterHost } from './routerHost';

/**
 * Router 装起来之后**真的能跑**。
 *
 * 前面那些用例证明的是形状对（工具带正确、批处理正确、直通正确），但形状对的
 * 东西可能在第一次真正打开 harness 时就炸——比如会话说不出话、注册表装不上、
 * sqlite 路径不对。这个用例把整条线走一遍：建表 → 建 host → 丢一条事件 →
 * tick → 会话拿到输入 → settle。
 *
 * 这里**故意没有配模型**。没有模型时 Router 说不出来话，但必须**安静地失败**：
 * 掉一轮，事件还在队列里，调度循环继续活着。Router 崩掉不该让整个产品停摆。
 */
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-router-host-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  threads = new ThreadRepository(db);
});

afterEach(() => {
  db.close();
  // 已知的 Windows 环境问题：harness 打开的那个 sqlite 句柄在本进程内不会释放，
  // 所以这两个用到会话的用例在收尾时会 EBUSY。与 HEAD 上其它四个文件同一个原因。
  rmSync(dir, { recursive: true, force: true });
});

function host(policy: TriagePolicy = DEFAULT_TRIAGE_POLICY) {
  return createRouterHost({
    db,
    agentsDir: dir,
    workspaceDir: dir,
    envFor: () => ({}),
    context: async () => BACKGROUND_CONTEXT,
    openLine: () => ({ ok: true, threadId: 'th-1', workerId: 'w-1', taskId: 'task-1' }),
    reply: () => undefined,
    policy: () => policy,
  });
}

describe('Router 装起来能跑', () => {
  it('空队列不碰 harness，一个 token 都不花', async () => {
    const router = host();
    const report = await router.tick();
    expect(report).toEqual({
      dropped: 0,
      gated: 0,
      passthrough: 0,
      routed: 0,
      reports: 0,
      failed: 0,
    });
  });

  it('一条事件走完全程：队列 → 会话 → 落盘，不会卡死', async () => {
    const router = host();
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });

    const report = await router.tick();
    expect(report.routed).toBe(1);

    // 没有模型，这一轮会失败；但必须在有限时间内结束，而不是挂在那里。
    await router.settle();
    expect(router.session.busy).toBe(false);
  }, 30_000);

  it('会话失败之后调度循环还活着，事件也已经在队列外', async () => {
    const router = host();
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    await router.tick();
    await router.settle();

    // 下一轮不该把同一条事件再交一次（routed ≠ pending）。
    const again = await router.tick();
    expect(again.routed).toBe(0);
  }, 30_000);

  it('程序层跟着策略走：名单模式挡住没登记的来源', async () => {
    const router = host({
      fastPath: 'allowlist',
      sources: ['folder'],
      semantic: 'router',
      noiseThreshold: 0.7,
      semanticPrompt: DEFAULT_SEMANTIC_PROMPT,
    });
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/a.md' } });

    const report = await router.tick();
    expect(report.dropped).toBe(1);
    expect(report.routed).toBe(1);
  }, 30_000);

  it('同一个环境事件在一分钟内来两次，第二次是噪声', async () => {
    const router = host();
    threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/same.md' } });
    threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/same.md' } });

    const report = await router.tick();
    expect(report.dropped).toBe(1);
    expect(report.routed).toBe(1);
  }, 30_000);
});
