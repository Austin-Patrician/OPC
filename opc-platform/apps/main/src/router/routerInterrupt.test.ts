import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistry, type EntryId } from '@earendil-works/pi-durable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { Router } from './router';
import { RouterInterruptedError, RouterSession } from './routerSession';
import { createRouterTools } from './routerTools';

let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let now: number;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-router-interrupt-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  now = 1_700_000_000_000;
  seq = 0;
  threads = new ThreadRepository(db, { now: () => (now += 1_000), id: () => `id-${(seq += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Router 实时打断（Option A 与停止按钮）', () => {
  it('Option A：用户新消息打断正在思考的 Router，不记故障且下一轮合并两条输入', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '帮我写个爬虫' } });

    const delivered: string[] = [];
    const faults: string[] = [];
    let rejectFirst: ((err: Error) => void) | null = null;

    const router = new Router({
      threads,
      faults: {
        recordSafely: (input: { kind: string }) => {
          faults.push(input.kind);
        },
      } as never,
      abortCurrent: () => {
        rejectFirst?.(new Error('Router 一轮未完成（unanswered）'));
      },
      deliver: async (text) => {
        delivered.push(text);
        if (delivered.length === 1) {
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
      },
    });

    const firstTick = router.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(router.busy).toBe(true);

    // User immediately interrupts with a correction before Router finishes Turn 1.
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '算了改成抓 RSS' } });
    const interrupted = await router.interrupt('user_new_message', { requeue: true });
    await firstTick;

    expect(interrupted).toBe(true);
    expect(faults).toHaveLength(0);

    // Next tick batches both the interrupted message and the new correction cleanly.
    const second = await router.tick();
    expect(second.routed).toBe(2);
    expect(delivered[1]).toContain('帮我写个爬虫');
    expect(delivered[1]).toContain('算了改成抓 RSS');
  });

  it('停止按钮（requeue: false）：打断当前轮次且不自动重放被取消的输入', async () => {
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '做个很长的任务' } });

    let rejectFirst: ((err: Error) => void) | null = null;
    const delivered: string[] = [];

    const router = new Router({
      threads,
      abortCurrent: () => {
        rejectFirst?.(new Error('aborted'));
      },
      deliver: async (text) => {
        delivered.push(text);
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      },
    });

    const firstTick = router.tick();
    await new Promise((resolve) => setImmediate(resolve));

    await router.interrupt('用户点击停止', { requeue: false });
    await firstTick;

    expect(threads.listPendingEvents(10)).toHaveLength(0);
    const next = await router.tick();
    expect(next.routed).toBe(0);
    expect(delivered).toHaveLength(1);
  });
});

describe('RouterSession 死分支裁剪、完成折叠与上下文体检', () => {
  function fakeSession() {
    const entries: Array<{ id: EntryId; kind: string }> = [
      { id: 1 as EntryId, kind: 'pi.system' },
      { id: 2 as EntryId, kind: 'pi.user' },
      { id: 3 as EntryId, kind: 'pi.assistant' },
    ];
    const submitted: unknown[] = [];
    let aborted = false;
    let compactedWith: string | undefined;
    let resetWith: string | undefined;
    let finishWait: ((val: { status: string; reason?: string }) => void) | null = null;

    const conversation = {
      id: 1,
      configure: async () => undefined,
      context: async () => ({
        head: undefined,
        entries: [...entries],
        contributions: [],
        messages: entries.map((e) => ({ role: e.kind === 'pi.assistant' ? 'assistant' : 'user', content: 'x'.repeat(120) })),
      }),
      submit: async (draft: { type: string; entry?: { kind: string; edits?: unknown[] } }) => {
        submitted.push(draft);
        if (draft.type === 'write') {
          return { wait: async () => ({ status: 'done' }) };
        }
        // Simulate new entries appended during this turn.
        entries.push({ id: 4 as EntryId, kind: 'pi.user' }, { id: 5 as EntryId, kind: 'pi.assistant' });
        return {
          wait: () =>
            new Promise<{ status: string; reason?: string }>((resolve) => {
              finishWait = resolve;
            }),
        };
      },
      abort: async () => {
        aborted = true;
        finishWait?.({ status: 'unanswered', reason: 'aborted' });
      },
      compact: async (instructions?: string) => {
        compactedWith = instructions;
        return 99;
      },
      reset: async (handoff?: string) => {
        resetWith = handoff;
        entries.length = 1;
      },
    };

    const harness = {
      root: async () => conversation,
      usage: async () => ({}),
    };

    let onTurnCalls: Array<{ ok: boolean; error?: string }> = [];
    const session = new RouterSession({
      harness: async () => harness as never,
      context: async () => ({}),
      model: () => ({ providerId: 'p', modelId: 'm' }),
      thinking: () => 'low',
      cwd: () => dir,
      contextWindow: () => 100_000,
      onTurn: (info) => {
        onTurnCalls.push(info);
      },
    });

    return {
      session,
      submitted,
      onTurnCalls,
      resetOnTurn: () => {
        onTurnCalls = [];
      },
      get aborted() {
        return aborted;
      },
      get compactedWith() {
        return compactedWith;
      },
      get resetWith() {
        return resetWith;
      },
      finishOk: () => finishWait?.({ status: 'done' }),
      finishUnanswered: (reason = 'provider_error') => finishWait?.({ status: 'unanswered', reason }),
    };
  }

  it('abortCurrent 中止生成并用 ContextEdit(replace + omit) 清理当前轮次的死分支，不触发错误回调', async () => {
    const env = fakeSession();
    const running = env.session.deliver('试一个错误方向').catch((err) => err);
    await new Promise((resolve) => setImmediate(resolve));

    await env.session.abortCurrent('用户改主意');
    const caught = await running;

    expect(caught).toBeInstanceOf(RouterInterruptedError);
    expect(env.session.error).toBeNull();
    expect(env.onTurnCalls).toHaveLength(0);
    expect(env.aborted).toBe(true);
    const pruneWrite = env.submitted.find(
      (item) => (item as { type?: string; entry?: { kind?: string } }).entry?.kind === 'opc.prune',
    ) as { entry: { edits: Array<{ target: number; action: string }> } } | undefined;

    expect(pruneWrite).toBeDefined();
    expect(pruneWrite?.entry.edits).toHaveLength(2);
    expect(pruneWrite?.entry.edits[0]).toMatchObject({ target: 4, action: 'replace' });
    expect(pruneWrite?.entry.edits[1]).toEqual({ target: 5, action: 'omit' });

    const stats = await env.session.contextStats();
    expect(stats.prunedCount).toBe(2);
  });

  it('非中断导致的 unanswered 错误会在异常消息里保留具体 reason 并记入 session.error', async () => {
    const env = fakeSession();
    const running = env.session.deliver('触发上游失败').catch((err) => err);
    await new Promise((resolve) => setImmediate(resolve));

    env.finishUnanswered('provider_error');
    const caught = await running;

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RouterInterruptedError);
    expect((caught as Error).message).toContain('unanswered: provider_error');
    expect(env.session.error).toContain('provider_error');
    expect(env.onTurnCalls).toEqual([{ ok: false, error: expect.stringContaining('provider_error') }]);
  });

  it('collapseThreadTurns 将已结束工作线的轮次折叠为 1 行摘要', async () => {
    const env = fakeSession();
    const running = env.session.deliver('处理 th-99');
    await new Promise((resolve) => setImmediate(resolve));
    env.session.noteThreadTouched('th-99');
    env.finishOk();
    await running;

    const collapsed = await env.session.collapseThreadTurns('th-99', '产出 report.md');
    expect(collapsed).toBe(2);

    const pruneWrite = env.submitted.find(
      (item) => (item as { entry?: { kind?: string; data?: { reason?: string } } }).entry?.data?.reason === 'thread_collapse',
    ) as { entry: { edits: Array<{ target: number; action: string }> } } | undefined;
    expect(pruneWrite?.entry.edits[0]?.action).toBe('replace');
    expect(pruneWrite?.entry.edits[1]?.action).toBe('omit');
  });

  it('支持手动 compactNow 与 resetTopic 清理焦点', async () => {
    const env = fakeSession();
    const compactResult = await env.session.compactNow();
    expect(compactResult.ok).toBe(true);
    expect(env.compactedWith).toContain('控制面上下文');

    const resetResult = await env.session.resetTopic('新焦点：重构首页');
    expect(resetResult.ok).toBe(true);
    expect(env.resetWith).toBe('新焦点：重构首页');
  });
});

describe('Router 工具带与动态 PromptSection（防每轮重复注入）', () => {
  it('将 rules、standing 与 active-lines-board 挂载为动态 PromptSection，并支持 continue_line 与 abort_line', async () => {
    const continued = vi.fn(async () => ({ ok: true as const, threadId: 'th-1', taskId: 'task-2', mode: 'append' as const }));
    const aborted = vi.fn(async () => ({ ok: true, abortedTasks: 1 }));
    const opened: unknown[] = [];

    const extension = createRouterTools({
      openLine: (input) => {
        opened.push(input);
        return { ok: true, threadId: 'th-2', workerId: 'w-2', taskId: 'task-3' };
      },
      reply: () => undefined,
      recall: (id) => id,
      lines: () => [],
      steerLine: async () => ({ ok: true, live: 1, queued: 0 }),
      continueLine: continued,
      abortLine: aborted,
      askUser: () => ({ ok: true }),
      closeLine: () => ({ ok: true }),
      remember: async () => ({ ok: true, id: 'mem-1' }),
      forget: async () => ({ ok: true }),
      recallMemory: async () => ({ ok: true, items: [] }),
      rulesSection: () => '## 工作台的规矩\n- 交付带 README',
      standingSection: () => '## 用户常驻偏好\n- 结论先行',
      activeLinesBoard: () => '## 当前工作线看板\n- th-1 · 「写网页」 · 状态=done',
    });

    const sectionKeys = (extension.sections ?? []).map((s) => s.key);
    expect(sectionKeys).toContain('workspace-rules');
    expect(sectionKeys).toContain('user-standing');
    expect(sectionKeys).toContain('active-lines-board');

    const boardText = await extension.sections?.find((s) => s.key === 'active-lines-board')?.render({} as never, {} as never);
    expect(boardText).toContain('th-1');

    const registry = createRegistry();
    registry.install(extension);
    const findTool = (name: string) =>
      registry.snapshot().tools().find((t) => t.tool.name === name)?.tool as unknown as {
        execute: (args: unknown) => Promise<{ output: { text: string }[] }>;
      };

    // continue_line works for incremental append
    const contRes = await findTool('continue_line').execute({
      thread_id: 'th-1',
      instruction: '加个暗黑模式切换按钮',
      mode: 'append',
    });
    expect(continued).toHaveBeenCalledWith({
      threadId: 'th-1',
      instruction: '加个暗黑模式切换按钮',
      mode: 'append',
    });
    expect(contRes.output[0]?.text).toContain('增量修改');

    // abort_line works
    const abortRes = await findTool('abort_line').execute({
      thread_id: 'th-1',
      reason: '方向不对',
    });
    expect(aborted).toHaveBeenCalledWith('th-1', '方向不对', { closeThread: false });
    expect(abortRes.output[0]?.text).toContain('已中止');

    // open_line_of_work works even when outputs is omitted
    await findTool('open_line_of_work').execute({
      contract: { objective: '查一下天气', deliverable: '给出今天气温' },
    });
    expect((opened[0] as { contract: { outputs: unknown[] } }).contract.outputs).toHaveLength(1);
  });
});
