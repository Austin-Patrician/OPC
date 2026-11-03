import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MAX_STANDING, PROMOTE_AFTER, MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';

/**
 * 晋级：同一件事被要求过三次，就不用再提醒了。
 *
 * 阈值是 3 而不是 1，因为公理 A2：**应用一条错误的推断**比忘掉一条更贵，而常驻层
 * 每一轮都在生效。一次是一时兴起，两次是碰巧，三次是习惯。
 *
 * 另外两件事同样是设计决定，不是实现细节：
 * - 常驻层满了**不升**——淘汰一条别人正在生效的约束，比少升一条糟糕得多；
 * - 升完**必须通知**——不可见的自动升级是赌博，用户得能当场否决。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;
let promoted: { id: string; content: string; observations: number }[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-promotion-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  promoted = [];
  memory = new MemoryService(db, {
    onPromoted: (entry) => {
      promoted.push(entry);
    },
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function remember(content: string, subject: string, tier?: 'standing' | 'long') {
  return memory.remember({
    ownerId: USER_MEMORY_OWNER,
    kind: 'preference',
    content,
    scope: { type: 'personal' },
    sourceType: 'manual',
    subject,
    ...(tier ? { tier } : {}),
  });
}

describe('晋级', () => {
  it('同一主题被要求三次（每次说法都不一样）→ 升进常驻层', async () => {
    await remember('回复控制在三句以内', 'reply.length');
    await remember('回复短一点，三句就够了', 'reply.length');
    expect(promoted).toHaveLength(0);

    const id = await remember('回复别超过三句', 'reply.length');

    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ id, content: '回复别超过三句', observations: PROMOTE_AFTER });
    expect(memory.standing(USER_MEMORY_OWNER).map((item) => item.content)).toEqual([
      '回复别超过三句',
    ]);
  });

  it('同一句话重复三次也算三次——重复是最强的信号', async () => {
    await remember('不要写注释', 'code.comments');
    await remember('不要写注释', 'code.comments');
    expect(promoted).toHaveLength(0);

    await remember('不要写注释', 'code.comments');
    expect(promoted).toHaveLength(1);
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(1);
  });

  it('只说了两次不升——阈值就是阈值', async () => {
    await remember('先说结论', 'reply.order');
    await remember('先说结论，再说理由', 'reply.order');
    expect(promoted).toHaveLength(0);
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(0);
  });

  it('没有主题的记忆各自独立，凑不满三次', async () => {
    await memory.remember({
      ownerId: USER_MEMORY_OWNER,
      kind: 'preference',
      content: '回答不要客套',
      scope: { type: 'personal' },
      sourceType: 'manual',
    });
    expect(promoted).toHaveLength(0);
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(0);
  });

  it('常驻层满了就不升，不淘汰正在生效的别人', async () => {
    for (let index = 0; index < MAX_STANDING; index += 1) {
      await remember(`第 ${index} 条规矩`, `rule.${index}`, 'standing');
    }
    await remember('先给结论', 'reply.order');
    await remember('先给结论再给理由', 'reply.order');
    await remember('结论放最前面', 'reply.order');

    expect(promoted).toHaveLength(0);
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(MAX_STANDING);
    // 那条没升上去的还在长期层里，没有丢。
    const live = memory.list(USER_MEMORY_OWNER);
    expect(live.find((item) => item.subject === 'reply.order')?.tier).toBe('long');
  });

  it('升级之后再提一遍，不会掉回长期层', async () => {
    await remember('称呼用「你」', 'addressing');
    await remember('称呼用「你」', 'addressing');
    await remember('称呼用「你」', 'addressing');
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(1);

    // 用户又提了一次同一件事（这次没说 standing）——那是把它说得更清楚，不是让它失效。
    await remember('称呼一律用「你」', 'addressing');
    const standing = memory.standing(USER_MEMORY_OWNER);
    expect(standing.map((item) => item.content)).toEqual(['称呼一律用「你」']);
    expect(promoted).toHaveLength(1);
  });
});

describe('改与列', () => {
  it('改一条：内容变了，归属和层不变', async () => {
    const id = await remember('表格用千分位', 'number.format');
    expect(memory.update(id, '表格用千分位，小数两位')).toBe(true);

    const [row] = memory.list(USER_MEMORY_OWNER);
    expect(row?.content).toBe('表格用千分位，小数两位');
    expect(row?.subject).toBe('number.format');
  });

  it('改成空的：拒绝，而不是把一条记忆清成空白', async () => {
    const id = await remember('表格用千分位', 'number.format');
    expect(memory.update(id, '   ')).toBe(false);
    expect(memory.list(USER_MEMORY_OWNER)[0]?.content).toBe('表格用千分位');
  });

  it('改一条不存在的：如实返回 false', () => {
    expect(memory.update('mem-没有这条', '随便')).toBe(false);
  });

  it('列表把常驻的排在最前，被取代的和撤掉的都不出现', async () => {
    await remember('称呼用「你」', 'addressing', 'standing');
    const old = await remember('回复三段', 'reply.length');
    await remember('回复五段', 'reply.length');
    const archived = await remember('用 markdown 表格', 'table.style');
    memory.forget(archived);

    const live = memory.list(USER_MEMORY_OWNER);

    expect(live.map((item) => item.content)).toEqual(['称呼用「你」', '回复五段']);
    expect(live.some((item) => item.id === old)).toBe(false);
    expect(live.some((item) => item.id === archived)).toBe(false);
    // 被取代的那条还在库里，只是不在这份"它现在记得什么"的答案里。
    expect(memory.get(old)?.supersededBy).toBeTruthy();
  });
});
