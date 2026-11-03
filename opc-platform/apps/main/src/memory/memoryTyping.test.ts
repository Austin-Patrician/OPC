import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';

/**
 * 类型、主题、时间常数（V37）。
 *
 * 这一层要解决的是「库会不会变脏」——而脏的方式只有三种，每条用例对应一种：
 *
 * 1. **同一句话记了三遍**（没有去重）→ recall 时三条挤占五个名额里的三个；
 * 2. **改主意之后两条同时存在**（没有主题）→ 库里躺着互相矛盾的要求，模型二选一靠猜；
 * 3. **一条衰减曲线套住所有记忆**（没有时间常数）→ 稳定的那条过早消失，易变的变成陈词。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-memory-typing-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function remember(overrides: Partial<Parameters<MemoryService['remember']>[0]> & { content: string }) {
  return memory.remember({
    ownerId: USER_MEMORY_OWNER,
    kind: 'preference',
    scope: { type: 'personal' },
    sourceType: 'manual',
    ...overrides,
  });
}

function row(id: string) {
  return db
    .prepare('SELECT valid_until, superseded_by, subject, volatility, kind FROM memory WHERE id = ?')
    .get(id) as {
    valid_until: number | null;
    superseded_by: string | null;
    subject: string | null;
    volatility: string;
    kind: string;
  };
}

describe('去重', () => {
  it('同一句原话记两遍只落一条（没有主题时的兜底）', async () => {
    const first = await remember({ content: '回答不要客套' });
    const second = await remember({ content: '回答不要客套' });

    expect(second).toBe(first);
    expect(memory.listForOwner(USER_MEMORY_OWNER)).toHaveLength(1);
  });

  it('内容不同就不合并——去重不做同义词判断', async () => {
    await remember({ content: '回答不要客套' });
    await remember({ content: '回答别客气' });
    expect(memory.listForOwner(USER_MEMORY_OWNER)).toHaveLength(2);
  });
});

describe('主题与取代', () => {
  it('同一个主题上新的取代旧的：旧的关掉留档，检索只看得到新的', async () => {
    const old = await remember({ content: '回复控制在三句以内', subject: 'reply.length' });
    const fresh = await remember({ content: '回复控制在五句以内', subject: 'reply.length' });

    expect(fresh).not.toBe(old);
    // 旧的不是被删，是被关：『他以前要求过什么、后来改成什么』本身是信息。
    const closed = row(old);
    expect(closed.valid_until).not.toBeNull();
    expect(closed.superseded_by).toBe(fresh);

    const found = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '回复 句',
      scopes: [{ type: 'personal' }],
    });
    expect(found.map((item) => item.content)).toEqual(['回复控制在五句以内']);
  });

  it('同一个主题、同样的内容：什么都不做，也不留一条重复的', async () => {
    const first = await remember({ content: '回复控制在三句以内', subject: 'reply.length' });
    const again = await remember({ content: '回复控制在三句以内', subject: 'reply.length' });

    expect(again).toBe(first);
    expect(memory.listForOwner(USER_MEMORY_OWNER)).toHaveLength(1);
  });

  it('主题键规范化：大小写和空白不该生成两条', async () => {
    const a = await remember({ content: '用千分位', subject: 'Number Format' });
    const b = await remember({ content: '用逗号分位', subject: 'number  format' });

    expect(row(a).subject).toBe('number-format');
    expect(row(a).superseded_by).toBe(b);
    expect(row(b).subject).toBe('number-format');
  });

  it('不同主题各管各的，互不取代', async () => {
    const length = await remember({ content: '三句以内', subject: 'reply.length' });
    const tone = await remember({ content: '不要客套', subject: 'reply.tone' });

    expect(row(length).superseded_by).toBeNull();
    expect(row(tone).superseded_by).toBeNull();
    expect(memory.listForOwner(USER_MEMORY_OWNER)).toHaveLength(2);
  });

  it('常驻层里替换同一主题不占新位置', async () => {
    for (let index = 0; index < 19; index += 1) {
      await remember({ content: `第 ${index} 条`, tier: 'standing', subject: `rule.${index}` });
    }
    await remember({ content: '称呼用「你」', tier: 'standing', subject: 'addressing' });

    // 满 20 条了；但这是**替换**同一个主题，净增为 0，所以不该被上限挡住。
    await expect(
      remember({ content: '称呼用「您」', tier: 'standing', subject: 'addressing' }),
    ).resolves.toBeTruthy();
    expect(memory.standing(USER_MEMORY_OWNER)).toHaveLength(20);
    expect(memory.standing(USER_MEMORY_OWNER).at(-1)?.content).toBe('称呼用「您」');
  });
});

describe('时间常数', () => {
  it('三种 volatility 存得下来，默认 slow', async () => {
    const stable = await remember({ content: '他讨厌客套话', volatility: 'stable' });
    const session = await remember({ content: '这周在做一个 Rust 项目', volatility: 'session' });
    const plain = await remember({ content: '默认那一条' });

    expect(row(stable).volatility).toBe('stable');
    expect(row(session).volatility).toBe('session');
    expect(row(plain).volatility).toBe('slow');
  });

  it('同样老的两条，session 排到 stable 后面——衰减按时间常数走', async () => {
    const stable = await remember({ content: '配色用语义 token', volatility: 'stable' });
    const session = await remember({ content: '配色现在先用蓝色占位', volatility: 'session' });
    const old = NOW - 30 * DAY;
    db.prepare('UPDATE memory SET created_at = ? WHERE id IN (?, ?)').run(old, stable, session);

    const found = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '配色',
      scopes: [{ type: 'personal' }],
      now: NOW,
    });
    // 三个月后那条"这阵子的事"掉得比"永久有效"快得多，相关度几乎一样时它排在后面。
    expect(found.map((item) => item.content)).toEqual([
      '配色用语义 token',
      '配色现在先用蓝色占位',
    ]);
    const [first, second] = found;
    expect(first!.strength).toBeGreaterThan(second!.strength);
  });
});

describe('类型', () => {
  it('kind 存下来也读得回来——之后才能按类型决定注入给谁', async () => {
    const id = await remember({ content: '代码里不要写注释', kind: 'format' });
    const [hit] = await memory.retrieve({
      owners: [USER_MEMORY_OWNER],
      query: '注释',
      scopes: [{ type: 'personal' }],
    });
    expect(hit?.id).toBe(id);
    expect(hit?.kind).toBe('format');
  });
});
