import type { TaskChild, WorkTask } from '@opc/shared/domain';

/**
 * 团队收口（原文 §2.2：Worker「本身就是一个 Agent Team」）。
 *
 * 拆解以前只有一半：`decompose_task` 把活派给同事，各自验收、各自汇报，然后**没有人
 * 收口**。三件事因此全部押在"谁先跑完谁说了算"上：
 *
 * - 父比子跑得快 → 线先 `done`；子再失败 → 线变 `failed`，而你看到的是最后写的那条；
 * - 父的交付物里没有子的产物——它根本没等；
 * - 子的失败直接进你的队列，而它本来该由父先消化（父知道全局，你只知道这一条）。
 *
 * 补齐的是三样东西，不是一个新概念：**等**（`collect` 阶段）、**收**（`TaskChild`）、
 * **谁说**（一条线的状态由它的根任务决定）。
 */

/** 已经交回：不必再等。`review` 不在里面——它还在流程里。 */
const SETTLED = new Set(['accepted', 'delivered', 'rejected', 'failed', 'cancelled']);

export function isSettled(task: Pick<WorkTask, 'status'>): boolean {
  return SETTLED.has(task.status);
}

/** 还没交回的子任务。 */
export function unsettledChildren(children: readonly WorkTask[]): WorkTask[] {
  return children.filter((child) => !isSettled(child));
}

/**
 * 等子任务时多久看一眼。
 *
 * 短是有理由的：睡是一次提交，醒来是一次调度，两者都不贵；而长会让"子任务早就回来
 * 了、父还在睡"变成你看得到的那一秒钟的迟钝。
 */
export const JOIN_POLL_MS = 750;

/**
 * 最多等多久。
 *
 * 到期就带着"还有几个没回来"的事实往下走。挂着不动的任务是最糟的账（`workService`
 * 里那句话）：宁可交一份不完整的汇总，也不让一条线永远停在"在跑"。
 */
export const JOIN_TIMEOUT_MS = 20 * 60_000;

/** 一轮任务最多收口几次。父可以再拆，但不许无限往返。 */
export const MAX_JOINS = 3;

/** 一次汇总给几条。拆解的扇出上限是 5，所以正常碰不到这个上限。 */
export const MAX_CHILDREN = 8;

/**
 * 子任务 → 父看得懂的那一段。
 *
 * 顺序按落库时间（先派的先提），不是按重要性：合成交付物时人也是按顺序读的。
 */
export function buildChildren(children: readonly WorkTask[]): TaskChild[] {
  return [...children]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_CHILDREN)
    .map((child) => ({
      id: child.id,
      title: child.title,
      status: child.status,
      verdict: child.acceptance?.verdict ?? null,
      reason: child.error ?? child.acceptance?.reason ?? '',
      artifacts: child.artifacts.map((artifact) => artifact.relPath),
    }));
}

/**
 * 子任务状态怎么说。
 *
 * 一份、两处用（提示词和以后的团队面板）：两处各写一套，迟早一处说"已验收"、
 * 一处说"accepted"，而那正是要避免的两种话。
 */
const LABELS: Record<string, string> = {
  open: '还没开始',
  running: '在跑',
  review: '待复核',
  accepted: '通过了验收',
  delivered: '已交付',
  rejected: '没通过验收',
  failed: '跑挂了',
  cancelled: '已中止',
};

export function childStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}
