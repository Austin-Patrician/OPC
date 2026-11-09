import type { WorkReport, WorkTask, WorkThread } from '@opc/shared/domain';

/** Promote only a manually requested root-task completion into chat. */
export function shouldPromoteManualCompletion(
  report: WorkReport,
  thread: WorkThread | null,
  task: WorkTask | undefined,
): boolean {
  if (
    report.level !== 'silent' ||
    report.kind !== 'report' ||
    thread?.source !== 'manual' ||
    thread.speculative
  ) {
    return false;
  }

  // Legacy line-level reports have no task id; task reports must resolve to a root task.
  return report.taskId === null || Boolean(task && !task.parentTaskId);
}
