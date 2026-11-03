import type { Worker } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { subjectOfWorker } from './registrySubject';

/**
 * 运行时主体是执行体。
 *
 * `employee` 表已经删掉，主体的身份只来自 worker 行；`ownerId` 只剩"老行上
 * 的遗留值"这一种含义，用来让旧任务对上原来的运行目录。
 */
function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w-1',
    name: '小助手',
    template: 'code',
    skills: ['TypeScript'],
    threadId: 'th-1',
    ownerId: 'emp-1',
    modelProvider: null,
    modelId: null,
  policyJson: '{}',
    status: 'idle',
    spentTokens: 0,
    createdAt: 0,
    retiredAt: null,
    ...overrides,
  };
}

describe('subjectOfWorker', () => {
  it('takes its identity from the worker, not from a person', () => {
    const subject = subjectOfWorker(worker());
    expect(subject).toMatchObject({ id: 'w-1', name: '小助手', template: 'code' });
    expect(subject.skills).toEqual(['TypeScript']);
  });

  it('carries the legacy id only when an old worker row still has one', () => {
    expect(subjectOfWorker(worker()).ownerId).toBe('emp-1');
    // New workers have no such column value; the subject is still complete.
    const fresh = subjectOfWorker(worker({ ownerId: null }));
    expect(fresh.ownerId).toBeUndefined();
    expect(fresh.id).toBe('w-1');
  });
});
