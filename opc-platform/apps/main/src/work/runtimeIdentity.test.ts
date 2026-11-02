import { describe, expect, it } from 'vitest';
import { runtimeIdentityFor } from './runtimeIdentity';

/**
 * The harness key. Getting this wrong is silent: a shared key means two people
 * run with each other's tools, and nothing throws.
 */
describe('runtimeIdentityFor', () => {
  it('keys the runtime by worker once a task has one', () => {
    expect(runtimeIdentityFor({ assigneeId: 'emp-1', workerId: 'w-9' })).toEqual({
      runtimeKey: 'w-9',
      employeeId: 'emp-1',
    });
  });

  it('falls back to the assignee for tasks that predate workers', () => {
    expect(runtimeIdentityFor({ assigneeId: 'emp-1' })).toEqual({
      runtimeKey: 'emp-1',
      employeeId: 'emp-1',
    });
  });

  it('keeps the tool registry on the person even when the runtime belongs to a worker', () => {
    // The worker owns the context; the person still owns the tool policy.
    expect(runtimeIdentityFor({ assigneeId: 'emp-2', workerId: 'w-1' }).employeeId).toBe('emp-2');
  });
});
