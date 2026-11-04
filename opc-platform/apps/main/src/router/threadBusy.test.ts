import type { WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import type { TaskRepository } from '../data/taskRepository';
import { unfinishedReason, unfinishedTasksOf } from './threadBusy';

/**
 * 「这条线还有没有没结束的活」——**一处判据，两个调用方**（外部结束信号 / `close_line`）。
 *
 * 这个文件锁的是判据本身：哪些状态算"还在跑"。它错一次的代价很具体——线被标成 `done`、
 * 执行体被 retire，而任务还在后台跑，跑完的汇报没有线可以落。
 */
function repository(tasks: Partial<WorkTask>[]): TaskRepository {
  return {
    listByThread: () => tasks,
  } as unknown as TaskRepository;
}

describe('unfinishedTasksOf', () => {
  it('待执行和执行中都算没结束', () => {
    const tasks = unfinishedTasksOf(
      repository([{ id: 'a', status: 'open' }, { id: 'b', status: 'running' }]),
      'th-1',
    );
    expect(tasks.map((task) => task.id)).toEqual(['a', 'b']);
  });

  it('已经有结论的不算：收线不会让它们失去什么', () => {
    const tasks = unfinishedTasksOf(
      repository([
        { id: 'a', status: 'accepted' },
        { id: 'b', status: 'delivered' },
        { id: 'c', status: 'rejected' },
        { id: 'd', status: 'failed' },
        { id: 'e', status: 'cancelled' },
      ]),
      'th-1',
    );
    expect(tasks).toEqual([]);
  });

  it('空线可以收', () => {
    expect(unfinishedTasksOf(repository([]), 'th-1')).toEqual([]);
  });
});

describe('unfinishedReason', () => {
  it('说清有几件、哪几件（优先用 issue key，最多三个）', () => {
    const reason = unfinishedReason([
      { id: 'a', status: 'running', issueKey: 'OPC-1', title: '一号' },
      { id: 'b', status: 'open', title: '二号' },
      { id: 'c', status: 'running', title: '三号' },
      { id: 'd', status: 'running', title: '四号' },
    ] as WorkTask[]);
    expect(reason).toContain('还有 4 件活没结束');
    expect(reason).toContain('OPC-1、二号、三号');
    expect(reason).not.toContain('四号');
    // 说清代价：现在收，它们就成了没人认领的后台任务。
    expect(reason).toContain('没人认领');
  });
});
