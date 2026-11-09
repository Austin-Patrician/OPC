import { describe, expect, it } from 'vitest';
import type { WorkTask } from '@opc/shared/domain';
import type { Harness } from '@earendil-works/pi-durable';
import type { TaskRepository } from '../data/taskRepository';
import { DurableWorkRunner } from './durableWorkRunner';
import { threadOutcomeFor } from './threadOutcome';

describe('DurableWorkRunner 终态映射', () => {
  it('运行时故障写成 failed/retryable，并显示运行中断而非验收失败', async () => {
    let task = {
      id: 'task-1',
      title: '列出工具',
      brief: '列出工具',
      deliverableSpec: '工具清单',
      contract: { objective: '列出工具', deliverable: '工具清单', outputs: [] },
      assigneeId: 'worker-1',
      workerId: 'worker-1',
      acceptanceCommand: ['node', 'verify.mjs'],
      acceptanceTemplate: 'http-ok',
      status: 'open',
      workspaceRelPath: 'tasks/task-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifacts: [],
      attempts: 0,
      tokensUsed: 0,
      costUsd: 0,
      steps: [],
      threadId: 'thread-1',
    } as unknown as WorkTask;

    const repository = {
      getTask: () => task,
      setStatus: (_taskId: string, status: WorkTask['status'], patch: Partial<WorkTask> = {}) => {
        task = { ...task, ...patch, status };
      },
      setDurableTaskId: () => undefined,
      addStep: () => undefined,
      listChildren: () => [],
    } as unknown as TaskRepository;

    const harness = {
      resume: () => undefined,
      waitForTask: async () => ({
        state: {
          status: 'terminal',
          outcome: { status: 'faulted', error: new Error('worker process exited') },
        },
      }),
    } as unknown as Harness;

    const runner = new DurableWorkRunner({
      repository,
      harnessFor: async () => ({
        harness,
        root: { commit: async () => 'durable-1' },
      } as never),
      context: async () => ({}) as never,
      workspaceRoot: '/tmp/workspace',
      checksRoot: '/tmp/checks',
      onTaskChanged: () => undefined,
      onFinished: () => undefined,
    });

    const finished = await runner.run(task.id);

    expect(finished.status).toBe('failed');
    expect(finished.errorKind).toBe('retryable');
    expect(finished.error).toBe('worker process exited');
    expect(threadOutcomeFor(finished)?.report?.body).toContain('运行中断');
    expect(threadOutcomeFor(finished)?.report?.body).not.toContain('没通过验收');
  });
});
