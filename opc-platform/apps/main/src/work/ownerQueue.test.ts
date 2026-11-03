import { describe, expect, it } from 'vitest';
import { OwnerQueue } from './ownerQueue';

/**
 * 一个执行体一条队。
 *
 * 这条队列的下限是正确性：同一执行体的两个 run 并发写同一份 sqlite 会话会把 harness
 * 毒化，之后它的每一次运行都失败。所以这里测的不是"排队更整齐"，是"**不会同时跑**"。
 */
function harness() {
  const started: string[] = [];
  const finished: string[] = [];
  let release: Array<() => void> = [];
  const queue = new OwnerQueue({
    run: async (taskId) => {
      started.push(taskId);
      await new Promise<void>((resolve) => release.push(resolve));
      finished.push(taskId);
    },
  });
  return {
    queue,
    started,
    finished,
    releaseOne: () => {
      const next = release.shift();
      next?.();
    },
    releaseAll: () => {
      for (const resolve of release) resolve();
      release = [];
    },
  };
}

describe('OwnerQueue', () => {
  it('同一个执行体的第二个任务要等第一个跑完才开跑', async () => {
    const h = harness();
    h.queue.enqueue('w1', 'a');
    h.queue.enqueue('w1', 'b');

    expect(h.started).toEqual(['a']);
    expect(h.queue.waitingFor('w1')).toEqual(['b']);

    h.releaseOne();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.finished).toEqual(['a']);
    expect(h.started).toEqual(['a', 'b']);
    h.releaseAll();
  });

  it('不同执行体各跑各的，不互相排队', () => {
    const h = harness();
    h.queue.enqueue('w1', 'a');
    h.queue.enqueue('w2', 'b');

    expect(h.started).toEqual(['a', 'b']);
    h.releaseAll();
  });

  it('重复派同一个任务不会干两遍', () => {
    const h = harness();
    h.queue.enqueue('w1', 'a');
    h.queue.enqueue('w1', 'a');
    h.queue.enqueue('w1', 'b');
    h.queue.enqueue('w1', 'b');

    expect(h.started).toEqual(['a']);
    expect(h.queue.waitingFor('w1')).toEqual(['b']);
    h.releaseAll();
  });

  it('一个任务炸了，下一个照旧开跑', async () => {
    const errors: string[] = [];
    let release: (() => void) | null = null;
    const queue = new OwnerQueue({
      run: (taskId) => {
        if (taskId === 'a') return Promise.reject(new Error('炸了'));
        release = () => undefined;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      onError: (taskId) => errors.push(taskId),
    });

    queue.enqueue('w1', 'a');
    queue.enqueue('w1', 'b');
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['a']);
    expect(queue.activeTask('w1')).toBe('b');
    release!();
  });

  it('跑完就接上下一个，不需要外部推', async () => {
    const seen: string[] = [];
    const queue = new OwnerQueue({
      run: async (taskId) => {
        seen.push(taskId);
      },
    });
    queue.enqueue('w1', 'a');
    queue.enqueue('w1', 'b');
    queue.enqueue('w1', 'c');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(queue.isBusy('w1')).toBe(false);
    expect(queue.queued).toBe(0);
  });

  it('enqueueAndWait 等的是自己那一轮，不是整条队', async () => {
    const order: string[] = [];
    let resolveA: (() => void) | null = null;
    const queue = new OwnerQueue({
      run: (taskId) =>
        new Promise<void>((resolve) => {
          order.push(taskId);
          if (taskId === 'a') resolveA = resolve;
          else resolve();
        }),
    });

    queue.enqueue('w1', 'a');
    const waitingB = queue.enqueueAndWait('w1', 'b');
    resolveA!();
    await waitingB;

    expect(order).toEqual(['a', 'b']);
  });
});
