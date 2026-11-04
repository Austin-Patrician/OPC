import { describe, expect, it } from 'vitest';
import type { TaskTrace } from './domain';
import { describeTrace, renderTrace } from './trace';

/**
 * 动作流的渲染。
 *
 * 这里锁的是两件事：一条动作读得出来（谁、成没成、花了多久），以及**裁剪留下的空洞
 * 必须看得出来**——静默跳过会让读的人以为"它一直没动"，那正是这次要修的毛病。
 */
function trace(overrides: Partial<TaskTrace> = {}): TaskTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    seq: 1,
    at: Date.UTC(2026, 0, 1, 12, 3, 41),
    kind: 'tool',
    name: 'bash',
    argsDigest: '',
    ok: true,
    ...overrides,
  };
}

describe('describeTrace', () => {
  it('一行说清：时间、成败、种类/名字、参数摘要、耗时', () => {
    expect(
      describeTrace(trace({ argsDigest: 'node --test', ms: 820 })),
    ).toBe('12:03:41 ✓ tool/bash — node --test（820ms）');
  });

  it('失败用 ✗，没有摘要和耗时就不留空括号', () => {
    expect(describeTrace(trace({ ok: false, name: 'write' }))).toBe('12:03:41 ✗ tool/write');
  });

  it('"不知道"用 ·：界面不能替系统判成败', () => {
    expect(describeTrace(trace({ ok: null }))).toBe('12:03:41 · tool/bash');
  });

  it('用量行带 token 数', () => {
    expect(describeTrace(trace({ kind: 'usage', name: '模型用量', tokens: 1234, ms: undefined }))).toBe(
      '12:03:41 ✓ usage/模型用量（1234 tokens）',
    );
  });
});

describe('renderTrace', () => {
  it('连续的动作按顺序原样列出，不插空洞行', () => {
    const lines = renderTrace([trace({ seq: 1 }), trace({ seq: 2 })]);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes('略去'))).toBe(false);
  });

  it('被裁掉的那一段折成「略去 N 步」，而不是静默跳过', () => {
    const lines = renderTrace([trace({ seq: 1 }), trace({ seq: 9 })]);
    expect(lines[1]).toBe('…（略去 7 步）…');
    expect(lines).toHaveLength(3);
  });

  it('空输入给空数组', () => {
    expect(renderTrace([])).toEqual([]);
  });
});
