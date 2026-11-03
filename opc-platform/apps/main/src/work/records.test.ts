import { describe, expect, it } from 'vitest';
import { buildRecords, MAX_RECORDS, type RecordSource } from './records';

/**
 * 执行体看到的原始记录（§3.3）。
 *
 * E1 要修的不是"信息不够"，是**信息是二手的**：`workDispatch` 里 `brief = goal`，
 * 执行体看到的是 Router 用自己的话重写过的目标。转述有损，而当 Router 理解偏了，
 * 执行体是唯一有机会发现的人——它手里却没有原文。
 *
 * 这里锁的是**给多少**：ID + 摘要，全文用 recall 取。给多了挤掉它真正需要的窗口，
 * 给少了等于没给。
 */
function source(index: number, body: string, at = index): RecordSource {
  return { kind: 'event', id: `ev-${index}`, title: `im/message ${index}`, body, at };
}

describe('原始记录', () => {
  it('短正文原样给：不为"看起来统一"把一句话也切一刀', () => {
    const [record] = buildRecords([source(1, '健康检查的端口改成 8081')]);
    expect(record?.excerpt).toBe('健康检查的端口改成 8081');
  });

  it('长正文取头尾、标出略去多少，并给出 recall 入口', () => {
    const body = Array.from({ length: 200 }, (_, index) => `第 ${index} 行：端口 8081`).join('\n');
    const [record] = buildRecords([source(1, body)]);

    expect(record?.excerpt).toContain('…（略去');
    expect(record?.excerpt).toContain('全文用 recall ev-1');
    // 尾部必须留着：日志与报错的结论在最后一句。
    expect(record?.excerpt).toContain('第 199 行');
  });

  it('按时间升序：读下来是一条线的时间线，不是倒序的碎片', () => {
    const records = buildRecords([
      source(3, '第三句', 300),
      source(1, '第一句', 100),
      source(2, '第二句', 200),
    ]);
    expect(records.map((record) => record.excerpt)).toEqual(['第一句', '第二句', '第三句']);
  });

  it('一次最多八条，取最近的那几条', () => {
    const many = Array.from({ length: 20 }, (_, index) => source(index, `第 ${index} 句`, index));
    const records = buildRecords(many);

    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[records.length - 1]?.excerpt).toBe('第 19 句');
  });

  it('预算按条数分摊：40 条长记录合起来也不许撑爆提示词', () => {
    const long = Array.from({ length: 40 }, (_, index) =>
      source(index, Array.from({ length: 80 }, () => 'x'.repeat(40)).join('\n'), index),
    );
    const records = buildRecords(long);
    const total = records.reduce((sum, record) => sum + record.excerpt.length, 0);

    // 6000（一次输入的正文预算）+ 每条一句"共 N 行 / M 字，全文用 recall …"的尾巴。
    expect(total).toBeLessThanOrEqual(6_000 + records.length * 80);
  });

  it('一条都不给也行：没有记录时返回空数组，不返回一条空记录', () => {
    expect(buildRecords([])).toEqual([]);
  });
});
