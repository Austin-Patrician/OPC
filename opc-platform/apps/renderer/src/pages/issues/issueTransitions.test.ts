import { describe, expect, it } from 'vitest';
import { decideDrop } from './issueTransitions';

describe('issue board drops', () => {
  it('starts work from todo', () => {
    expect(decideDrop('open', 'doing')).toEqual({ allowed: true, action: { kind: 'run' } });
  });

  it('re-dispatches rejected or failed work', () => {
    expect(decideDrop('rejected', 'doing').action).toEqual({ kind: 'run' });
    expect(decideDrop('failed', 'doing').action).toEqual({ kind: 'run' });
  });

  it('lets the boss sign off an accepted task', () => {
    expect(decideDrop('accepted', 'delivered')).toEqual({
      allowed: true,
      action: { kind: 'approve' },
    });
  });

  it('never lets a drop impersonate the manager or the system', () => {
    expect(decideDrop('running', 'manager-review').allowed).toBe(false);
    expect(decideDrop('open', 'manager-review').allowed).toBe(false);
    expect(decideDrop('review', 'boss-review').allowed).toBe(false);
    expect(decideDrop('running', 'boss-review').allowed).toBe(false);
  });

  it('refuses silly moves with a readable reason', () => {
    expect(decideDrop('running', 'doing').allowed).toBe(false);
    expect(decideDrop('delivered', 'delivered').reason).toContain('同一列');
    expect(decideDrop('delivered', 'boss-review').allowed).toBe(false);
    expect(decideDrop('running', 'todo').allowed).toBe(false);
    ['accepted', 'open', 'running'].forEach((status) => {
      expect(decideDrop(status as never, 'blocked').allowed).toBe(false);
    });
  });

  it('refuses to start work with an unfinished blocker', () => {
    const decision = decideDrop('open', 'doing', [{ issueKey: 'ENG-1', title: '前置' }]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('ENG-1');
  });

  it('starts once the blockers are finished', () => {
    expect(decideDrop('open', 'doing', []).allowed).toBe(true);
  });

  it('sends accepted work back to doing only as an explicit rejection', () => {
    expect(decideDrop('accepted', 'doing')).toEqual({
      allowed: true,
      action: { kind: 'reject-and-redo' },
    });
  });
});
