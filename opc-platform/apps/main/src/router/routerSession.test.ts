import { describe, expect, it, vi } from 'vitest';
import { Harness, createRegistry, type Conversation, type Harness as HarnessType } from '@earendil-works/pi-durable';
import { RouterSession } from './routerSession';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { applySqliteMigrations, SQLITE_MIGRATIONS } from '@earendil-works/pi-durable/storage/sqlite';
import { createModels } from '@earendil-works/pi-ai/models';
import { openRouterStorage } from './routerStorage';

describe('RouterSession', () => {
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
