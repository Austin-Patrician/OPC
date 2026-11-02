import type { WorkTask } from '@opc/shared/domain';

/**
 * A gate that proves nothing.
 *
 * The task pipeline always runs *some* acceptance command, and always checks that
 * something landed in the workspace first. For work with no machine-checkable
 * definition of done — "整理这份财报" — pretending `node --test` is the verdict
 * would fail the work three times and burn three rounds of tokens to learn
 * nothing.
 *
 * So the pipeline runs this instead, and the outcome is reported as "done, but I
 * cannot judge it" rather than "passed". Super-agent does the same thing from the
 * other direction: it delivers what it can prove is worth delivering and leaves
 * the verdict to the human (docs/v2/01-core.md §8).
 */
export const UNVERIFIED_GATE: readonly string[] = ['node', '-e', 'process.exit(0)'];

/**
 * Whether this task's acceptance meant anything.
 *
 * The knowledge lives on the task, not on whoever dispatched it: a rework the
 * boss asks for later has to reach the same conclusion, and so does a task
 * resumed after a restart. Anywhere else and the two paths drift apart.
 */
export function isUnverified(task: Pick<WorkTask, 'acceptanceCommand'>): boolean {
  const command = task.acceptanceCommand;
  return command.length === UNVERIFIED_GATE.length && command.every((part, index) => part === UNVERIFIED_GATE[index]);
}
