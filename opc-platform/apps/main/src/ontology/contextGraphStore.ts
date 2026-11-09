import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { ContextGraphStore, OntologyAssertion, OntologyCommand, OntologyEntity, OntologyEpisode, OntologyEntityType, OntologyOutboxEvent, PersonalContextPack } from './types';

const DEFAULT_PREDICATES = [
  ['prefers', 'User', 'text', 'one', 'normal', 'An explicitly stated user preference.'],
  ['has_goal', 'User', 'Goal', 'many', 'normal', 'A goal the user is pursuing.'],
  ['works_on', 'User', 'Project', 'many', 'normal', 'A project the user is working on.'],
  ['decided', 'User', 'Decision', 'many', 'normal', 'A decision made by the user.'],
  ['knows_person', 'User', 'Person', 'many', 'normal', 'A person relevant to the user.'],
  ['uses_tool', 'User', 'Tool', 'many', 'normal', 'A tool used by the user.'],
  ['committed_to', 'User', 'Commitment', 'many', 'normal', 'A user commitment.'],
  ['describes', 'User', 'text', 'many', 'normal', 'A user profile attribute.'],
  ['has_task', 'User', 'Task', 'many', 'normal', 'A task currently associated with the user.'],
  ['has_worker', 'User', 'Worker', 'many', 'normal', 'A worker operating for the user.'],
  ['assigned_to', 'Task', 'Worker', 'one', 'normal', 'The worker assigned to a task.'],
] as const;

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
}

