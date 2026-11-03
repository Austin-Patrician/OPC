import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MAX_STANDING, MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';

/**
 * 常驻层（L0）。
 *
 * 它解决的是一条公理：**必须每轮生效的东西，不能依赖模型主动去取**
 * （`07-memory.md` 公理 A4）。模型不会在回答「帮我看下这个」时先想起来去 recall 一条
 * 「回答不要客套」——所以那一小撮东西必须原样在场。
 *
 * 三条用例对应三个设计决定：
 *
 * 1. **不参与检索、不看相关度、不衰减**：不管这一轮问的是什么，它都在。
 * 2. **有硬上限**：满 20 条就拒绝，而不是悄悄淘汰最旧的那条（那是无提示的删除）。
 * 3. **可以撤掉**：没有撤入口的常驻层，一旦填满就永久填满，而里面每一条都在替你说话。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-standing-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stand(content: string, owner = USER_MEMORY_OWNER): Promise<string> {
  return memory.remember({
    ownerId: owner,
    kind: 'preference',
    content,
    scope: { type: 'personal' },
    sourceType: 'manual',
    tier: 'standing',
  });
}

describe('常驻层', () => {
  it('和长期记忆分开：standing 的那几条独占一列，检索看不到它们', async () => {
    await stand('回答不要客套');
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '回答不要客套，直接给结论',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });

    expect(memory.standing(USER_MEMORY_OWNER).map((item) => item.content)).toEqual(['回答不要客套']);

    // 检索只回长期记忆：常驻层不参与"相关度"这场比赛，它已经在场了。
    const found = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '客套',
      scopes: [{ type: 'personal' }],
    });
    expect(found.map((item) => item.content)).toEqual(['回答不要客套，直接给结论']);
    expect(found.every((item) => item.tier === 'long')).toBe(true);
  });

  it('永不衰减：一年之后它还在，而且是原样', async () => {
    const id = await stand('称呼用「你」，不用「您」');
    db.prepare('UPDATE memory SET created_at = ?, strength = 0.05 WHERE id = ?').run(
      Date.now() - 365 * DAY,
      id,
    );

    const still = memory.standing(USER_MEMORY_OWNER);
    expect(still).toHaveLength(1);
    expect(still[0]?.content).toBe('称呼用「你」，不用「您」');
  });

  it('顺序稳定：按记下的先后排，不吃提示词缓存也不骗人', async () => {
    await stand('第一条');
    await stand('第二条');
    await stand('第三条');
    expect(memory.standing(USER_MEMORY_OWNER).map((item) => item.content)).toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
  });

  it('同样的内容不记第二遍——常驻层只有那么多位置', async () => {
    await stand('回答不要客套');
    await expect(stand('回答不要客套')).rejects.toThrow('已经在常驻约束里');
    expect(memory.countStanding(USER_MEMORY_OWNER)).toBe(1);
  });

  it('满了就明说满了，而不是悄悄淘汰最旧的一条', async () => {
    for (let index = 0; index < MAX_STANDING; index += 1) {
      await stand(`第 ${index} 条约束`);
    }

    await expect(stand('第 21 条约束')).rejects.toThrow('满了');
    const kept = memory.standing(USER_MEMORY_OWNER);
    expect(kept).toHaveLength(MAX_STANDING);
    // 淘汰是无声的删除：被删掉的那条正是用户以为还在生效的那条。所以不淘汰。
    expect(kept[0]?.content).toBe('第 0 条约束');
  });

  it('撤掉之后位置空出来，记录还在（归档不是销毁）', async () => {
    const id = await stand('回答不要客套');
    expect(memory.forget(id)).toBe(true);
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(0);

    const row = db.prepare('SELECT is_archived FROM memory WHERE id = ?').get(id) as {
      is_archived: number;
    };
    expect(row.is_archived).toBe(1);

    // 撤掉之后能重新记回来，而不是被永久占位。
    await stand('回答不要客套');
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(1);
  });

  it('撤一条不存在的：说没找到，不假装成功', () => {
    expect(memory.forget('mem-不存在')).toBe(false);
  });

  it('普通记忆不会被当成常驻约束——常驻要用户明说', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '他好像喜欢简洁',
      scope: { type: 'personal' },
      sourceType: 'consolidation',
    });
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(0);
  });
});
