import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { consolidateConversation } from './consolidation';
import { MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';

/**
 * 归档巩固：对话结束之后，留下来的应该只有**会改变下次行为**的东西。
 *
 * 这个上限不是洁癖，是被真实数据教的。库里那批"经验"记忆长这样：
 *
 *   [fact]       对话中出现模型调用失败：找不到模型 test/deepseek/...
 *   [fact]       员工表示当前没有可核验的交付进度数据
 *   [preference] 老板以"smoke: 检查交付进度"反复发起交付进度检查
 *
 * 它们是"这次对话发生了什么"，不是记忆。真实库上 289 条里有 255 条是这么来的，
 * 用户看一眼的结论是"没用的脏数据"。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-consolidation-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function slice(count = 4) {
  return {
    conversationId: 'dm-router',
    ownerId: USER_MEMORY_OWNER,
    messages: Array.from({ length: count }, (_, index) => ({
      senderId: index % 2 === 0 ? 'user' : 'router',
      text: `第 ${index} 句`,
    })),
  };
}

describe('归档巩固', () => {
  it('没有模型就跳过，一条都不写——不假装总结过', async () => {
    const result = await consolidateConversation(memory, slice(), undefined);
    expect(result).toMatchObject({ written: 0 });
    expect(memory.list(USER_MEMORY_OWNER)).toHaveLength(0);
  });

  it('会话太短就不值得巩固', async () => {
    const result = await consolidateConversation(
      memory,
      { ...slice(1), messages: [{ senderId: 'user', text: '在吗' }] },
      async () => [{ kind: 'preference', content: '这条不该被写进去' }],
    );
    expect(result.skipped).toContain('太短');
    expect(memory.list(USER_MEMORY_OWNER)).toHaveLength(0);
  });

  it('模型一口气吐十条也只收三条——记忆的价值在密度，不在条数', async () => {
    const result = await consolidateConversation(memory, slice(), async () =>
      Array.from({ length: 10 }, (_, index) => ({
        kind: 'preference' as const,
        content: `第 ${index} 条偏好，内容足够长`,
      })),
    );

    expect(result.written).toBe(3);
    expect(memory.list(USER_MEMORY_OWNER)).toHaveLength(3);
  });

  it('每条都带得回出处：来源是巩固，sourceId 是那次会话', async () => {
    await consolidateConversation(memory, slice(), async () => [
      { kind: 'preference', content: '文档放 README 里就够了' },
    ]);

    const [stored] = memory.list(USER_MEMORY_OWNER);
    expect(stored?.sourceType).toBe('consolidation');
    expect(stored?.sourceId).toBe('dm-router');
  });

  it('太短的条目丢掉：六个字以下的不算一条记忆', async () => {
    await consolidateConversation(memory, slice(), async () => [
      { kind: 'preference', content: '好的' },
      { kind: 'preference', content: '文档放 README 里就够了' },
    ]);
    expect(memory.list(USER_MEMORY_OWNER).map((item) => item.content)).toEqual([
      '文档放 README 里就够了',
    ]);
  });
});
