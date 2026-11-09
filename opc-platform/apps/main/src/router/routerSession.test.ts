import { describe, expect, it, vi } from 'vitest';
import { Harness, createRegistry, type Conversation, type Harness as HarnessType } from '@earendil-works/pi-durable';
import { hasLiveToolRound, RouterSession, textFromLive } from './routerSession';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { applySqliteMigrations, SQLITE_MIGRATIONS } from '@earendil-works/pi-durable/storage/sqlite';
import { createModels } from '@earendil-works/pi-ai/models';
import { openRouterStorage } from './routerStorage';

describe('RouterSession', () => {
  it('从 pi.live 只提取面向用户的文本块', () => {
    expect(textFromLive({
      generation: {
        message: {
          content: [
            { type: 'thinking', thinking: '内部推理' },
            { type: 'text', text: '先给结论' },
            { type: 'toolCall', name: 'reply_to_user', arguments: '{}' },
            { type: 'text', text: '，再给依据' },
          ],
        },
      },
    })).toBe('先给结论，再给依据');
    expect(textFromLive({ generation: { message: { content: [{ type: 'thinking', thinking: '隐藏' }] } } })).toBe('');
  });

  it('进入工具轮时通知宿主清掉工具调用前的临时文本', async () => {
    let listener: ((call: { kind: 'value'; value: { docs: Record<string, unknown> } }) => Promise<void>) | undefined;
    const onToolRound = vi.fn();
    const watch = {
      value: { docs: {} },
      start: (callback: typeof listener) => { listener = callback; },
      stop: vi.fn(async () => ({ kind: 'stopped' })),
    };
    const conversation = {
      watch: vi.fn(async () => watch),
      submit: vi.fn(async () => ({ wait: async () => ({ status: 'done' }) })),
    } as unknown as Conversation;
    const session = new RouterSession({
      harness: async () => ({ root: async () => conversation } as unknown as HarnessType),
      context: async () => ({}),
      model: () => null,
      thinking: () => 'low',
      cwd: () => '.',
      onToolRound,
    });

    const pending = session.deliver('派活');
    await vi.waitFor(() => expect(listener).toBeDefined());
    await listener!({
      kind: 'value',
      value: { docs: { 'pi.live': { generation: { message: { content: [{ type: 'text', text: '我先处理一下' }] } } } } },
    });
    await listener!({
      kind: 'value',
      value: { docs: { 'pi.live': { tools: [{ name: 'open_line_of_work', status: 'running' }] } } },
    });
    await pending;
    expect(onToolRound).toHaveBeenCalledTimes(1);
  });

  it('结束提交前排空最后一个 watch 回调，避免完成后又复活流式光标', async () => {
    let listener: ((call: { kind: 'value'; value: { docs: Record<string, unknown> } }) => Promise<void>) | undefined;
    const onText = vi.fn();
    const watch = {
      value: { docs: {} },
      start: (callback: typeof listener) => { listener = callback; },
      stop: vi.fn(async () => ({ kind: 'stopped' })),
    };
    const conversation = {
      watch: vi.fn(async () => watch),
      // The runtime may have queued the final watch callback while the
      // submission already reports done. The session must drain it before
      // resolving deliver().
      submit: vi.fn(async () => {
        void listener?.({
          kind: 'value',
          value: { docs: { 'pi.live': { generation: { message: { content: [{ type: 'text', text: '最终答复' }] } } } } },
        });
        return { wait: async () => ({ status: 'done' }) };
      }),
    } as unknown as Conversation;
    const session = new RouterSession({
      harness: async () => ({ root: async () => conversation } as unknown as HarnessType),
      context: async () => ({}),
      model: () => null,
      thinking: () => 'low',
      cwd: () => '.',
      onText,
    });

    await session.deliver('派活');
    expect(onText).toHaveBeenCalledWith('最终答复');
  });

  it('兼容工具槽位尚未提交、但 assistant 已经出现 tool call 的 live 形状', () => {
    expect(hasLiveToolRound({ generation: { message: { content: [{ type: 'toolCall', name: 'open_line_of_work' }] } } })).toBe(true);
    expect(hasLiveToolRound({ tools: [{ name: 'open_line_of_work', status: 'running' }] })).toBe(true);
    expect(hasLiveToolRound({ generation: { message: { content: [{ type: 'text', text: '答复' }] } } })).toBe(false);
  });

  it('creates one root conversation when deliveries arrive concurrently', async () => {
    const conversation = {
      submit: vi.fn(async () => ({ wait: async () => ({ status: 'done' }) })),
    } as unknown as Conversation;
    const root = vi.fn(async () => conversation);
    const harness = { root } as unknown as HarnessType;
    const session = new RouterSession({
      harness: async () => harness,
      context: async () => ({}),
      model: () => null,
      thinking: () => 'low',
      cwd: () => '.',
    });

    await Promise.all([session.deliver('first'), session.deliver('second')]);

    expect(root).toHaveBeenCalledTimes(1);
    expect(conversation.submit).toHaveBeenCalledTimes(2);
  });

  it('repairs a Router database whose allocator collides with the reserved root ID', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-router-storage-'));
    const file = path.join(dir, 'router.sqlite');
    try {
      const database = await openNodeSqliteDatabase(file);
      await applySqliteMigrations(database, SQLITE_MIGRATIONS);
      await database.run("UPDATE durable_metadata SET next_id = '1' WHERE singleton = 1");
      await database.close();

      const harness = await Harness.open(await openRouterStorage(file), {
        models: createModels(),
        registry: createRegistry(),
      }, BACKGROUND_CONTEXT);
      const root = await harness.root(BACKGROUND_CONTEXT);
      expect(root.id).toBe(1);
      await harness.close(BACKGROUND_CONTEXT);

      const verify = await openNodeSqliteDatabase(file);
      const metadata = await verify.get<{ next_id: string }>(
        'SELECT next_id FROM durable_metadata WHERE singleton = 1',
      );
      expect(Number(metadata?.next_id)).toBeGreaterThan(1);
      await verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
