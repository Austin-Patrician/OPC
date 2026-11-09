import { describe, expect, it } from 'vitest';
import type { RuntimeObservatorySnapshot, WatchdogIncidentView } from '@opc/shared/ipc';
import type { WorkTask, Worker } from '@opc/shared/domain';
import {
  FAILED_WORKER_RETENTION_MS,
  COMPLETED_WORKER_RETENTION_MS,
  isRuntimeWorkerVisible,
  runtimeSceneWorkers,
} from './runtimeWorkerVisibility';

const NOW = 1_000_000;

const worker = (overrides: Partial<Worker> = {}): Worker =>
  ({
    id: 'worker-1',
    name: 'Research Worker',
    template: 'research',
    skills: [],
    threadId: 'thread-1',
    ownerId: null,
    modelProvider: null,
    modelId: null,
    policyJson: '{}',
    status: 'idle',
    spentTokens: 0,
    createdAt: NOW - 10_000,
    retiredAt: null,
    ...overrides,
  }) as Worker;

const task = (status: WorkTask['status'], overrides: Partial<WorkTask> = {}): WorkTask =>
  ({
    id: `task-${status}`,
    title: 'Task',
    brief: '',
    deliverableSpec: '',
    assigneeId: 'owner-1',
    assigneeName: 'Owner',
    workerId: 'worker-1',
    threadId: 'thread-1',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 0,
    acceptanceCommand: [],
    acceptanceTemplate: 'http-ok',
    status,
    workspaceRelPath: '',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    artifacts: [],
    attempts: 0,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...overrides,
  }) as WorkTask;

const incident = (subjectId = 'worker-1', state: WatchdogIncidentView['state'] = 'active') =>
  ({
    id: 'incident-1',
    kind: 'worker.timeout',
    state,
    subjectType: 'worker',
    subjectId,
    summary: 'timeout',
    firstAt: NOW - 2_000,
    lastSeenAt: NOW - 1_000,
    reopenCount: 0,
  }) as WatchdogIncidentView;

describe('runtime worker visibility', () => {
  it('hides idle workers without active work', () => {
    expect(isRuntimeWorkerVisible(worker(), [], [], NOW)).toBe(false);
  });

  it.each(['open', 'running', 'review'] as const)('shows %s work', (status) => {
    expect(isRuntimeWorkerVisible(worker(), [task(status)], [], NOW)).toBe(true);
  });

  it('shows a running worker even before a task row is available', () => {
    expect(isRuntimeWorkerVisible(worker({ status: 'running' }), [], [], NOW)).toBe(true);
  });

  it('keeps recent failures visible and retires old failures from the scene', () => {
    expect(isRuntimeWorkerVisible(worker(), [task('failed')], [], NOW)).toBe(true);
    expect(
      isRuntimeWorkerVisible(
        worker(),
        [task('failed', { updatedAt: NOW - FAILED_WORKER_RETENTION_MS - 1 })],
        [],
        NOW,
      ),
    ).toBe(false);
  });

  it('keeps completed workers visible for ten minutes so their result can be inspected', () => {
    expect(isRuntimeWorkerVisible(worker(), [task('accepted')], [], NOW)).toBe(true);
    expect(isRuntimeWorkerVisible(worker(), [task('delivered')], [], NOW)).toBe(true);
    expect(isRuntimeWorkerVisible(worker(), [task('rejected')], [], NOW)).toBe(true);
    expect(
      isRuntimeWorkerVisible(
        worker(),
        [task('accepted', { updatedAt: NOW - COMPLETED_WORKER_RETENTION_MS - 1 })],
        [],
        NOW,
      ),
    ).toBe(false);
  });

  it('keeps workers with unresolved incidents visible', () => {
    expect(isRuntimeWorkerVisible(worker(), [], [incident()], NOW)).toBe(true);
    expect(isRuntimeWorkerVisible(worker(), [], [incident('worker-1', 'resolved')], NOW)).toBe(false);
  });

  it('supports legacy tasks that only carry a thread id', () => {
    expect(
      isRuntimeWorkerVisible(worker(), [task('running', { workerId: undefined })], [], NOW),
    ).toBe(true);
  });

  it('matches a completed task to its worker when only assigneeId is populated', () => {
    expect(
      isRuntimeWorkerVisible(
        worker(),
        [task('accepted', { workerId: undefined, threadId: undefined, assigneeId: 'worker-1' })],
        [],
        NOW,
      ),
    ).toBe(true);
  });

  it('filters the scene roster while preserving the full snapshot roster', () => {
    const idle = worker({ id: 'worker-idle', name: 'Idle' });
    const active = worker({ id: 'worker-active', name: 'Active' });
    const snapshot = {
      workers: [idle, active],
      tasks: [task('running', { workerId: active.id })],
      incidents: [],
    } as Pick<RuntimeObservatorySnapshot, 'workers' | 'tasks' | 'incidents'>;
    expect(snapshot.workers).toHaveLength(2);
    expect(runtimeSceneWorkers(snapshot, NOW).map((entry) => entry.id)).toEqual(['worker-active']);
  });
});
