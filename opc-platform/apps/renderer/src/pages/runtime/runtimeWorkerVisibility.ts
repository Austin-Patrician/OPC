import type { RuntimeObservatorySnapshot, WatchdogIncidentView } from '@opc/shared/ipc';
import type { TaskStatus, WorkTask, Worker } from '@opc/shared/domain';

type WorkerIdentity = Pick<Worker, 'id' | 'threadId'>;

/** Failed work remains visible briefly so an operator can see what just broke. */
export const FAILED_WORKER_RETENTION_MS = 10 * 60_000;
export const COMPLETED_WORKER_RETENTION_MS = 10 * 60_000;

const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['open', 'running', 'review']);

/** Match modern worker assignments and legacy thread-only task records. */
export function taskBelongsToWorker(task: WorkTask, worker: WorkerIdentity): boolean {
  if (task.workerId) return task.workerId === worker.id;
  return task.assigneeId === worker.id || Boolean(task.threadId && worker.threadId && task.threadId === worker.threadId);
}

export function workerTasks(
  worker: Worker,
  tasks: readonly WorkTask[],
): WorkTask[] {
  return tasks.filter((task) => taskBelongsToWorker(task, worker));
}

export function hasOpenWorkerIncident(
  worker: Worker,
  incidents: readonly WatchdogIncidentView[],
): boolean {
  return incidents.some(
    (incident) => incident.subjectId === worker.id && incident.state !== 'resolved',
  );
}

export function isRuntimeWorkerVisible(
  worker: Worker,
  tasks: readonly WorkTask[],
  incidents: readonly WatchdogIncidentView[],
  now = Date.now(),
): boolean {
  if (worker.status === 'running' || hasOpenWorkerIncident(worker, incidents)) return true;

  return workerTasks(worker, tasks).some((task) => {
    if (ACTIVE_TASK_STATUSES.has(task.status)) return true;
    return task.status === 'failed' && now - task.updatedAt <= FAILED_WORKER_RETENTION_MS;
  }) || workerTasks(worker, tasks).some((task) =>
    ['delivered', 'accepted', 'rejected', 'cancelled'].includes(task.status) && now - task.updatedAt <= COMPLETED_WORKER_RETENTION_MS,
  );
}

export function runtimeSceneWorkers(
  snapshot: Pick<RuntimeObservatorySnapshot, 'workers' | 'tasks' | 'incidents'>,
  now = Date.now(),
): Worker[] {
  return snapshot.workers.filter((worker) =>
    isRuntimeWorkerVisible(worker, snapshot.tasks, snapshot.incidents, now),
  );
}
