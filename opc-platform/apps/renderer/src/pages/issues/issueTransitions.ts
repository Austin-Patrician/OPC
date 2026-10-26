import type { TaskStatus } from '@opc/shared/domain';

/**
 * What a drag on the issue board is allowed to mean.
 *
 * The board must never *pretend* to move work: every drop either performs a real
 * domain action (start a run, boss sign-off, send back) or is refused with a reason.
 * Keeping the rules here — pure and testable — stops the UI from inventing a
 * fourth acceptance path (e.g. dropping into "待验收" as if the manager had signed).
 */
/**
 * Six columns, not five: "the manager signed" and "the boss signed" are different
 * states with different owners, and merging them makes the drop rules ambiguous.
 */
export type BoardGroup = 'todo' | 'doing' | 'manager-review' | 'boss-review' | 'delivered' | 'blocked';

export type DropAction =
  | { kind: 'run' }
  | { kind: 'approve' }
  | { kind: 'reject-and-redo' };

export interface DropDecision {
  allowed: boolean;
  /** Present when allowed. */
  action?: DropAction;
  /** Present when refused: shown to the boss as-is. */
  reason?: string;
}

const GROUP_OF: Record<TaskStatus, BoardGroup> = {
  open: 'todo',
  running: 'doing',
  review: 'manager-review',
  accepted: 'boss-review',
  delivered: 'delivered',
  rejected: 'blocked',
  failed: 'blocked',
  cancelled: 'todo',
};

export function groupOf(status: TaskStatus): BoardGroup {
  return GROUP_OF[status];
}

export function decideDrop(status: TaskStatus, target: BoardGroup): DropDecision {
  const from = GROUP_OF[status];
  if (from === target) return { allowed: false, reason: '同一列，无需移动' };

  if (target === 'doing') {
    if (status === 'open' || status === 'rejected' || status === 'failed') {
      return { allowed: true, action: { kind: 'run' } };
    }
    if (status === 'accepted' || status === 'delivered') {
      return { allowed: true, action: { kind: 'reject-and-redo' } };
    }
    return { allowed: false, reason: '任务正在执行中，不能重复启动' };
  }

  if (target === 'delivered') {
    if (status === 'delivered') return { allowed: false, reason: '任务已交付' };
    if (status === 'accepted') return { allowed: true, action: { kind: 'approve' } };
    return { allowed: false, reason: '只有通过系统与负责人验收的任务，才能由老板确认交付' };
  }

  if (target === 'manager-review') {
    return { allowed: false, reason: '负责人验收由系统派单给上级，不能手动拖入' };
  }

  if (target === 'boss-review') {
    return { allowed: false, reason: '先用系统与负责人验收通过，才会出现在待终审' };
  }

  if (target === 'todo') {
    return { allowed: false, reason: '已开始的任务不能回到待办（可以打回重做）' };
  }

  // blocked: only meaningful when the system/manager already rejected it.
  return { allowed: false, reason: '“需要处理”由系统或负责人判定，不能手动拖入' };
}
