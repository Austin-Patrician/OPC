import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { MemoryService } from './memoryService';

/**
 * 记忆跟着**工作线**走。
 *
 * 这是 v2 与 v1 在记忆上唯一真正不同的一点：以前一条经验属于某个人，现在它属于
 * 某件事——同一条线索的下一个执行体读得到，换一条线就看不到。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;
let ownerId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-memory-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  // 记忆按执行体隔离；v2 里执行体就是 worker 行。
  ownerId = new ThreadRepository(db).createWorker({ name: '李雷', template: 'code' }).id;
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('thread-scoped memory', () => {
  it('keeps one line of work\'s lessons out of another', async () => {
    await memory.remember({
      ownerId,
      kind: 'experience',
      content: '这份财报的表格要用千分位',
      scope: { type: 'thread', id: 'th-1' },
      sourceType: 'task',
    });

    const here = await memory.retrieve({
      ownerId,
      query: '财报 表格',
      scopes: [{ type: 'thread', id: 'th-1' }],
    });
    const elsewhere = await memory.retrieve({
      ownerId,
      query: '财报 表格',
      scopes: [{ type: 'thread', id: 'th-2' }],
    });

    expect(here).toHaveLength(1);
    expect(elsewhere).toHaveLength(0);
  });

  it('still honours the older personal scope, which now means "my own habit"', async () => {
    await memory.remember({
      ownerId,
      kind: 'preference',
      content: '先给结论再给证据',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    const found = await memory.retrieve({
      ownerId,
      query: '结论 证据',
      scopes: [{ type: 'personal' }],
    });
    expect(found).toHaveLength(1);
  });

  it('lets one query span the thread and the person at once', async () => {
    await memory.remember({
      ownerId,
      kind: 'experience',
      content: '这条线要先读附录',
      scope: { type: 'thread', id: 'th-1' },
      sourceType: 'task',
    });
    await memory.remember({
      ownerId,
      kind: 'preference',
      content: '表格一律用千分位',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    const both = await memory.retrieve({
      ownerId,
      query: '千分位 附录',
      scopes: [{ type: 'thread', id: 'th-1' }, { type: 'personal' }],
    });
    expect(both).toHaveLength(2);
  });
});
