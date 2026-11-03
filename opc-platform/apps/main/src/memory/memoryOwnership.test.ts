import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MemoryService } from './memoryService';
import { recallOwners, USER_MEMORY_OWNER } from './owners';

/**
 * 记忆的归属。
 *
 * 这一层修的是两个「不报错、测试也不会红」的 bug，所以用例必须精确到两者的差别：
 *
 * ① **关于一个人的记忆只有一个归属**。以前的实参是执行体 id，于是用户说的一句
 *    「以后结论放前面」被切成 N+1 份：Router 一份、每个执行体各一份。真实库上
 *    289 条记忆全部挂在一个已不存在的 `agent-…` 上，没有任何代码路径读得到。
 * ② **衰减只影响排序，不是删除**。以前 `strength >= 0.2` 是硬门槛，半衰期 30 天，
 *    90 天没被召回就永远查不出来——一个不通知任何人的删除机制。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-memory-owner-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('归属', () => {
  it('关于这个人只有一份：任意两个执行体读到的是同一条', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '结论放最前面，再给证据',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    const fromA = await memory.retrieve({
      owners: recallOwners({ threadId: 'th-a', workerId: 'worker-a' }),
      query: '结论 证据',
      scopes: [{ type: 'personal' }, { type: 'thread', id: 'th-a' }],
    });
    const fromB = await memory.retrieve({
      owners: recallOwners({ threadId: 'th-b', workerId: 'worker-b' }),
      query: '结论 证据',
      scopes: [{ type: 'personal' }, { type: 'thread', id: 'th-b' }],
    });

    expect(fromA.map((item) => item.content)).toEqual(['结论放最前面，再给证据']);
    expect(fromB.map((item) => item.content)).toEqual(['结论放最前面，再给证据']);
  });

  it('线上记的经验挂在线上：换一个执行体接手仍然读得到', async () => {
    // 写的人已经不在那条线上了（换人接手），但线还在。
    await memory.remember({
      ownerId: 'th-1',
      kind: 'experience',
      content: '这份财报的表格要用千分位',
      scope: { type: 'thread', id: 'th-1' },
      sourceType: 'task',
    });

    const successor = await memory.retrieve({
      owners: recallOwners({ threadId: 'th-1', workerId: 'worker-new' }),
      query: '表格 千分位',
      scopes: [{ type: 'personal' }, { type: 'thread', id: 'th-1' }],
    });
    const elsewhere = await memory.retrieve({
      owners: recallOwners({ threadId: 'th-2', workerId: 'worker-new' }),
      query: '表格 千分位',
      scopes: [{ type: 'personal' }, { type: 'thread', id: 'th-2' }],
    });

    expect(successor).toHaveLength(1);
    expect(elsewhere).toHaveLength(0);
  });

  it('三个域是并列的：一次查询能同时拿到人、线、执行体', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '图表标题一律用中文',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });
    await memory.remember({
      ownerId: 'th-1',
      kind: 'experience',
      content: '图表之前被要求过用中文标题',
      scope: { type: 'thread', id: 'th-1' },
      sourceType: 'task',
    });
    await memory.remember({
      ownerId: 'worker-a',
      kind: 'experience',
      content: '中文标题遇到过字体缺失，先装 Noto',
      scope: { type: 'personal' },
      sourceType: 'task',
    });

    const owners = recallOwners({ threadId: 'th-1', workerId: 'worker-a' });
    expect(owners).toEqual([USER_MEMORY_OWNER, 'th-1', 'worker-a']);

    const found = await memory.retrieve({
      owners,
      query: '中文标题',
      scopes: [{ type: 'personal' }, { type: 'thread', id: 'th-1' }],
      limit: 5,
    });
    expect(found).toHaveLength(3);
  });

  it('没有线也没有执行体时只查这个人，不会算出空的所有者名单', () => {
    expect(recallOwners({})).toEqual([USER_MEMORY_OWNER]);
    expect(recallOwners({ threadId: null, workerId: null })).toEqual([USER_MEMORY_OWNER]);
  });
});

describe('衰减', () => {
  it('九十天没被召回的记忆仍然取得回来（衰减只改排序）', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '写周报时不要用感叹号',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    // 半衰期 30 天：90 天后强度 0.125，旧门槛（0.2）会把它整个藏起来。
    const found = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '周报 感叹号',
      scopes: [{ type: 'personal' }],
      now: NOW + 90 * DAY,
    });
    expect(found.map((item) => item.content)).toEqual(['写周报时不要用感叹号']);
    // 排序分确实下降了，只是不再被拿来当"删不删"的开关。
    expect(found[0]!.strength).toBeLessThan(0.2);
  });

  it('新鲜的相关记忆排在陈旧的同类前面', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '周报用要点列表',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });
    const old = db
      .prepare('SELECT id FROM memory WHERE content = ?')
      .get('周报用要点列表') as { id: string };
    db.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(NOW - 200 * DAY, old.id);

    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '周报用要点列表，不要连续段落',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    const found = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '周报 要点',
      scopes: [{ type: 'personal' }],
      now: NOW,
    });
    expect(found).toHaveLength(2);
    expect(found[0]?.content).toContain('不要连续段落');
  });

  it('一条都对不上时，显式回忆给的是"最牢的几条"，不是"没有记录"', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '回答不要用被动语态',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    // 默认门槛下，完全不相干的查询什么都拿不到。
    const strict = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '数据库迁移',
      scopes: [{ type: 'personal' }],
    });
    expect(strict).toHaveLength(0);

    // 显式回忆起话（minScore: 0）会把它交出来，由模型自己判断有没有用。
    const explicit = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '数据库迁移',
      scopes: [{ type: 'personal' }],
      minRelevance: 0,
    });
    expect(explicit.map((item) => item.content)).toEqual(['回答不要用被动语态']);
    expect(explicit[0]!.relevance).toBe(0);
  });
});

describe('可寻址', () => {
  it('取回的每一条都带 id、类型、时间与出处', async () => {
    const id = await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '文档放 README 里就够了，别单开 wiki',
      scope: { type: 'personal' },
      sourceType: 'consolidation',
      sourceId: 'dm-router',
    });

    const [hit] = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: 'README wiki',
      scopes: [{ type: 'personal' }],
    });

    expect(hit?.id).toBe(id);
    expect(hit?.kind).toBe('preference');
    expect(hit?.sourceType).toBe('consolidation');
    expect(hit?.sourceId).toBe('dm-router');
    expect(hit?.createdAt).toBeGreaterThan(0);
  });

  it('按 id 能把同一条取回来（顺着记忆里的一行往回走）', async () => {
    const id = await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '先给最小可运行版本',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    const one = memory.get(id);
    expect(one?.content).toBe('先给最小可运行版本');
    expect(one?.scopeType).toBe('personal');
    expect(memory.get('mem-不存在')).toBeNull();
  });
});
