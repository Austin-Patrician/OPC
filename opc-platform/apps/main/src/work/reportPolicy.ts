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

  // A line-level summary is an audit record, not evidence that a task completed.
  return report.taskId !== null && Boolean(task && !task.parentTaskId);
}

/** Only actionable reports that are not already represented by a chat card wake Router. */
export function shouldWakeRouterForReport(report: WorkReport): boolean {
  return report.level !== 'silent' && report.kind !== 'question';
}
