import { describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { SqliteContextGraphStore } from './contextGraphStore';
import { OntologyOutboxDispatcher } from './outboxDispatcher';

describe('OntologyOutboxDispatcher', () => {
  it('delivers once and retries failed handlers', async () => {
    const db = openCompanyDatabase(':memory:');
    const graph = new SqliteContextGraphStore(db);
    const user = graph.resolveEntity('user')!;
    const episode = graph.appendEpisode({ sourceType: 'test', sourceId: 'outbox', content: 'preference' });
    graph.assertFact({ subjectEntityId: user.id, predicate: 'prefers', objectValue: 'concise', sourceEpisodeId: episode.id });
    const dispatcher = new OntologyOutboxDispatcher(graph);
    const handler = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined);
    dispatcher.subscribe(handler);
    expect((await dispatcher.flush()).failed).toBeGreaterThan(0);
    const pending = graph.pendingOutbox().filter((event) => event.eventType === 'assertion.changed');
    expect(pending).toHaveLength(0);
    // Move the retry into the present for deterministic verification.
    const row = db.prepare('SELECT id FROM ontology_outbox_event WHERE event_type = ? LIMIT 1').get('assertion.changed') as { id: string };
    db.prepare('UPDATE ontology_outbox_event SET next_attempt_at = NULL WHERE id = ?').run(row.id);
    expect((await dispatcher.flush()).delivered).toBeGreaterThan(0);
    expect(handler).toHaveBeenCalledTimes(2);
    db.close();
  });
});
