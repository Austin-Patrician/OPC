import type { SubtaskDraft, TaskError, WorkTask } from '@opc/shared/domain';
import type { OrgMember } from '@opc/shared/domain';

export interface DecomposeLimits {
  maxDepth: number;
  maxFanout: number;
}

export const DEFAULT_DECOMPOSE_LIMITS: DecomposeLimits = { maxDepth: 3, maxFanout: 5 };

export interface DecomposeContext {
  parent: WorkTask;
  requesterId: string;
  subtasks: readonly SubtaskDraft[];
  /** Direct reports of the requester (`position.reports_to_employee_id`). */
  subordinates: readonly OrgMember[];
  /** Tokens the parent still has: est − actual. */
  parentRemainingTokens: number;
  limits?: Partial<DecomposeLimits>;
}

/**
 * The three hard constraints from the design doc, plus the hierarchy check.
 *
 * They are enforced here, in code, not in a prompt: a manager that hallucinates
 * 20 subtasks or a 10-level org gets a structured refusal it can react to.
 */
export function validateDecomposition(ctx: DecomposeContext): TaskError | null {
  const limits = { ...DEFAULT_DECOMPOSE_LIMITS, ...ctx.limits };

  if (ctx.subtasks.length === 0) {
    return { code: 'DECOMPOSE_EMPTY', message: '没有子任务' };
  }

  if (ctx.parent.depth + 1 >= limits.maxDepth) {
    return {
      code: 'DECOMPOSE_DEPTH',
      message: `已达最大拆解深度 ${limits.maxDepth}（当前任务深度 ${ctx.parent.depth}）`,
    };
  }

  if (ctx.subtasks.length > limits.maxFanout) {
    return {
      code: 'DECOMPOSE_FANOUT',
      message: `一个任务最多拆 ${limits.maxFanout} 个子任务，收到 ${ctx.subtasks.length} 个`,
    };
  }

  const wanted = ctx.subtasks.reduce((sum, sub) => sum + Math.max(0, sub.estTokens), 0);
  if (wanted > ctx.parentRemainingTokens) {
    return {
      code: 'DECOMPOSE_BUDGET',
      message: `子任务预估合计 ${wanted} 超过父任务剩余 ${ctx.parentRemainingTokens}`,
    };
  }

  if (ctx.subtasks.some((sub) => sub.assigneeId === ctx.requesterId)) {
    return { code: 'DECOMPOSE_SELF', message: '不能把子任务派给自己' };
  }

  const subordinateIds = new Set(ctx.subordinates.map((member) => member.id));
  const outsider = ctx.subtasks.find((sub) => !subordinateIds.has(sub.assigneeId));
  if (outsider) {
    return {
      code: 'DECOMPOSE_NOT_SUBORDINATE',
      message: `${outsider.assigneeId} 不是 ${ctx.requesterId} 的直接下属`,
    };
  }

  return null;
}
