import { describe, expect, it } from 'vitest';
import type { ToolExecutionResult, ToolHookCall, ToolHooks } from '@earendil-works/pi-durable';
import type { TaskTrace } from '@opc/shared/domain';
import type { TaskRepository } from '../data/taskRepository';
import {
  createTraceExtension,
  createTraceRecorder,
  digestArgs,
  registerTraceRecorder,
  TRACE_HEAD,
  TRACE_TAIL,
  traceRowFor,
  type TraceRecorder,
} from './trace';

/**
 * 动作流（`09-worker-spec.md` §3.4 / W6）。
 *
 * 用例只碰纯逻辑：参数怎么变成一行摘要、序号怎么续、一次工具调用读成什么。
 * 真 harness 那一层由探针和端到端用例覆盖。
 *
 * 1.5.0 删掉了 `watchEvents`（"渲染状态，而不是用事件把它拼出来"），所以这里从
 * "把事件拼成动作"改成了"一次工具调用 → 一行动作"：一个调用正好一次 `afterTool`，
 * 不再有 start/end 配对，也不会因为崩在中间留下一行等不到结尾的轨迹。
 */

function fakeRepository(overrides: Partial<Record<'maxTraceSeq' | 'appendTrace' | 'pruneTrace', unknown>> = {}) {
  const appended: TaskTrace[] = [];
  const pruned: { taskId: string; head: number; tail: number }[] = [];
  const repository = {
    maxTraceSeq: () => 0,
    appendTrace: (input: {
      taskId: string;
      seq: number;
      kind: TaskTrace['kind'];
      name: string;
      argsDigest?: string;
      ok?: boolean;
      ms?: number;
      tokens?: number;
    }) => {
      const row: TaskTrace = {
        id: `trace-${appended.length + 1}`,
        taskId: input.taskId,
        seq: input.seq,
        at: 0,
        kind: input.kind,
        name: input.name,
        argsDigest: input.argsDigest ?? '',
        ok: input.ok !== false,
        ...(input.ms === undefined ? {} : { ms: input.ms }),
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
      };
      appended.push(row);
      return row;
    },
    pruneTrace: (taskId: string, head: number, tail: number) => {
      pruned.push({ taskId, head, tail });
      return 0;
    },
    ...overrides,
  } as unknown as TaskRepository;
  return { repository, appended, pruned };
}

describe('digestArgs', () => {
  it('优先取主参数：命令、路径、查询', () => {
    expect(digestArgs({ command: 'node --test' })).toBe('node --test');
    expect(digestArgs({ path: 'server.js', content: '整整一大段' })).toBe('server.js');
  });

  it('没有主参数就压成 key=value，最多四个', () => {
    expect(digestArgs({ a: 1, b: 'x', c: true, d: 'y', e: 'z' })).toBe('a=1 b=x c=true d=y');
  });

  it('换行压成一行、超长截断——轨迹是索引，不是正文', () => {
    const digest = digestArgs({ command: `echo ${'很长的命令'.repeat(40)}` });
    expect(digest).not.toContain('\n');
    expect(digest.length).toBeLessThanOrEqual(121);
    expect(digest.endsWith('…')).toBe(true);
  });

  it('空参数给空串', () => {
    expect(digestArgs({})).toBe('');
    expect(digestArgs(undefined)).toBe('');
  });
});

describe('createTraceRecorder', () => {
  it('序号从库里续，不从 0 开始', () => {
    const { repository, appended } = fakeRepository({ maxTraceSeq: () => 41 });
    const recorder = createTraceRecorder({ repository, taskId: 'task-1' });
    recorder.record({ kind: 'tool', name: 'bash' });
    expect(appended[0]?.seq).toBe(42);
  });

  it('每次都按同一套策略裁剪：头 50 + 尾 200', () => {
    const { repository, pruned } = fakeRepository();
    const recorder = createTraceRecorder({ repository, taskId: 'task-1' });
    recorder.record({ kind: 'tool', name: 'bash' });
    expect(pruned).toEqual([{ taskId: 'task-1', head: TRACE_HEAD, tail: TRACE_TAIL }]);
  });

  it('写不进库也不抛：观测的缺陷不能拖垮一个正在干活的执行体', () => {
    const { repository } = fakeRepository({
      appendTrace: () => {
        throw new Error('库满了');
      },
    });
    const recorder = createTraceRecorder({ repository, taskId: 'task-1' });
    expect(() => recorder.record({ kind: 'tool', name: 'bash' })).not.toThrow();
  });
});

describe('一次工具调用 → 一行动作', () => {
  const call = (overrides: Partial<ToolHookCall> = {}): ToolHookCall =>
    ({
      id: 'call-1',
      name: 'write',
      arguments: { path: 'server.js', content: '…' },
      ...overrides,
    }) as ToolHookCall;
  const result = (isError = false): ToolExecutionResult =>
    ({ output: [], ...(isError ? { isError: true } : {}) }) as ToolExecutionResult;

  it('成功的一次调用：名字、参数摘要、ok、时长', () => {
    expect(traceRowFor(call(), result(), 42)).toMatchObject({
      kind: 'tool',
      name: 'write',
      argsDigest: 'server.js',
      ok: true,
      ms: 42,
    });
  });

  it('失败的一次调用照样记，ok 是 false 而不是消失', () => {
    expect(traceRowFor(call({ name: 'bash' }), result(true)).ok).toBe(false);
  });

  it('失败的 bash 轨迹保留退出码和最后一行错误', () => {
    const failed = {
      isError: true,
      structuredOutput: { exitCode: 1, output: 'first line\nls: assets: No such file or directory' },
      output: [],
    } as unknown as ToolExecutionResult;
    const row = traceRowFor(call({ name: 'bash', arguments: { command: 'ls assets/' } }), failed);
    expect(row.ok).toBe(false);
    expect(row.argsDigest ?? '').toContain('退出码 1');
    expect(row.argsDigest ?? '').toContain('No such file or directory');
    expect(row.argsDigest?.length ?? 0).toBeLessThanOrEqual(120);
  });

  it('嵌套调用标出来：它不是模型的直接一步，是工具内部的分岔', () => {
    const row = traceRowFor(
      call({ name: 'mcp__github__search', parent: { taskId: 't-1' as never, callId: 'c-0' } }),
      result(),
    );
    expect(row.name).toBe('mcp__github__search（嵌套）');
  });

  it('用量有就算进去，读不出来就不给——0 和"不知道"不是一回事', () => {
    const withUsage = { ...result(), usage: { models: { m: { input: 10, output: 5 } } } };
    expect(traceRowFor(call(), withUsage as unknown as ToolExecutionResult).tokens).toBe(15);
    expect(traceRowFor(call(), result()).tokens).toBeUndefined();
  });
});

describe('登记表：hook 怎么找到那个任务的记录器', () => {
  it('登记之后 hook 才写；撤销之后不再写', async () => {
    const rows: Parameters<TraceRecorder['record']>[0][] = [];
    const recorder: TraceRecorder = { taskId: 'task-1', record: (input) => rows.push(input) };
    const hooks = (createTraceExtension().hooks?.[0]?.handlers ?? {}) as ToolHooks;
    const api = { conversationId: 'conv-1' } as never;
    const call = { id: 'c1', name: 'read', arguments: {} } as never;
    const result = { output: [] } as never;

    const undo = registerTraceRecorder('conv-1', recorder);
    await hooks.beforeTool!(call, api, {} as never);
    await hooks.afterTool!(call, result, api, {} as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'read', ok: true });

    undo();
    await hooks.afterTool!(call, result, api, {} as never);
    expect(rows).toHaveLength(1);
  });
});

