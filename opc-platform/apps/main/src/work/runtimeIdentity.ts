import type { WorkTask } from '@opc/shared/domain';

/**
 * Which runtime a task runs in.
 *
 * A harness bakes its tool registry and model in at open time, so the key has to
 * identify *one execution body*, not one person and not one line of work: two
 * workers on the same thread would otherwise share a registry and quietly run
 * each other's tools (docs/v2/01-core.md §6).
 *
 * `workerId` is absent on tasks created before B3-2, and on work that never
 * belonged to a thread. Those fall back to the assignee's own runtime, which is
 * exactly what they used before — old data keeps running, unmigrated.
 */
export interface RuntimeIdentity {
  /** Cache key and `agents/<key>.sqlite`. Stable for the life of the worker. */
  runtimeKey: string;
  /** Whose tool policy, skills and model this runtime uses. */
  ownerId: string;
}

export function runtimeIdentityFor(task: Pick<WorkTask, 'workerId' | 'assigneeId'>): RuntimeIdentity {
  return {
    runtimeKey: task.workerId ?? task.assigneeId,
    ownerId: task.assigneeId,
  };
}
