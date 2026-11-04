import type { TriggerEvent, TriggerSource } from '@opc/shared/domain';
import type { TaskRepository } from '../data/taskRepository';
import type { ThreadRepository } from '../data/threadRepository';
import { unfinishedTasksOf } from '../router/threadBusy';
import type { NormalizedTrigger } from './types';

/**
 * 一条外部信号落进工作台的那一步。
 *
 * 这里只有两件事，而且都不花 token：
 *
 * 1. **落事件**，带上并线身份（`payload.threadKey`）与投递指纹。落了之后它是
 *    `pending`，下一轮 `Router.tick` 会看它：有订阅者就直通给执行体，没有就交给
 *    Router 冷启动。
 * 2. **结束信号收线**。PR 合并、issue 关闭这一类是"外部世界说这件事结束了"，不是
 *    "再干一件"。收线是程序判断——结束是外部事实，不需要问模型。
 *
 * 什么都不做的情形也是明确的：`deliveryId` 已经见过（平台重投）就只返回旧事件，
 * 不重复派活。
 */
export interface IngestDeps {
  threads: ThreadRepository;
  tasks: TaskRepository;
}

export interface IngestResult {
  event: TriggerEvent;
  /** false = 这条投递之前来过，没有新增事件。 */
  inserted: boolean;
  /** 被这个结束信号收掉的线（没有就是 null）。 */
  closedThreadId: string | null;
}

export function ingestTrigger(
  deps: IngestDeps,
  trigger: NormalizedTrigger,
  meta: { adapterId: string; source: TriggerSource },
): IngestResult {
  const key = trigger.identity?.key ?? null;

  const { event, inserted } = deps.threads.enqueueOnce({
    source: meta.source,
    kind: trigger.kind,
    payload: {
      // `text` 是 Router 与执行体读到的那段话；`summary` 是它的一句话版本。
      text: trigger.text ?? trigger.summary,
      summary: trigger.summary,
      // 适配器名字留在 payload 里：排查"这条是谁送来的"时不用去翻日志。
      via: meta.adapterId,
      ...(trigger.actor ? { author: trigger.actor } : {}),
      ...(key ? { threadKey: key } : {}),
      ...(trigger.replyTarget ? { replyTarget: trigger.replyTarget } : {}),
    },
    dedupeKey: trigger.deliveryId ?? null,
  });

  let closedThreadId: string | null = null;
  if (trigger.terminal && key) {
    const thread = deps.threads.threadByKey(key);
    if (thread) {
      // 手上还有活就不收线：先让那一轮跑完、汇报，收线由它自己触发。抢在前面收线
      // 会让一个正在写的任务失去它的线索。同一条判据 `close_line` 也用。
      if (unfinishedTasksOf(deps.tasks, thread.id).length === 0) {
        deps.threads.setState(thread.id, 'done');
        deps.threads.addReport({
          threadId: thread.id,
          level: 'silent',
          title: thread.title,
          body: `外部信号 ${trigger.kind}：这件事已经结束了`,
        });
        closedThreadId = thread.id;
      }
    }
  }

  return { event, inserted, closedThreadId };
}
