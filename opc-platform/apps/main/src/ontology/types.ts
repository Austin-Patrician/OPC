export const ONTOLOGY_ENTITY_TYPES = [
  'User', 'Project', 'Goal', 'Task', 'Decision', 'Preference', 'Person', 'Tool',
  'Resource', 'Commitment', 'Worker',
] as const;
export type OntologyEntityType = (typeof ONTOLOGY_ENTITY_TYPES)[number];

export type OntologyActor = 'user' | 'router' | 'worker';
export type AssertionStatus = 'current' | 'superseded' | 'retracted';

export interface OntologyEntity {
  id: string;
  entityType: OntologyEntityType;
  canonicalName: string;
  description: string;
  properties: Record<string, unknown>;
  status: 'active' | 'archived';
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface OntologyEpisode {
  id: string;
  sourceType: string;
  sourceId: string | null;
  actor: string;
  content: string;
  contentHash: string;
  occurredAt: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface OntologyAssertion {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string | null;
  objectValue: string | null;
  valueType: 'entity' | 'text' | 'number' | 'boolean' | 'json';
  confidence: number;
  status: AssertionStatus;
  sourceEpisodeId: string;
  evidenceSpan: string | null;
  validFrom: number;
  validUntil: number | null;
  supersededBy: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersonalContextPack {
  subjectEntityId: string;
  entities: OntologyEntity[];
  assertions: OntologyAssertion[];
  profile: Record<string, unknown>;
  /** Stable, bounded text suitable for a Router prompt. */
  prompt: string;
}

export interface OntologyCommand {
  commandId: string;
  actor: OntologyActor;
  objectType: string;
  objectId: string;
  action: string;
  args: unknown;
  expectedVersion: number | null;
  idempotencyKey: string;
  status: 'pending' | 'approved' | 'running' | 'succeeded' | 'failed' | 'rejected';
  approvalId: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface OntologyOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: number;
  deliveredAt: number | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
}

export interface ContextGraphStore {
  ensureEntity(input: { id?: string; entityType: OntologyEntityType; canonicalName: string; description?: string; properties?: Record<string, unknown> }): OntologyEntity;
  resolveEntity(reference: string, entityType?: OntologyEntityType): OntologyEntity | null;
  addAlias(entityId: string, alias: string, source?: string): void;
  appendEpisode(input: { sourceType: string; sourceId?: string; actor?: string; content: string; occurredAt?: number; metadata?: Record<string, unknown> }): OntologyEpisode;
  assertFact(input: { subjectEntityId: string; predicate: string; objectEntityId?: string; objectValue?: string | number | boolean | Record<string, unknown>; valueType?: OntologyAssertion['valueType']; sourceEpisodeId: string; evidenceSpan?: string; confidence?: number; validFrom?: number }): OntologyAssertion;
  retractAssertion(assertionId: string, sourceEpisodeId: string): OntologyAssertion | null;
  assertionHistory(subjectEntityId: string, predicate?: string): OntologyAssertion[];
  contextPack(subjectEntityId: string, options?: { query?: string; maxHops?: number; maxAssertions?: number; maxTokens?: number }): PersonalContextPack;
  enqueueCommand(input: Omit<OntologyCommand, 'commandId' | 'status' | 'result' | 'error' | 'createdAt' | 'updatedAt' | 'completedAt' | 'approvalId'> & { approvalId?: string | null }): OntologyCommand;
  getCommand(commandId: string): OntologyCommand | null;
  listCommands(status?: OntologyCommand['status']): OntologyCommand[];
  transitionCommand(commandId: string, status: OntologyCommand['status'], result?: unknown, error?: string): OntologyCommand | null;
  attachCommandApproval(commandId: string, approvalId: string): OntologyCommand | null;
  pendingOutbox(limit?: number): OntologyOutboxEvent[];
  markOutboxDelivered(id: string): boolean;
  markOutboxFailed(id: string, error: string, retryAt: number): boolean;
}
