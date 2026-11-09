import { describe, expect, it } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { SqliteContextGraphStore } from './contextGraphStore';

describe('SqliteContextGraphStore', () => {
  it('keeps evidence-backed temporal assertions and projects current profile', () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const user = graph.resolveEntity('user')!;
    const first = graph.appendEpisode({ sourceType: 'conversation', sourceId: 'm-1', actor: 'user', content: '我喜欢简洁直接的回复。' });
    const old = graph.assertFact({ subjectEntityId: user.id, predicate: 'prefers', objectValue: 'concise', sourceEpisodeId: first.id, evidenceSpan: '喜欢简洁直接', confidence: 1 });
    const second = graph.appendEpisode({ sourceType: 'conversation', sourceId: 'm-2', actor: 'user', content: '以后请详细解释。' });
    const current = graph.assertFact({ subjectEntityId: user.id, predicate: 'prefers', objectValue: 'detailed', sourceEpisodeId: second.id, confidence: 1 });
    expect((db.prepare('SELECT status FROM ontology_assertion WHERE id = ?').get(old.id) as { status: string }).status).toBe('superseded');
    expect((db.prepare('SELECT superseded_by FROM ontology_assertion WHERE id = ?').get(old.id) as { superseded_by: string }).superseded_by).toBe(current.id);
    const pack = graph.contextPack(user.id);
    expect(pack.assertions.map((item) => item.id)).toContain(current.id);
    expect(pack.assertions.map((item) => item.id)).not.toContain(old.id);
    expect(pack.prompt).toContain('detailed');
    db.close();
  });

  it('deduplicates episodes and rejects unsupported predicates', () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const a = graph.appendEpisode({ sourceType: 'manual', sourceId: 'same', content: 'same evidence' });
    const b = graph.appendEpisode({ sourceType: 'manual', sourceId: 'same', content: 'same evidence' });
    expect(a.id).toBe(b.id);
    expect(() => graph.assertFact({ subjectEntityId: 'ontology-user', predicate: 'unknown', objectValue: 'x', sourceEpisodeId: a.id })).toThrow('未知的本体关系');
    db.close();
  });

  it('deduplicates repeated current graph edges while preserving one evidence row', () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const user = graph.resolveEntity('ontology-user')!;
    const task = graph.ensureEntity({ id: 'ontology-task-1', entityType: 'Task', canonicalName: '调研' });
    const episode = graph.appendEpisode({ sourceType: 'runtime.context', sourceId: 'task-1', content: '调研' });
    const first = graph.assertFact({ subjectEntityId: user.id, predicate: 'has_task', objectEntityId: task.id, valueType: 'entity', sourceEpisodeId: episode.id });
    const second = graph.assertFact({ subjectEntityId: user.id, predicate: 'has_task', objectEntityId: task.id, valueType: 'entity', sourceEpisodeId: episode.id });
    expect(second.id).toBe(first.id);
    expect(graph.assertionHistory(user.id, 'has_task')).toHaveLength(1);
    db.close();
  });

  it('does not bump entity version when projecting unchanged business data', () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const first = graph.ensureEntity({ id: 'ontology-task-stable', entityType: 'Task', canonicalName: '稳定任务', description: '说明' });
    const second = graph.ensureEntity({ id: 'ontology-task-stable', entityType: 'Task', canonicalName: '稳定任务', description: '说明' });
    expect(second.version).toBe(first.version);
    db.close();
  });

  it('provides idempotent commands and replayable outbox events', () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const input = { actor: 'router' as const, objectType: 'Goal', objectId: 'goal-1', action: 'update_goal', args: { status: 'active' }, expectedVersion: null, idempotencyKey: 'goal-1-update-1' };
    const first = graph.enqueueCommand(input);
    const second = graph.enqueueCommand(input);
    expect(second.commandId).toBe(first.commandId);
    expect(graph.transitionCommand(first.commandId, 'running')?.status).toBe('running');
    expect(graph.transitionCommand(first.commandId, 'succeeded', { ok: true })?.status).toBe('succeeded');
    const events = graph.pendingOutbox();
    expect(events.some((event) => event.aggregateId === first.commandId)).toBe(true);
    expect(graph.markOutboxDelivered(events[0]!.id)).toBe(true);
    expect(graph.markOutboxDelivered(events[0]!.id)).toBe(false);
    const retry = graph.pendingOutbox().find((event) => event.id !== events[0]!.id);
    if (retry) expect(graph.markOutboxFailed(retry.id, 'temporary', Date.now() + 10_000)).toBe(true);
    db.close();
  });
});
