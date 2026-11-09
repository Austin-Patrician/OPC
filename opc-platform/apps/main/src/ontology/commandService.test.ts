import { describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { SqliteContextGraphStore } from './contextGraphStore';
import { OntologyCommandService } from './commandService';

describe('OntologyCommandService', () => {
  it('executes preference changes idempotently and records command state', async () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const service = new OntologyCommandService({
      db,
      graph,
      work: { createTask: vi.fn() } as never,
      company: {} as never,
    });
    const input = { actor: 'user' as const, objectType: 'User', objectId: 'ontology-user', action: 'update_preference', args: { value: '先给结论' }, idempotencyKey: 'preference-1' };
    const first = await service.execute(input);
    const second = await service.execute(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.command.commandId).toBe(first.command.commandId);
    expect(graph.contextPack('ontology-user').prompt).toContain('先给结论');
    db.close();
  });

  it('does not let workers change user preferences', async () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const service = new OntologyCommandService({ db, graph, work: {} as never, company: {} as never });
    const result = await service.execute({ actor: 'worker', objectType: 'User', objectId: 'ontology-user', action: 'update_preference', args: { value: 'x' }, idempotencyKey: 'worker-preference-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('无权');
    db.close();
  });

  it('pauses risky router commands in a chat approval and resumes the same command', async () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const approvals: string[] = [];
    const resolved: string[] = [];
    const work = { createTask: vi.fn(() => ({ ok: true, task: { id: 'task-1' } })) };
    const service = new OntologyCommandService({
      db,
      graph,
      work: work as never,
      company: {} as never,
      requestApproval: ({ command }) => { approvals.push(command.commandId); return command.commandId; },
      onApprovalResolved: (command, state) => resolved.push(`${command.commandId}:${state}`),
    });
    const pending = await service.execute({
      actor: 'router', objectType: 'Task', objectId: 'new-task', action: 'delegate_task',
      args: { input: { title: '调研' } }, idempotencyKey: 'delegate-1',
    });
    expect(pending.ok).toBe(false);
    expect(approvals).toHaveLength(1);
    if (pending.ok) throw new Error('expected approval');
    expect(pending.error).toContain('等待用户审批');
    const commandId = approvals[0]!;
    const done = await service.approve(commandId);
    expect(done.ok).toBe(true);
    expect(work.createTask).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual([`${commandId}:approved`]);
    expect((await service.approve(commandId)).ok).toBe(true);
    expect(work.createTask).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('does not allow approving an unbound pending command and records version conflicts as failed', async () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const service = new OntologyCommandService({ db, graph, work: {} as never, company: {} as never });
    const blocked = await service.execute({
      actor: 'user', objectType: 'Goal', objectId: 'missing-goal', action: 'update_goal',
      expectedVersion: 99, idempotencyKey: 'conflict-1',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.command.status).toBe('failed');
    const pending = graph.enqueueCommand({ actor: 'user', objectType: 'Goal', objectId: 'goal-1', action: 'update_goal', args: {}, expectedVersion: null, idempotencyKey: 'unbound-1' });
    const approval = await service.approve(pending.commandId);
    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error('expected unbound approval to be rejected');
    expect(approval.error).toContain('不能直接批准');
    db.close();
  });
});
