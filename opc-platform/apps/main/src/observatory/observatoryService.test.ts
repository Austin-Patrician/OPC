import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkReport, WorkTask } from '@opc/shared/domain';
import {
  detectTaskBlocker,
  resolveSafeWorkspacePath,
} from './observatoryService';
import {
  createRouterTraceExtension,
  extractThreadId,
  RouterTraceCollector,
} from '../router/routerTrace';

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'tsk_1',
    title: 'Translate resume PDF',
    brief: 'Translate English PDF resume into Chinese PDF',
    deliverableSpec: 'output.pdf',
    assigneeId: 'wrk_1',
    assigneeName: '小助手',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 4000,
    acceptanceCommand: [],
    acceptanceTemplate: 'node-test',
    status: 'running',
    workspaceRelPath: 'threads/thr_1',
    createdAt: 1000,
    updatedAt: 1000,
    artifacts: [],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<WorkReport> = {}): WorkReport {
  return {
    id: 'rep_1',
    threadId: 'thr_1',
    taskId: 'tsk_1',
    subject: 'bash',
    kind: 'approval',
    level: 'decide',
    title: '需要允许命令执行',
    body: 'python extract_pdf.py',
    createdAt: 2000,
    readAt: null,
    ...overrides,
  };
}

describe('detectTaskBlocker', () => {
  it('prioritizes unread approval over unread question, child tasks, and error', () => {
    const task = makeTask({ status: 'failed', error: 'Previous error' });
    const blocker = detectTaskBlocker({
      task,
      unreadReports: [
        makeReport({ id: 'rep_q', kind: 'question', body: 'Which font?', createdAt: 1500 }),
        makeReport({ id: 'rep_a', kind: 'approval', subject: 'bash', body: 'pdftotext resume.pdf', createdAt: 2000 }),
      ],
      childTasks: [makeTask({ id: 'tsk_child', title: 'Child', status: 'running' })],
    });

    expect(blocker).toEqual({
      kind: 'approval',
      reportId: 'rep_a',
      title: '需要允许命令执行',
      body: 'pdftotext resume.pdf',
      tool: 'bash',
      createdAt: 2000,
    });
  });

  it('ignores already read approval reports and falls through to active question or waiting children', () => {
    const blocker = detectTaskBlocker({
      task: makeTask({ status: 'running' }),
      unreadReports: [
        makeReport({ id: 'rep_read', kind: 'approval', readAt: 2500 }),
        makeReport({ id: 'rep_q', kind: 'question', subject: null, body: '保留双语还是仅中文？', createdAt: 3000 }),
      ],
      childTasks: [makeTask({ id: 'tsk_child', title: 'Extract layout', status: 'open' })],
    });

    expect(blocker).toEqual({
      kind: 'question',
      reportId: 'rep_q',
      title: '需要允许命令执行',
      body: '保留双语还是仅中文？',
      createdAt: 3000,
    });
  });

  it('surfaces waiting_children when running parent waits on unfinished children', () => {
    const blocker = detectTaskBlocker({
      task: makeTask({ status: 'running' }),
      unreadReports: [],
      childTasks: [
        makeTask({ id: 'tsk_c1', title: 'Parse PDF', status: 'running' }),
        makeTask({ id: 'tsk_c2', title: 'Done child', status: 'accepted' }),
      ],
    });

    expect(blocker).toEqual({
      kind: 'waiting_children',
      children: [{ id: 'tsk_c1', title: 'Parse PDF', status: 'running' }],
    });
  });

  it('extracts exitCode and stderrTail from failed acceptance evidence', () => {
    const blocker = detectTaskBlocker({
      task: makeTask({
        status: 'rejected',
        error: '',
        acceptance: {
          verdict: 'fail',
          reason: 'PDF page count mismatch',
          createdAt: 5000,
          evidence: {
            command: ['python', 'verify.py'],
            exitCode: 2,
            stdoutTail: '',
            stderrTail: 'AssertionError: expected 2 pages, got 3',
            durationMs: 120,
          },
        },
      }),
      unreadReports: [],
      childTasks: [],
    });

    expect(blocker).toEqual({
      kind: 'error',
      message: 'PDF page count mismatch',
      exitCode: 2,
      stderrTail: 'AssertionError: expected 2 pages, got 3',
    });
  });
});

describe('resolveSafeWorkspacePath', () => {
  const root = path.resolve('C:\\workspace');

  it('allows relative paths within workspace root and rejects traversal', () => {
    expect(resolveSafeWorkspacePath(root, 'threads/thr_1/out.pdf')).toBe(
      path.resolve(root, 'threads/thr_1/out.pdf'),
    );
    expect(resolveSafeWorkspacePath(root, '.')).toBe(root);
    expect(resolveSafeWorkspacePath(root, '../secrets.json')).toBeNull();
    expect(resolveSafeWorkspacePath(root, 'D:\\other\\file.pdf')).toBeNull();
  });
});

describe('RouterTraceCollector', () => {
  it('enforces bounded ring buffer size, monotonic seq, and subscriber notifications', () => {
    const collector = new RouterTraceCollector(3);
    const received: number[] = [];
    const unsub = collector.subscribe((event) => {
      if (event.type === 'trace') received.push(event.entry.seq);
    });

    collector.record({ kind: 'event_batch', name: 'deliver', summary: 'first', ok: true });
    collector.record({ kind: 'tool', name: 'recall', summary: 'second', ok: true });
    collector.record({ kind: 'tool', name: 'open_line_of_work', summary: 'third', threadId: 'thr_9', ok: true });
    collector.record({ kind: 'turn', name: 'dispatch_complete', summary: 'fourth', ok: true });
    unsub();

    expect(received).toEqual([1, 2, 3, 4]);
    const list = collector.list();
    expect(list).toHaveLength(3);
    expect(list.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(list[1]?.threadId).toBe('thr_9');
  });

  it('extracts threadId from tool arguments or result payload', () => {
    expect(extractThreadId({ thread_id: 'thr_abc' }, '')).toBe('thr_abc');
    expect(extractThreadId(undefined, '{"ok":true,"threadId":"thr_xyz"}')).toBe('thr_xyz');
    expect(extractThreadId(undefined, 'Dispatched on thr_12345_ok successfully')).toBe('thr_12345_ok');
  });

  it('records tool calls through createRouterTraceExtension beforeTool/afterTool hooks', () => {
    const collector = new RouterTraceCollector();
    const busy = vi.fn(() => true);
    const ext = createRouterTraceExtension(collector, busy);
    const hookDef = ext.hooks?.[0] as unknown as {
      handlers: {
        beforeTool: (call: unknown, api: unknown) => unknown;
        afterTool: (call: unknown, result: unknown, api: unknown) => unknown;
      };
    };

    hookDef.handlers.beforeTool(
      { id: 'call_1', name: 'continue_line', arguments: { thread_id: 'thr_7', instruction: '用宋体' } },
      { conversationId: 'conv_router' },
    );
    expect(collector.getPhaseState()).toEqual({
      phase: 'tool',
      activeTool: 'continue_line',
      lastError: null,
    });

    hookDef.handlers.afterTool(
      { id: 'call_1', name: 'continue_line', arguments: { thread_id: 'thr_7', instruction: '用宋体' } },
      { isError: false, output: [{ type: 'text', text: '{"ok":true,"threadId":"thr_7"}' }] },
      { conversationId: 'conv_router' },
    );

    expect(collector.getPhaseState().phase).toBe('thinking');
    const [entry] = collector.list();
    expect(entry).toMatchObject({
      kind: 'tool',
      name: 'continue_line',
      threadId: 'thr_7',
      ok: true,
    });
  });
});
