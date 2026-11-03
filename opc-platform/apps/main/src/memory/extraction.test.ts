import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { createMemoryExtraction, type ExtractedMemory } from './extraction';
import { MemoryService } from './memoryService';
import { USER_MEMORY_OWNER } from './owners';
import { SignalStore, signalId } from './signals';

/**
 * 后置抽取：把「用户的抱怨」变成「可执行的偏好」。
 *
 * 这一层有三个不能错的边界，每条用例对应一个：
 *
 * 1. **收是同步的、幂等的**：用户点「重做」那一刻必须立刻收下，收两次也只算一条；
 * 2. **处理失败不丢信号**：抽取炸了、模型没配，信号保持未处理，下一轮重来；
 * 3. **判重交给确定性去重，不交给模型**：模型负责"这句话说了什么要求"，
 *    "这条是不是已经记过了"是 P2 的事。
 */
let dir: string;
let db: CompanyDatabase;
let memory: MemoryService;
let signals: SignalStore;

const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-extract-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  memory = new MemoryService(db);
  signals = new SignalStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function extracted(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    kind: 'preference',
    subject: 'chart.units',
    content: '图表一律标上单位',
    volatility: 'slow',
    scope: 'person',
    ...overrides,
  };
}

describe('收集箱', () => {
  it('同一句理由收两次只算一条', () => {
    const first = signals.record({ origin: 'rework', threadId: 'th-1', text: '图表要标上单位', at: NOW });
    const second = signals.record({ origin: 'rework', threadId: 'th-1', text: '  图表要标上单位  ', at: NOW + 10 });

    expect(second).toBe(first);
    expect(signals.pending()).toHaveLength(1);
  });

  it('同一句理由出现在两条线上是两个信号——上下文不同', () => {
    signals.record({ origin: 'rework', threadId: 'th-1', text: '别用感叹号', at: NOW });
    signals.record({ origin: 'rework', threadId: 'th-2', text: '别用感叹号', at: NOW });
    expect(signals.pending()).toHaveLength(2);
  });

  it('太短的话不进队列："重做"没有内容可提取', () => {
    expect(signals.record({ origin: 'rework', text: '重做' })).toBeNull();
    expect(signals.record({ origin: 'steering', text: '   ' })).toBeNull();
    expect(signals.countPending()).toBe(0);
  });

  it('指纹只由"来源 + 线 + 内容"决定，时间不参与', () => {
    expect(signalId('rework', 'th-1', '同一句')).toBe(signalId('rework', 'th-1', '同一句'));
    expect(signalId('rework', 'th-1', '同一句')).not.toBe(signalId('steering', 'th-1', '同一句'));
  });

  it('按时间正序取：先看最早那条不满', () => {
    signals.record({ origin: 'rework', text: '第二条理由', at: NOW + 1_000 });
    signals.record({ origin: 'rework', text: '第一条理由', at: NOW });
    expect(signals.pending().map((signal) => signal.text)).toEqual(['第一条理由', '第二条理由']);
  });
});

describe('抽取', () => {
  it('抽出候选 → 落成记忆 → 信号标成处理过', async () => {
    signals.record({ origin: 'rework', threadId: 'th-1', text: '图表要标上单位', at: NOW });
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [extracted()],
    });

    const result = await run.run();

    expect(result).toMatchObject({ picked: 1, written: 1 });
    const stored = memory.listForOwner(USER_MEMORY_OWNER);
    expect(stored.map((item) => item.content)).toEqual(['图表一律标上单位']);
    expect(stored[0]?.subject).toBe('chart.units');
    // 指针：一条记忆要能追回它是从哪句话来的。
    expect(stored[0]?.sourceType).toBe('task');
    expect(stored[0]?.sourceId).toBeTruthy();
    expect(signals.countPending()).toBe(0);
  });

  it('第二轮没有新信号：一次模型调用都不花', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    let calls = 0;
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => {
        calls += 1;
        return [extracted()];
      },
    });

    await run.run();
    const second = await run.run();

    expect(calls).toBe(1);
    expect(second).toEqual({ picked: 0, written: 0 });
  });

  it('抽取失败：一条都不写，信号留着下一轮重来', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => {
        throw new Error('网络没了');
      },
    });

    const result = await run.run();

    expect(result.written).toBe(0);
    expect(result.skipped).toContain('网络没了');
    // 宁可多抽一遍，不可漏掉一次。
    expect(signals.countPending()).toBe(1);
  });

  it('没配模型：不跑，也不消耗信号——配好之后它们还在', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    const run = createMemoryExtraction({ signals, memory });

    const result = await run.run();

    expect(result).toMatchObject({ picked: 1, written: 0 });
    expect(result.skipped).toContain('模型');
    expect(signals.countPending()).toBe(1);
  });

  it('太短的候选丢掉：六个字以下的不是偏好', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [extracted({ content: '好的' }), extracted({ content: '图表要标单位', subject: 'x' })],
    });

    const result = await run.run();
    expect(result.written).toBe(1);
    expect(memory.listForOwner(USER_MEMORY_OWNER)[0]?.content).toBe('图表要标单位');
  });

  it('模型给了不认识的类型和时效：退到默认，不因此丢掉这条', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [
        { ...extracted(), kind: '胡说' as never, volatility: '乱写' as never },
      ],
    });

    await run.run();
    const [stored] = memory.listForOwner(USER_MEMORY_OWNER);
    expect(stored?.kind).toBe('preference');
  });

  it('范围是 thread 时挂在线上：这条经验跟着线走，不跟着人', async () => {
    signals.record({ origin: 'rework', threadId: 'th-7', text: '这单的表格用千分位', at: NOW });
    const run = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [extracted({ scope: 'thread', content: '这份财报的表格用千分位' })],
    });

    await run.run();

    expect(memory.listForOwner(USER_MEMORY_OWNER)).toHaveLength(0);
    const onThread = memory.listForOwner('th-7');
    expect(onThread.map((item) => item.content)).toEqual(['这份财报的表格用千分位']);
    expect(onThread[0]?.scopeType).toBe('thread');
  });

  it('反复嫌同一件事：第二次抽取取代第一次，而不是躺着两条', async () => {
    signals.record({ origin: 'rework', text: '图表要标上单位', at: NOW });
    const first = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [extracted({ content: '图表一律标上单位' })],
    });
    await first.run();

    signals.record({ origin: 'rework', text: '单位写在轴标题里就行', at: NOW + 1 });
    const second = createMemoryExtraction({
      signals,
      memory,
      extract: async () => [extracted({ content: '单位写在轴标题里' })],
    });
    await second.run();

    const live = memory.listForOwner(USER_MEMORY_OWNER);
    expect(live.map((item) => item.content)).toEqual(['单位写在轴标题里']);
  });
});
