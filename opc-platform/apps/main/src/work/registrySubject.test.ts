import type { Worker } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { subjectOfPerson, subjectOfWorker } from './registrySubject';

/**
 * 运行时主体从「人」换成「执行体」。
 *
 * `employeeId` 的有无就是 v2 的分界线：有它，各处沿用旧的按人查表；没有它，
 * 通讯工具的同事列表为空、拆解不做、工具策略为空——全部自然降级，不需要再改一次。
 */
function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w-1',
    name: '小助手',
    template: 'code',
    skills: ['TypeScript'],
    threadId: 'th-1',
    employeeId: 'emp-1',
    modelProvider: null,
    modelId: null,
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

  it('carries the person along only while the person still exists', () => {
    expect(subjectOfWorker(worker()).employeeId).toBe('emp-1');
    // 没有员工之后，这一项就没了——其余代码不需要再改。
    expect(subjectOfWorker(worker({ employeeId: null })).employeeId).toBeUndefined();
  });
});

describe('subjectOfPerson', () => {
  it('is the legacy path: a person id acting as its own executor', () => {
    const subject = subjectOfPerson({ id: 'emp-9', name: '李雷', skills: ['Node.js'] });
    expect(subject).toMatchObject({ id: 'emp-9', name: '李雷', employeeId: 'emp-9' });
    expect(subject.skills).toEqual(['Node.js']);
  });

  it('still produces a usable subject when the person row is missing', () => {
    const subject = subjectOfPerson({ id: 'emp-9' });
    expect(subject.name).toBe('emp-9');
    expect(subject.template).toBe('research');
  });
});