export class SqliteContextGraphStore implements ContextGraphStore {
  constructor(private readonly db: CompanyDatabase) {
    const insert = db.prepare(`INSERT OR IGNORE INTO ontology_predicate
      (name, subject_types, object_types, cardinality, sensitivity, description) VALUES (?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const [name, subjectType, objectType, cardinality, sensitivity, description] of DEFAULT_PREDICATES) {
        insert.run(name, JSON.stringify([subjectType]), JSON.stringify([objectType]), cardinality, sensitivity, description);
      }
      db.prepare(`INSERT OR IGNORE INTO ontology_entity
        (id, entity_type, canonical_name, created_at, updated_at) VALUES ('ontology-user', 'User', '用户', ?, ?)`).run(Date.now(), Date.now());
      db.prepare(`INSERT OR IGNORE INTO ontology_entity_alias (id, entity_id, alias, normalized, source, created_at)
        VALUES ('ontology-user-alias', 'ontology-user', 'user', 'user', 'system', ?)` ).run(Date.now());
    });
    tx();
    this.syncLegacyFacts();
  }

  /** Read legacy `fact` rows as confirmed, evidence-backed assertions without
   * deleting or rewriting the original table. This is idempotent by fact id. */
  private syncLegacyFacts(): void {
    const rows = this.db.prepare(`SELECT id, subject, predicate, object, statement, source_type, source_id, valid_from, confidence
      FROM fact WHERE valid_until IS NULL AND is_archived = 0 LIMIT 5000`).all() as {
      id: string; subject: string; predicate: string; object: string; statement: string;
      source_type: string | null; source_id: string | null; valid_from: number; confidence: number;
    }[];
    for (const row of rows) {
      const existing = this.db.prepare(`SELECT 1 FROM ontology_episode e JOIN ontology_assertion a ON a.source_episode_id = e.id WHERE e.source_type = 'legacy.fact' AND e.source_id = ? LIMIT 1`).get(row.id);
      if (existing) continue;
      // Legacy facts have free-form subjects. Preserve their meaning without
      // inventing a user relationship for strings such as "delivery" or
      // "runtime"; only explicit user labels map to the User entity type.
      const subjectType = ['user', 'boss', '用户'].includes(normalize(row.subject)) ? 'User' : 'Resource';
      const subject = this.ensureEntity({ entityType: subjectType, canonicalName: row.subject });
      const predicateName = `legacy:${row.predicate.trim() || 'is'}`.slice(0, 120);
      this.db.prepare(`INSERT OR IGNORE INTO ontology_predicate (name, subject_types, object_types, cardinality, description) VALUES (?, ?, ?, 'many', 'Imported from legacy fact')`)
        .run(predicateName, JSON.stringify([subjectType]), JSON.stringify(['text']));
      const episode = this.appendEpisode({ sourceType: 'legacy.fact', sourceId: row.id, actor: 'system', content: row.statement, occurredAt: row.valid_from, metadata: { sourceType: row.source_type, sourceId: row.source_id } });
      this.assertFact({ subjectEntityId: subject.id, predicate: predicateName, objectValue: row.object, sourceEpisodeId: episode.id, confidence: row.confidence, validFrom: row.valid_from });
    }
  }

  ensureEntity(input: { id?: string; entityType: OntologyEntityType; canonicalName: string; description?: string; properties?: Record<string, unknown> }): OntologyEntity {
    const name = input.canonicalName.trim();
    if (!name) throw new Error('实体名称不能为空');
    const found = this.db.prepare(`SELECT id FROM ontology_entity WHERE entity_type = ? AND canonical_name = ? COLLATE NOCASE`).get(input.entityType, name) as { id: string } | undefined;
    const id = found?.id ?? input.id ?? `ont-${crypto.randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO ontology_entity (id, entity_type, canonical_name, description, properties_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical_name = excluded.canonical_name, description = excluded.description, properties_json = excluded.properties_json, version = ontology_entity.version + 1, updated_at = excluded.updated_at
      WHERE ontology_entity.canonical_name <> excluded.canonical_name OR ontology_entity.description <> excluded.description OR ontology_entity.properties_json <> excluded.properties_json`)
      .run(id, input.entityType, name, input.description ?? '', JSON.stringify(input.properties ?? {}), now, now);
    this.db.prepare(`INSERT OR IGNORE INTO ontology_entity_alias (id, entity_id, alias, normalized, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(`alias-${crypto.randomUUID()}`, id, name, normalize(name), now);
    return this.getEntity(id)!;
  }

  addAlias(entityId: string, alias: string, source = 'user'): void {
    const cleaned = alias.trim();
    if (!cleaned) return;
    this.db.prepare(`INSERT OR IGNORE INTO ontology_entity_alias (id, entity_id, alias, normalized, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`alias-${crypto.randomUUID()}`, entityId, cleaned, normalize(cleaned), source, Date.now());
  }

  resolveEntity(reference: string, entityType?: OntologyEntityType): OntologyEntity | null {
    const byId = this.getEntity(reference);
    if (byId && (!entityType || byId.entityType === entityType)) return byId;
    const query = normalize(reference);
    const row = this.db.prepare(`SELECT e.id FROM ontology_entity e LEFT JOIN ontology_entity_alias a ON a.entity_id = e.id
      WHERE e.status = 'active' AND (e.canonical_name = ? COLLATE NOCASE OR a.normalized = ?)
      AND (? IS NULL OR e.entity_type = ?) ORDER BY e.updated_at DESC LIMIT 1`).get(query, query, entityType ?? null, entityType ?? null) as { id: string } | undefined;
    return row ? this.getEntity(row.id) : null;
  }

  appendEpisode(input: { sourceType: string; sourceId?: string; actor?: string; content: string; occurredAt?: number; metadata?: Record<string, unknown> }): OntologyEpisode {
    const content = input.content.trim();
    if (!content) throw new Error('证据内容不能为空');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const now = Date.now();
    const id = `episode-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT OR IGNORE INTO ontology_episode
      (id, source_type, source_id, actor, content, content_hash, occurred_at, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.sourceType, input.sourceId ?? null, input.actor ?? 'system', content, hash, input.occurredAt ?? now, JSON.stringify(input.metadata ?? {}), now);
    const row = this.db.prepare(`SELECT * FROM ontology_episode WHERE source_type = ? AND source_id IS ? AND content_hash = ?`).get(input.sourceType, input.sourceId ?? null, hash) as EpisodeRow;
    return episodeFrom(row);
  }

  assertFact(input: { subjectEntityId: string; predicate: string; objectEntityId?: string; objectValue?: string | number | boolean | Record<string, unknown>; valueType?: OntologyAssertion['valueType']; sourceEpisodeId: string; evidenceSpan?: string; confidence?: number; validFrom?: number }): OntologyAssertion {
    const predicate = this.db.prepare('SELECT * FROM ontology_predicate WHERE name = ?').get(input.predicate) as PredicateRow | undefined;
    if (!predicate) throw new Error(`未知的本体关系：${input.predicate}`);
    const subject = this.getEntity(input.subjectEntityId);
    if (!subject) throw new Error('断言主体不存在');
    const subjectTypes = parseJson<string[]>(predicate.subject_types, []);
    if (subjectTypes.length > 0 && !subjectTypes.includes(subject.entityType)) throw new Error(`关系 ${input.predicate} 不接受 ${subject.entityType} 作为主体`);
    if (!this.getEpisode(input.sourceEpisodeId)) throw new Error('断言必须引用已存在的 Episode');
    const objectType = input.valueType ?? (input.objectEntityId ? 'entity' : 'text');
    if (objectType === 'entity' && (!input.objectEntityId || !this.getEntity(input.objectEntityId))) throw new Error('实体断言必须引用已存在的对象');
    const expectedObjectTypes = parseJson<string[]>(predicate.object_types, []);
    if (objectType === 'entity' && expectedObjectTypes.length > 0) {
      const object = this.getEntity(input.objectEntityId!);
      if (object && !expectedObjectTypes.includes(object.entityType)) throw new Error(`关系 ${input.predicate} 不接受 ${object.entityType} 作为对象`);
    }
    if (objectType !== 'entity' && expectedObjectTypes.length > 0 && !expectedObjectTypes.includes(objectType)) throw new Error(`关系 ${input.predicate} 需要实体对象`);
    if (objectType !== 'entity' && input.objectValue === undefined) throw new Error('字面量断言必须提供 objectValue');
    const now = Date.now();
    const value = objectType === 'entity' ? null : JSON.stringify(input.objectValue);
    const duplicate = this.db.prepare(`SELECT * FROM ontology_assertion
      WHERE subject_entity_id = ? AND predicate = ? AND status = 'current'
        AND ((value_type = 'entity' AND object_entity_id = ?) OR (value_type <> 'entity' AND object_value = ?))
      LIMIT 1`).get(input.subjectEntityId, input.predicate, input.objectEntityId ?? null, value) as AssertionRow | undefined;
    if (duplicate) return assertionFrom(duplicate);
    const id = `assert-${crypto.randomUUID()}`;
    const tx = this.db.transaction(() => {
      let previous: { id: string }[] = [];
      if (predicate.cardinality === 'one') {
        previous = this.db.prepare(`SELECT id FROM ontology_assertion WHERE subject_entity_id = ? AND predicate = ? AND status = 'current'`).all(input.subjectEntityId, input.predicate) as { id: string }[];
      }
      this.db.prepare(`INSERT INTO ontology_assertion
        (id, subject_entity_id, predicate, object_entity_id, object_value, value_type, confidence, source_episode_id, evidence_span, valid_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.subjectEntityId, input.predicate, input.objectEntityId ?? null, value, objectType, Math.max(0, Math.min(1, input.confidence ?? 1)), input.sourceEpisodeId, input.evidenceSpan ?? null, input.validFrom ?? now, now, now);
      for (const row of previous) this.db.prepare(`UPDATE ontology_assertion SET status = 'superseded', valid_until = ?, superseded_by = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(now, id, now, row.id);
      this.rebuildProfile(input.subjectEntityId);
      this.appendOutbox('assertion.changed', 'assertion', id, { subjectEntityId: input.subjectEntityId, predicate: input.predicate });
      return id;
    });
    return this.getAssertion(tx() as string)!;
  }

  retractAssertion(assertionId: string, sourceEpisodeId: string): OntologyAssertion | null {
    if (!this.getEpisode(sourceEpisodeId)) throw new Error('撤回必须引用已存在的 Episode');
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT subject_entity_id FROM ontology_assertion WHERE id = ? AND status = 'current'`).get(assertionId) as { subject_entity_id: string } | undefined;
      if (!row) return false;
      this.db.prepare(`UPDATE ontology_assertion SET status = 'retracted', valid_until = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(now, now, assertionId);
      this.rebuildProfile(row.subject_entity_id);
      this.appendOutbox('assertion.retracted', 'assertion', assertionId, { sourceEpisodeId });
      return true;
    });
    return tx() ? this.getAssertion(assertionId) : null;
  }

  assertionHistory(subjectEntityId: string, predicate?: string): OntologyAssertion[] {
    const rows = this.db.prepare(`SELECT * FROM ontology_assertion WHERE subject_entity_id = ? ${predicate ? 'AND predicate = ?' : ''} ORDER BY valid_from DESC, created_at DESC LIMIT 500`)
      .all(...(predicate ? [subjectEntityId, predicate] : [subjectEntityId])) as AssertionRow[];
    return rows.map(assertionFrom);
  }

  contextPack(subjectEntityId: string, options: { query?: string; maxHops?: number; maxAssertions?: number; maxTokens?: number } = {}): PersonalContextPack {
    const subject = this.getEntity(subjectEntityId);
    if (!subject) throw new Error('上下文主体不存在');
    const maxHops = Math.max(1, Math.min(2, options.maxHops ?? 2));
    const maxAssertions = Math.max(1, Math.min(40, options.maxAssertions ?? 20));
    const collected = new Map<string, OntologyAssertion>();
    let frontier = new Set([subjectEntityId]);
    for (let hop = 0; hop < maxHops; hop += 1) {
      if (frontier.size === 0 || collected.size >= maxAssertions) break;
      const marks = [...frontier].map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT * FROM ontology_assertion WHERE subject_entity_id IN (${marks}) AND status = 'current' ORDER BY confidence DESC, valid_from DESC LIMIT ?`).all(...frontier, maxAssertions - collected.size) as AssertionRow[];
      const next = new Set<string>();
      for (const row of rows) {
        const assertion = assertionFrom(row);
        collected.set(assertion.id, assertion);
        if (assertion.objectEntityId) next.add(assertion.objectEntityId);
      }
      frontier = next;
    }
    const queryTerms = normalize(options.query ?? '').split(' ').filter(Boolean);
    const assertions = [...collected.values()].sort((a, b) => {
      if (queryTerms.length === 0) return b.confidence - a.confidence || b.validFrom - a.validFrom;
      const score = (item: OntologyAssertion) => queryTerms.reduce((total, term) => total + (item.predicate.includes(term) || (item.objectValue ?? '').toLocaleLowerCase().includes(term) ? 1 : 0), 0);
      return score(b) - score(a) || b.confidence - a.confidence || b.validFrom - a.validFrom;
    });
    const entityIds = new Set([subjectEntityId, ...assertions.flatMap((item) => [item.subjectEntityId, ...(item.objectEntityId ? [item.objectEntityId] : [])])]);
    const entities = [...entityIds].map((id) => this.getEntity(id)).filter((item): item is OntologyEntity => Boolean(item));
    const profile = this.profileOf(subjectEntityId);
    const lines = assertions.map((item) => {
      const name = entities.find((entity) => entity.id === item.subjectEntityId)?.canonicalName ?? item.subjectEntityId;
      const object = item.objectEntityId
        ? entities.find((entity) => entity.id === item.objectEntityId)?.canonicalName ?? item.objectEntityId
        : parseJson(item.objectValue ?? 'null', item.objectValue);
      const evidence = item.evidenceSpan ? `（证据：${item.evidenceSpan}）` : '';
      return `- ${name} ${item.predicate} ${typeof object === 'string' ? object : JSON.stringify(object)}${item.confidence < 1 ? `（置信度 ${item.confidence.toFixed(2)}）` : ''}${evidence}`;
    });
    const cap = Math.max(500, Math.min(12000, options.maxTokens ?? 3000)) * 4;
    let prompt = `## 个人上下文\n只将明确、可追溯的断言作为事实；低置信度内容是规划线索，必要时应向用户核实。\n${lines.join('\n')}`;
    if (prompt.length > cap) prompt = `${prompt.slice(0, cap - 1)}…`;
    return { subjectEntityId, entities, assertions, profile, prompt };
  }

  enqueueCommand(input: Omit<OntologyCommand, 'commandId' | 'status' | 'result' | 'error' | 'createdAt' | 'updatedAt' | 'completedAt' | 'approvalId'> & { approvalId?: string | null }): OntologyCommand {
    const now = Date.now();
    const id = `command-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO ontology_action_command
      (command_id, actor, object_type, object_id, action, args_json, expected_version, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`).run(id, input.actor, input.objectType, input.objectId, input.action, JSON.stringify(input.args ?? {}), input.expectedVersion ?? null, input.idempotencyKey, now, now);
    const row = this.db.prepare('SELECT * FROM ontology_action_command WHERE idempotency_key = ?').get(input.idempotencyKey) as CommandRow;
    return commandFrom(row);
  }

  getCommand(commandId: string): OntologyCommand | null {
    const row = this.db.prepare('SELECT * FROM ontology_action_command WHERE command_id = ?').get(commandId) as CommandRow | undefined;
    return row ? commandFrom(row) : null;
  }

  listCommands(status?: OntologyCommand['status']): OntologyCommand[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM ontology_action_command WHERE status = ? ORDER BY created_at ASC').all(status) as CommandRow[]
      : this.db.prepare('SELECT * FROM ontology_action_command ORDER BY created_at ASC').all() as CommandRow[];
    return rows.map(commandFrom);
  }

  transitionCommand(commandId: string, status: OntologyCommand['status'], result?: unknown, error?: string): OntologyCommand | null {
    const allowed: Record<OntologyCommand['status'], OntologyCommand['status'][]> = {
      pending: ['approved', 'running', 'rejected', 'failed'], approved: ['running', 'rejected', 'failed'], running: ['succeeded', 'failed'], succeeded: [], failed: [], rejected: [],
    };
    const current = this.db.prepare('SELECT status FROM ontology_action_command WHERE command_id = ?').get(commandId) as { status: OntologyCommand['status'] } | undefined;
    if (!current) return null;
    if (current.status !== status && !allowed[current.status].includes(status)) throw new Error(`非法的命令状态迁移：${current.status} -> ${status}`);
    const now = Date.now();
    this.db.prepare(`UPDATE ontology_action_command SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ? WHERE command_id = ?`)
      .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, now, ['succeeded', 'failed', 'rejected'].includes(status) ? now : null, commandId);
    this.appendOutbox('command.changed', 'command', commandId, { status });
    const row = this.db.prepare('SELECT * FROM ontology_action_command WHERE command_id = ?').get(commandId) as CommandRow;
    return commandFrom(row);
  }

  attachCommandApproval(commandId: string, approvalId: string): OntologyCommand | null {
    const changed = this.db.prepare('UPDATE ontology_action_command SET approval_id = ?, updated_at = ? WHERE command_id = ? AND status = ?').run(approvalId, Date.now(), commandId, 'pending').changes;
    if (changed === 0) return null;
    const row = this.db.prepare('SELECT * FROM ontology_action_command WHERE command_id = ?').get(commandId) as CommandRow;
    return commandFrom(row);
  }

  pendingOutbox(limit = 100): OntologyOutboxEvent[] {
    const rows = this.db.prepare('SELECT * FROM ontology_outbox_event WHERE delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY occurred_at ASC LIMIT ?').all(Date.now(), Math.max(1, Math.min(1000, limit))) as OutboxRow[];
    return rows.map(outboxFrom);
  }

  markOutboxDelivered(id: string): boolean {
    return this.db.prepare('UPDATE ontology_outbox_event SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(Date.now(), id).changes > 0;
  }

  markOutboxFailed(id: string, error: string, retryAt: number): boolean {
    return this.db.prepare('UPDATE ontology_outbox_event SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ? AND delivered_at IS NULL').run(error.slice(0, 1000), retryAt, id).changes > 0;
  }

  private getEntity(id: string): OntologyEntity | null {
    const row = this.db.prepare('SELECT * FROM ontology_entity WHERE id = ?').get(id) as EntityRow | undefined;
    return row ? { id: row.id, entityType: row.entity_type as OntologyEntityType, canonicalName: row.canonical_name, description: row.description, properties: parseJson(row.properties_json, {}), status: row.status as OntologyEntity['status'], version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  private getEpisode(id: string): OntologyEpisode | null { const row = this.db.prepare('SELECT * FROM ontology_episode WHERE id = ?').get(id) as EpisodeRow | undefined; return row ? episodeFrom(row) : null; }
  private getAssertion(id: string): OntologyAssertion | null { const row = this.db.prepare('SELECT * FROM ontology_assertion WHERE id = ?').get(id) as AssertionRow | undefined; return row ? assertionFrom(row) : null; }
  private profileOf(subjectId: string): Record<string, unknown> { const row = this.db.prepare('SELECT profile_json FROM ontology_profile_projection WHERE subject_entity_id = ?').get(subjectId) as { profile_json: string } | undefined; return row ? parseJson(row.profile_json, {}) : {}; }
  private rebuildProfile(subjectId: string): void {
    const rows = this.db.prepare(`SELECT id, predicate, object_value, object_entity_id, value_type FROM ontology_assertion WHERE subject_entity_id = ? AND status = 'current'`).all(subjectId) as { id: string; predicate: string; object_value: string | null; object_entity_id: string | null; value_type: string }[];
    const profile: Record<string, unknown> = {};
    for (const row of rows) {
      const value = row.value_type === 'entity' ? this.getEntity(row.object_entity_id!)?.canonicalName : parseJson(row.object_value ?? 'null', row.object_value);
      const existing = profile[row.predicate];
      profile[row.predicate] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    this.db.prepare(`INSERT INTO ontology_profile_projection (subject_entity_id, profile_json, source_assertion_ids, generated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(subject_entity_id) DO UPDATE SET profile_json = excluded.profile_json, source_assertion_ids = excluded.source_assertion_ids, version = ontology_profile_projection.version + 1, generated_at = excluded.generated_at`)
      .run(subjectId, JSON.stringify(profile), JSON.stringify(rows.map((row) => row.id)), Date.now());
  }
  private appendOutbox(eventType: string, aggregateType: string, aggregateId: string, payload: unknown): void {
    this.db.prepare(`INSERT INTO ontology_outbox_event (id, event_type, aggregate_type, aggregate_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`outbox-${crypto.randomUUID()}`, eventType, aggregateType, aggregateId, JSON.stringify(payload), Date.now());
  }
}

interface EntityRow { id: string; entity_type: string; canonical_name: string; description: string; properties_json: string; status: string; version: number; created_at: number; updated_at: number }
interface EpisodeRow { id: string; source_type: string; source_id: string | null; actor: string; content: string; content_hash: string; occurred_at: number; metadata_json: string; created_at: number }
interface AssertionRow { id: string; subject_entity_id: string; predicate: string; object_entity_id: string | null; object_value: string | null; value_type: OntologyAssertion['valueType']; confidence: number; status: OntologyAssertion['status']; source_episode_id: string; evidence_span: string | null; valid_from: number; valid_until: number | null; superseded_by: string | null; version: number; created_at: number; updated_at: number }
interface PredicateRow { name: string; subject_types: string; object_types: string; cardinality: 'one' | 'many' }
interface CommandRow { command_id: string; actor: OntologyCommand['actor']; object_type: string; object_id: string; action: string; args_json: string; expected_version: number | null; idempotency_key: string; status: OntologyCommand['status']; approval_id: string | null; result_json: string | null; error: string | null; created_at: number; updated_at: number; completed_at: number | null }
interface OutboxRow { id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload_json: string; occurred_at: number; delivered_at: number | null; attempts: number; last_error: string | null; next_attempt_at: number | null }
function episodeFrom(row: EpisodeRow): OntologyEpisode { return { id: row.id, sourceType: row.source_type, sourceId: row.source_id, actor: row.actor, content: row.content, contentHash: row.content_hash, occurredAt: row.occurred_at, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at }; }
function assertionFrom(row: AssertionRow): OntologyAssertion { return { id: row.id, subjectEntityId: row.subject_entity_id, predicate: row.predicate, objectEntityId: row.object_entity_id, objectValue: row.object_value, valueType: row.value_type, confidence: row.confidence, status: row.status, sourceEpisodeId: row.source_episode_id, evidenceSpan: row.evidence_span, validFrom: row.valid_from, validUntil: row.valid_until, supersededBy: row.superseded_by, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }; }
function commandFrom(row: CommandRow): OntologyCommand { return { commandId: row.command_id, actor: row.actor, objectType: row.object_type, objectId: row.object_id, action: row.action, args: parseJson(row.args_json, {}), expectedVersion: row.expected_version, idempotencyKey: row.idempotency_key, status: row.status, approvalId: row.approval_id, result: row.result_json ? parseJson(row.result_json, null) : null, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at }; }
function outboxFrom(row: OutboxRow): OntologyOutboxEvent { return { id: row.id, eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, payload: parseJson(row.payload_json, {}), occurredAt: row.occurred_at, deliveredAt: row.delivered_at, attempts: row.attempts, lastError: row.last_error, nextAttemptAt: row.next_attempt_at }; }
