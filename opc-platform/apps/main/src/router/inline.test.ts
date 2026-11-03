import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INLINE_BUDGET,
  paginateLines,
  perItemBudget,
  recallView,
  spillText,
} from './inline';

/**
 * Inline & Spill 的设计断言。
 *
 * 这一层要防的坏实现有三种，每一种都"看起来能用"：
 *   ① 每条一个固定上限 —— 3 条时浪费，40 条时爆炸；
 *   ② 按字符硬切 —— 中文没有空格，切出来是半个词，模型读到的第一句就是断的；
 *   ③ 只切头 —— 日志、CI、webhook 的结论往往在最后一句。
 */
describe('预算分摊', () => {
  it('条数少时给足，条数多时压低，但都不越过上下限', () => {
    expect(perItemBudget(DEFAULT_INLINE_BUDGET, 1)).toBe(DEFAULT_INLINE_BUDGET.ceiling);
    expect(perItemBudget(DEFAULT_INLINE_BUDGET, 5)).toBe(1_200);
    // 6000 / 40 = 150 < floor(160) → 抬到下限
    expect(perItemBudget(DEFAULT_INLINE_BUDGET, 40)).toBe(DEFAULT_INLINE_BUDGET.floor);
    expect(perItemBudget(DEFAULT_INLINE_BUDGET, 400)).toBe(DEFAULT_INLINE_BUDGET.floor);
  });

  it('一条都没有时不会算出 0', () => {
    expect(perItemBudget(DEFAULT_INLINE_BUDGET, 0)).toBe(DEFAULT_INLINE_BUDGET.ceiling);
  });
});

describe('spillText', () => {
  it('放得下就原样给，不为了统一而砍一刀', () => {
    expect(spillText('两行\n内容', 'recall x', 600)).toBe('两行\n内容');
  });

  it('多行正文切在行边界上：头、尾都在，中间说清略去了几行', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `第 ${index} 行：这是一行正文`);
    const packed = spillText(lines.join('\n'), 'recall evt-1', 400);

    expect(packed).toContain('第 0 行');
    expect(packed).toContain('第 99 行');
    expect(packed).toMatch(/略去 \d+ 行/);
    expect(packed).toContain('recall evt-1');
    expect(packed).toContain('共 100 行');
    // 没有半行：每一行要么完整出现，要么整行不在。
    for (const line of packed.split('\n')) {
      if (line.startsWith('第 ') && line.endsWith('正文')) continue;
      expect(line.startsWith('第 ')).toBe(false);
    }
  });

  it('单行超长时按字符切，但把结论留在尾部', () => {
    const single = `${'背'.repeat(5_000)}结论在最后`;
    const packed = spillText(single, 'recall evt-2', 600);

    expect(packed).toContain('结论在最后');
    expect(packed).toContain('略去');
    expect(packed.length).toBeLessThan(900);
  });

  it('尾巴报的是**整条**的规模，不是这一页的规模', () => {
    const text = `${'行\n'.repeat(1_000)}完`;
    const packed = spillText(text, 'recall evt-3', 300);
    expect(packed).toContain('共 1001 行');
  });
});

describe('读侧分页', () => {
  it('放得下一页时不分页，也不加导航', () => {
    const view = recallView('短内容', 'evt-1');
    expect(view).toBe('短内容');
  });

  it('长内容只回一页，并告诉你下一段怎么取', () => {
    const text = Array.from({ length: 1_200 }, (_, index) => `第 ${index} 行`).join('\n');
    const first = recallView(text, 'evt-1');

    expect(first).toContain('第 1/');
    expect(first).toContain('recall evt-1 2');
    expect(first).not.toContain('第 1199 行');

    const second = recallView(text, 'evt-1', 2);
    expect(second).toContain('第 2/');
  });

  it('页码越界不会炸，也不会返回空', () => {
    const text = '一\n二\n三';
    const page = paginateLines(text, 99);
    expect(page.page).toBe(page.pages);
    expect(page.items[0]).toContain('三');
    expect(paginateLines(text, 0).page).toBe(1);
  });

  it('单行比一页还长时也要前进一页，不能卡在首页', () => {
    const text = `${'长'.repeat(10_000)}\n短`;
    const page = paginateLines(text, 1);
    expect(page.pages).toBeGreaterThan(1);
  });
});
