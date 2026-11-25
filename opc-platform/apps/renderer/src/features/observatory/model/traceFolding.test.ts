import { describe, expect, it } from 'vitest';
import type { RouterTraceEntry, TaskTrace } from '@opc/shared/domain';
import { groupRouterTraceByTurn, groupWorkerTrace } from './traceFolding';

function makeTaskTrace(
  seq: number,
  name: string,
  overrides: Partial<TaskTrace> = {},
): TaskTrace {
  return {
    id: `tr_${seq}`,
    taskId: 'tsk_1',
    seq,
    at: 1000 + seq * 100,
    kind: 'tool',
    name,
    argsDigest: `arg_${seq}`,
    ok: true,
    ms: 50,
    ...overrides,
  };
}

function makeRouterTrace(
  seq: number,
  kind: RouterTraceEntry['kind'],
  name: string,
  summary: string,
  overrides: Partial<RouterTraceEntry> = {},
): RouterTraceEntry {
  return {
    id: `rt_${seq}`,
    seq,
    at: 2000 + seq * 100,
    kind,
    name,
    summary,
    ok: true,
    ...overrides,
  };
}

describe('groupWorkerTrace', () => {
  it('folds consecutive exploratory steps into a burst while keeping key actions & errors visible', () => {
    const trace: TaskTrace[] = [
      makeTaskTrace(1, 'read', { argsDigest: 'inputs/cv.pdf', ms: 30 }),
      makeTaskTrace(2, 'find', { argsDigest: 'scripts/', ms: 20 }),
      makeTaskTrace(3, 'grep', { argsDigest: 'extract', ms: 40 }),
      makeTaskTrace(4, 'bash', { argsDigest: 'python run.py', ms: 250, ok: false }),
      makeTaskTrace(5, 'read', { argsDigest: 'out.txt', ms: 15 }),
      makeTaskTrace(6, 'write', { argsDigest: 'out/final.html', ms: 45 }),
    ];

    const grouped = groupWorkerTrace(trace, { keyOnly: false, running: false });
    expect(grouped.map((g) => g.kind)).toEqual(['burst', 'step', 'step', 'step']);
    const burst = grouped[0];
    expect(burst?.kind).toBe('burst');
    if (burst?.kind === 'burst') {
      expect(burst.items).toHaveLength(3);
      expect(burst.totalMs).toBe(90);
      expect(burst.sampleDigest).toBe('inputs/cv.pdf');
    }
  });

  it('keeps the trailing exploratory step unfolded when running and emits sequence gaps', () => {
    const trace: TaskTrace[] = [
      makeTaskTrace(1, 'read'),
      makeTaskTrace(2, 'find'),
      makeTaskTrace(6, 'grep'),
    ];

    const grouped = groupWorkerTrace(trace, { keyOnly: false, running: true });
    expect(grouped.map((g) => g.kind)).toEqual(['burst', 'gap', 'step']);
    expect(grouped[1]).toMatchObject({ kind: 'gap', count: 3 });
    expect(grouped[2]).toMatchObject({ kind: 'step', entry: { seq: 6 } });
  });

  it('hides passing exploratory steps in keyOnly mode while keeping failures', () => {
    const trace: TaskTrace[] = [
      makeTaskTrace(1, 'read', { ok: true }),
      makeTaskTrace(2, 'read', { ok: false, argsDigest: 'missing.pdf' }),
      makeTaskTrace(3, 'bash', { ok: true }),
    ];

    const grouped = groupWorkerTrace(trace, { keyOnly: true, running: false });
    expect(grouped).toHaveLength(2);
    expect(grouped.map((g) => (g.kind === 'step' ? g.entry.seq : null))).toEqual([2, 3]);
  });

  it('turns kind="usage" into a settlement divider and hides it in keyOnly mode', () => {
    const trace: TaskTrace[] = [
      makeTaskTrace(1, 'read', { ok: true }),
      makeTaskTrace(2, '模型用量', { kind: 'usage', argsDigest: '$0.0342', tokens: 12400 }),
      makeTaskTrace(3, 'read', { ok: true }),
    ];

    const normal = groupWorkerTrace(trace, { keyOnly: false, running: false });
    expect(normal.map((g) => g.kind)).toEqual(['step', 'settlement', 'step']);
    expect(normal[1]).toMatchObject({
      kind: 'settlement',
      entry: { kind: 'usage', tokens: 12400, argsDigest: '$0.0342' },
    });

    const keyOnly = groupWorkerTrace(trace, { keyOnly: true, running: false });
    expect(keyOnly).toEqual([]);
  });
});

describe('groupRouterTraceByTurn', () => {
  it('groups deliver + tool calls + turn completion and orders newest-first', () => {
    const entries: RouterTraceEntry[] = [
      makeRouterTrace(1, 'event_batch', 'deliver', '翻译英文简历'),
      makeRouterTrace(2, 'tool', 'list_lines', 'active=0'),
      makeRouterTrace(3, 'tool', 'open_line_of_work', '启动翻译线', { threadId: 'thr_resume' }),
      makeRouterTrace(4, 'turn', 'dispatch_complete', '已开启工作线', { ms: 920 }),
      makeRouterTrace(5, 'lifecycle', 'compact', 'Router 上下文已压缩'),
    ];

    const turns = groupRouterTraceByTurn(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      kind: 'lifecycle',
      inputSummary: 'Router 上下文已压缩',
    });
    expect(turns[1]).toMatchObject({
      kind: 'turn',
      inputSummary: '翻译英文简历',
      outcomeSummary: '已开启工作线',
      toolCount: 2,
      totalMs: 920,
      linkedThreadIds: ['thr_resume'],
    });
    expect(turns[1]?.entries).toHaveLength(4);
  });
});
