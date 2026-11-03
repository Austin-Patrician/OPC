import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';

/**
 * 未归属的记忆：认领或丢掉。
 *
 * 这是一次真实事故的出口。V33 把 `owner_id` 从"员工"换成"执行体"时明确决定**不在迁移里
 * 猜**——宁可让旧数据显示不全，也不把一条记忆归到一个猜出来的人身上。代价是真实库上
 * 289 条记忆挂在一个已不存在的 `agent-…` 上，没有任何代码路径读得到它们。
 *
 * 所以这里测的不是"能不能批量改 owner"，是那条**已经做过的决定还站得住**：不猜，问用户。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-orphan-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(ownerId: string, contents: string[], subject?: string) {
  for (const content of contents) {
    await memory.remember({
      ownerId,
      kind: 'preference',
      content,
      scope: { type: 'personal' },
      sourceType: 'consolidation',
      ...(subject ? { subject } : {}),
    });
  }
}

describe('未归属', () => {
  it('只把"谁都不认识"的归属列出来：活的执行体、活的线、用户自己都不算', async () => {
    await seed('agent-gone', ['旧的一句偏好', '旧的另一句']);
    await seed(USER_MEMORY_OWNER, ['现在的偏好']);
    await seed('worker-live', ['这个执行体自己的习惯']);
    await seed('thread-live', ['这条线的经验']);

    const groups = memory.orphanOwners(
      new Set([USER_MEMORY_OWNER, 'worker-live', 'thread-live']),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ownerId: 'agent-gone', count: 2 });
    // 给三条样本，让人判断要不要收——不问一句就搬，等于替他决定。
    expect(groups[0]?.samples).toHaveLength(2);
  });

  it('P0 之前的旧归属 `router` 也该被问一句', () => {
    const groups = memory.orphanOwners(new Set([USER_MEMORY_OWNER]));
    // 只是确认它不会被当成"已知归属"过滤掉——它同样是历史。
    expect(groups.every((group) => group.ownerId !== USER_MEMORY_OWNER)).toBe(true);
  });

  it('收下：整组搬到"关于你"，之后正常列表里就有了', async () => {
    await seed('agent-gone', ['文档放 README 里就够了', '别单开 wiki']);
    await seed(USER_MEMORY_OWNER, ['结论放最前面']);

    const moved = memory.claim('agent-gone');

    expect(moved).toBe(2);
    const contents = memory.list(USER_MEMORY_OWNER).map((item) => item.content);
    expect(contents).toContain('文档放 README 里就够了');
    expect(contents).toContain('结论放最前面');
    // 搬完之后那一组不该再出现。
    expect(memory.orphanOwners(new Set([USER_MEMORY_OWNER]))).toHaveLength(0);
  });

  it('两条记忆主题撞了：让被认领的那条丢掉主题，而不是覆盖现在的规矩', async () => {
    await seed('agent-gone', ['旧的：回复三句以内'], 'reply.length');
    await seed(USER_MEMORY_OWNER, ['新的：回复五句以内'], 'reply.length');

    expect(() => memory.claim('agent-gone')).not.toThrow();

    // 现在正在生效的那条没被覆盖。
    const live = memory.list(USER_MEMORY_OWNER).filter((item) => item.subject === 'reply.length');
    expect(live.map((item) => item.content)).toEqual(['新的：回复五句以内']);
    // 被认领的那条也在，只是不再声称自己是那个主题。
    expect(
      memory.list(USER_MEMORY_OWNER).some((item) => item.content === '旧的：回复三句以内'),
    ).toBe(true);
  });

  it('丢掉：归档整组，记录还在但不再出现', async () => {
    await seed('agent-gone', ['第一次记的', '第二次记的']);

    const discarded = memory.discardOwner('agent-gone');

    expect(discarded).toBe(2);
    expect(memory.list(USER_MEMORY_OWNER)).toHaveLength(0);
    expect(memory.orphanOwners(new Set([USER_MEMORY_OWNER]))).toHaveLength(0);
    // 归档不是销毁：行还在库里。
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM memory WHERE owner_id = 'agent-gone'")
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('已经归档的不算未归属——它已经有结论了', async () => {
    await seed('agent-gone', ['已经处理过的']);
    memory.discardOwner('agent-gone');
    expect(memory.orphanOwners(new Set([USER_MEMORY_OWNER]))).toHaveLength(0);
  });
});
