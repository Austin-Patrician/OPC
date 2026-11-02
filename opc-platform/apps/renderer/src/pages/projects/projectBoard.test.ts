import { describe, expect, it } from 'vitest';
import type { TaskStatus, WorkTask } from '@opc/shared/domain';
import {
  artifactTotalsOf,
  boardOf,
  columnOf,
  completionOf,
  isOverdue,
  milestoneSummaryOf,
  needsAttention,
  statsOf,
} from './projectBoard';

const NG = 1_700_000_000_000;

function task(id: string, status: TaskStatus, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: id,
    brief: '',
    deliverableSpec: '',
    assigneeId: 'emp-1',
    assigneeName: '张三',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 0,
    acceptanceCommand: [],
    acceptanceTemplate: 'http-ok',
    status,
    workspaceRelPath: '',
    createdAt: NG,
    updatedAt: NG,
    artifacts: [],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...extra,
  };
}

describe('statsOf', () => {
  it('counts delivered as done and nothing else', () => {
    const stats = statsOf([
      task('a', 'delivered'),
      task('b', 'running'),
      task('c', 'review'),
      task('d', 'failed'),
      task('e', 'open'),
    ]);
    expect(stats).toEqual({ total: 5, done: 1, active: 2, blocked: 1, todo: 1 });
  });

  it('does not divide by zero on an empty project', () => {
    expect(completionOf(statsOf([]))).toBe(0);
  });

  it('reports a half-finished project as half', () => {
    expect(completionOf(statsOf([task('a', 'delivered'), task('b', 'open')]))).toBe(0.5);
  });
});

describe('columnOf', () => {
  it('keeps manager sign-off out of the done column', () => {
    expect(columnOf('accepted')).toBe('doing');
    expect(columnOf('delivered')).toBe('done');
  });

  it('drops cancelled work off the board', () => {
    expect(columnOf('cancelled')).toBeNull();
  });

  it('puts failed work back in todo, flagged', () => {
    expect(columnOf('failed')).toBe('todo');
    expect(needsAttention('failed')).toBe(true);
    expect(needsAttention('open')).toBe(false);
  });
});

describe('boardOf', () => {
  it('sorts P0 first and never loses a task', () => {
    const board = boardOf([
      task('low', 'open', { priority: 'P3' }),
      task('urgent', 'open', { priority: 'P0' }),
      task('cancelled', 'cancelled'),
      task('review', 'review'),
    ]);
    expect(board.todo.map((entry) => entry.id)).toEqual(['urgent', 'low']);
    expect(board.review.map((entry) => entry.id)).toEqual(['review']);
    expect(board.doing).toEqual([]);
    expect(board.done).toEqual([]);
  });

  it('orders by priority before recency', () => {
    const board = boardOf([
      task('old-urgent', 'running', { priority: 'P1', updatedAt: NG }),
      task('new-normal', 'running', { priority: 'P2', updatedAt: NG + 10_000 }),
    ]);
    expect(board.doing.map((entry) => entry.id)).toEqual(['old-urgent', 'new-normal']);
  });
});

describe('isOverdue', () => {
  it('ignores tasks without a due date and finished work', () => {
    expect(isOverdue(task('a', 'open'))).toBe(false);
    expect(isOverdue(task('b', 'open', { dueAt: NG - 1 }), NG)).toBe(true);
    expect(isOverdue(task('c', 'delivered', { dueAt: NG - 1 }), NG)).toBe(false);
  });
});

describe('artifactTotalsOf', () => {
  it('sums bytes and files across every task', () => {
    const totals = artifactTotalsOf([
      task('a', 'delivered', {
        artifacts: [
          { id: '1', relPath: 'a.txt', bytes: 100, sha256: '' },
          { id: '2', relPath: 'b.txt', bytes: 200, sha256: '' },
        ],
      }),
      task('b', 'open', {
        artifacts: [{ id: '3', relPath: 'c.txt', bytes: 50, sha256: '' }],
      }),
    ]);
    expect(totals).toEqual({ count: 3, bytes: 350 });
  });
});

describe('milestoneSummaryOf', () => {
  it('counts finished and overdue checkpoints separately', () => {
    const summary = milestoneSummaryOf(
      [
        { title: '内测', done: true, dueAt: NG - 10_000 },
        { title: '公测', done: false, dueAt: NG - 1 },
        { title: '发布', done: false, dueAt: NG + 86_400_000 },
      ],
      NG,
    );
    expect(summary).toMatchObject({ done: 1, total: 3, overdue: 1 });
  });

  it('picks the earliest unfinished milestone, not the array order', () => {
    const summary = milestoneSummaryOf(
      [
        { title: '发布', done: false, dueAt: NG + 20_000 },
        { title: '公测', done: false, dueAt: NG + 1 },
        { title: '内测', done: true, dueAt: NG },
      ],
      NG,
    );
    expect(summary.next?.title).toBe('公测');
  });

  it('prefers a dated milestone over an undated one', () => {
    const summary = milestoneSummaryOf(
      [
        { title: '待定', done: false },
        { title: '公测', done: false, dueAt: NG + 1 },
      ],
      NG,
    );
    expect(summary.next?.title).toBe('公测');
    expect(milestoneSummaryOf([{ title: '待定', done: false }], NG).next?.title).toBe('待定');
    expect(milestoneSummaryOf([], NG).next).toBeUndefined();
  });
});
