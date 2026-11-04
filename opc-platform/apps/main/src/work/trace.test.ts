import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@earendil-works/pi-durable';
import type { TaskTrace } from '@opc/shared/domain';
import type { TaskRepository } from '../data/taskRepository';
import {
  applyAgentEvent,
  createTraceRecorder,
  digestArgs,
  TRACE_HEAD,
  TRACE_TAIL,
  type TraceRecorder,
} from './trace';

/**
 * 动作流（`09-worker-spec.md` §3.4 / W6）。
 *
 * 用例只碰纯逻辑：参数怎么变成一行摘要、序号怎么续、pi 的三种结果形状分别读成什么。
 * 真事件流要开一个 harness，那是 `routerHost` / 探针那一层的事。
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

describe('applyAgentEvent', () => {
  function collect() {
    const rows: Parameters<TraceRecorder['record']>[0][] = [];
    const recorder: TraceRecorder = { taskId: 'task-1', record: (input) => rows.push(input) };
    const pending = new Map<string, string>();
    return { rows, recorder, pending };
  }

  const start = (args: Record<string, unknown>, toolCallId = 'call-1'): AgentEvent =>
    ({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args }) as unknown as AgentEvent;

  const end = (extra: Record<string, unknown>, toolCallId = 'call-1'): AgentEvent =>
    ({ type: 'tool_execution_end', toolCallId, toolName: 'bash', ...extra }) as unknown as AgentEvent;

  it('start 只记参数，end 才落一行：成败与耗时来自结果行', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(start({ command: 'node --test' }), pending, recorder);
    expect(rows).toHaveLength(0);

    applyAgentEvent(
      end({ entry: { model: [{ role: 'toolResult', isError: false, durationMs: 820 }] } }),
      pending,
      recorder,
    );
    expect(rows).toEqual([
      { kind: 'tool', name: 'bash', argsDigest: 'node --test', ok: true, ms: 820 },
    ]);
    expect(pending.size).toBe(0);
  });

  it('结果行说错了，就记一条失败', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(start({ command: 'wrong' }), pending, recorder);
    applyAgentEvent(
      end({ entry: { model: [{ role: 'toolResult', isError: true }] } }),
      pending,
      recorder,
    );
    expect(rows[0]?.ok).toBe(false);
  });

  it('没有结果行就是"不知道"：记 null，不替系统判成功也不判失败', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(start({ command: 'sleep 600' }), pending, recorder);
    applyAgentEvent(end({}), pending, recorder);
    expect(rows[0]).toMatchObject({ ok: null, argsDigest: 'sleep 600' });
  });

  it('助手消息里的工具调用补上参数——checkpoint 被清掉时 start 只剩空对象', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(
      {
        type: 'message_end',
        entry: {
          model: [
            {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'node --check server.js' } }],
            },
          ],
        },
      } as unknown as AgentEvent,
      pending,
      recorder,
    );
    applyAgentEvent(end({ entry: { model: [{ role: 'toolResult', isError: false }] } }), pending, recorder);
    expect(rows[0]?.argsDigest).toBe('node --check server.js');
  });

  it('task_failed 是确定的失败，记一条 error 行', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(
      { type: 'task_failed', taskId: 't', kind: 'pi.tool', message: '工具任务失败' } as unknown as AgentEvent,
      pending,
      recorder,
    );
    expect(rows[0]).toEqual({ kind: 'error', name: 'pi.tool', ok: false, argsDigest: '工具任务失败' });
  });

  it('嵌套调用读 result.isError', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent(start({ question: '查一下' }, 'nested-1'), pending, recorder);
    applyAgentEvent(end({ result: { taskId: 't', isError: true, diagnostics: [] } }, 'nested-1'), pending, recorder);
    expect(rows[0]?.ok).toBe(false);
  });

  it('别的类型的事件不看一眼', () => {
    const { rows, recorder, pending } = collect();
    applyAgentEvent({ type: 'turn_end' } as unknown as AgentEvent, pending, recorder);
    expect(rows).toHaveLength(0);
  });
});
