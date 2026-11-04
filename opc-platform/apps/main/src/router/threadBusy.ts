import type { TaskRepository } from '../data/taskRepository';
import type { WorkTask } from '@opc/shared/domain';

/**
 * 这条线上还有没有**没结束的活**。
 *
 * 一处判据，两个调用方：
 *
 * - 外部结束信号（`ingestTrigger`：PR 合并、issue 关闭）
 * - Router 的 `close_line`
 *
 * 为什么要抽成一处：这两边只要有一边忘了判，代价是一样的——线被标成 `done`，
 * 执行体被 retire，而任务还在后台跑。它的汇报随后落到一条已经结束的线上，
 * 界面上的表现是"一件刚从没存在过的事"。分开写迟早会漂移，所以只有一份。
 *
 * 判 open/running 两态，不判别的：其余状态（accepted/rejected/failed/cancelled/delivered）
 * 都已经有了结论，收线不会让它们失去什么。
 */
export function unfinishedTasksOf(
  tasks: TaskRepository,
  threadId: string,
  limit = 20,
): WorkTask[] {
  return tasks
    .listByThread(threadId, limit)
    .filter((task) => task.status === 'open' || task.status === 'running');
}

/** 收不了线时给人/给模型看的一句话：哪几件还在跑。 */
export function unfinishedReason(blocking: readonly WorkTask[]): string {
  const names = blocking
    .map((task) => task.issueKey ?? task.title)
    .slice(0, 3)
    .join('、');
  return (
    `这条线上还有 ${blocking.length} 件活没结束（${names}）。` +
    '等它们跑完再收线——现在收，它们就成了没人认领的后台任务，跑完也没有线可以汇报。'
  );
}
