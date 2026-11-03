import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MAX_PROCEDURAL, MemoryService } from './memoryService';
import { recallOwners, USER_MEMORY_OWNER } from './owners';

/**
 * 做事规矩这条通道（P5，闭合学习回路）。
 *
 * 以前断的那一跳：用户返工三次「先给结论」，记忆里有了、常驻层也升级了，但执行体写东西
 * 时看不到——它只按相关度捞经验，而「不要写注释」和任务标题「写一个健康检查服务」字面上
 * 几乎不重叠，五个名额里挤不进去。
 *
 * 这一层的断言都围绕一件事：**这条通道不看相关度**。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-procedural-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function remember(
  content: string,
  kind: 'preference' | 'constraint' | 'format' | 'workflow' | 'fact',
  extra: { ownerId?: string; tier?: 'long' | 'standing'; subject?: string } = {},
) {
  return memory.remember({
    ownerId: extra.ownerId ?? USER_MEMORY_OWNER,
    kind,
    content,
    scope: { type: extra.ownerId && extra.ownerId !== USER_MEMORY_OWNER ? 'thread' : 'personal', ...(extra.ownerId && extra.ownerId !== USER_MEMORY_OWNER ? { id: extra.ownerId } : {}) },
    sourceType: 'manual',
    ...(extra.tier ? { tier: extra.tier } : {}),
    ...(extra.subject ? { subject: extra.subject } : {}),
  });
}

describe('做事规矩', () => {
  it('只拿 format / workflow：偏好和事实走别的通道', async () => {
    await remember('代码里不要写注释', 'format');
    await remember('交付前先跑一遍冒烟脚本', 'workflow');
    await remember('他喜欢简短回答', 'preference');
    await remember('服务端口是 3000', 'fact');

    const rules = memory.procedural([USER_MEMORY_OWNER]);
    expect(rules.map((item) => item.content)).toEqual([
      '代码里不要写注释',
      '交付前先跑一遍冒烟脚本',
    ]);
  });

  it('不看相关度：跟当前任务毫不相干的规矩照样在这里', async () => {
    await remember('结论放最前面，再给证据', 'format');

    // 检索（Relatedness）在完全不相干的查询下什么都拿不到。
    const viaRetrieval = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '健康检查服务',
      scopes: [{ type: 'personal' }],
    });
    expect(viaRetrieval).toHaveLength(0);

    // 但这条通道照给——**约束不应该按相关度筛**。
    expect(memory.procedural([USER_MEMORY_OWNER])).toHaveLength(1);
  });

  it('已经升进常驻层的不在这里重复一遍', async () => {
    await remember('称呼用「你」', 'format', { tier: 'standing', subject: 'addressing' });
    await remember('代码里不要写注释', 'format', { subject: 'code.comments' });

    const rules = memory.procedural([USER_MEMORY_OWNER]);
    expect(rules.map((item) => item.content)).toEqual(['代码里不要写注释']);
  });

  it('跨三个归属：个人的规矩、这条线的、这个执行体的', async () => {
    await remember('代码里不要写注释', 'format');
    await remember('这份报表要横向排版', 'format', { ownerId: 'th-1' });
    await remember('先写测试再写实现', 'workflow', { ownerId: 'worker-a' });

    const rules = memory.procedural(recallOwners({ threadId: 'th-1', workerId: 'worker-a' }));
    expect(rules.map((item) => item.content)).toEqual([
      '代码里不要写注释',
      '这份报表要横向排版',
      '先写测试再写实现',
    ]);
  });

  it('按记下的先后排：顺序稳定才吃得到提示词缓存', async () => {
    await remember('规矩一', 'format');
    await remember('规矩二', 'format');
    await remember('规矩三', 'format');

    const first = memory.procedural([USER_MEMORY_OWNER]).map((item) => item.content);
    const second = memory.procedural([USER_MEMORY_OWNER]).map((item) => item.content);
    expect(first).toEqual(['规矩一', '规矩二', '规矩三']);
    expect(second).toEqual(first);
  });

  it('有上限：规矩再多也不许把提示词撑爆', async () => {
    for (let index = 0; index < MAX_PROCEDURAL + 5; index += 1) {
      await remember(`规矩 ${index}`, 'format');
    }
    expect(memory.procedural([USER_MEMORY_OWNER])).toHaveLength(MAX_PROCEDURAL);
  });

  it('撤掉的、被取代的都不出现', async () => {
    const revoked = await remember('用 markdown 表格', 'format', { subject: 'table' });
    await remember('用纯文本表格', 'format', { subject: 'table' });
    memory.forget(revoked);

    expect(memory.procedural([USER_MEMORY_OWNER]).map((item) => item.content)).toEqual([
      '用纯文本表格',
    ]);
  });

  it('没有归属时给空数组，不报错', () => {
    expect(memory.procedural([])).toEqual([]);
  });
});
