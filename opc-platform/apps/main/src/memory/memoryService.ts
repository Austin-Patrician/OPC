import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';
import { rankMemories, type MemoryCandidate } from './memoryScore';

export interface MemoryScope {
  type: 'personal' | 'org' | 'department' | 'project';
  id?: string;
}

export interface RememberInput {
  employeeId: string;
  kind: MemoryCandidate['kind'] | 'preference' | 'summary';
  content: string;
  scope: MemoryScope;
  sourceType: 'task' | 'conversation' | 'consolidation' | 'manual';
  sourceId?: string;
}

export interface MemorySnippet {
  id: string;
  kind: string;
  content: string;
  scopeType: string;
  score: number;
}

interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  scope_type: string;
  strength: number;
  created_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  embedding: Buffer | null;
}

/** Cosine similarity over the stored Float32 blobs; undefined when either side lacks one. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

const toFloats = (buffer: Buffer | null): Float32Array | undefined => {
  if (!buffer || buffer.length === 0) return undefined;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
};

/**
 * Memory: write once, retrieve by relevance, let recall keep it alive.
 *
 * Design decisions worth keeping:
 * - scope is stored explicitly, so project isolation later is a filter, not a rewrite;
 * - embeddings are optional: without an embedding provider the same ranking runs
 *   lexically (plus CJK bigrams), so the feature never blocks on configuration;
 * - decay is computed at read time from stored strength + last recall, so there is
 *   no background job to schedule, and a long-closed app does not lose data.
 */
export class MemoryService {
  /** Injected when an embedding model is configured (kept optional on purpose). */
  embed?: (text: string) => Promise<Float32Array | undefined>;

  constructor(private readonly db: CompanyDatabase) {}

  remember = async (input: RememberInput): Promise<string> => {
    const id = `mem-${crypto.randomUUID()}`;
    const now = Date.now();
    let embedding: Buffer | null = null;
    let embeddingModel: string | null = null;
    if (this.embed) {
      const vector = await this.embed(input.content).catch(() => undefined);
      if (vector) {
        embedding = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        embeddingModel = 'configured';
      }
    }

    this.db
      .prepare(
        `INSERT INTO employee_memory
           (id, employee_id, kind, content, scope_type, scope_id, embedding, embedding_model,
            source_type, source_id, valid_from, strength, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)`,
      )
      .run(
        id,
        input.employeeId,
        input.kind,
        input.content.trim(),
        input.scope.type,
        input.scope.id ?? null,
        embedding,
        embeddingModel,
        input.sourceType,
        input.sourceId ?? null,
        now,
        now,
        now,
      );
    return id;
  };

  /** Retrieves the top memories for a query within the employee's allowed scopes. */
  retrieve = async (input: {
    employeeId: string;
    query: string;
    scopes: MemoryScope[];
    limit?: number;
    now?: number;
  }): Promise<MemorySnippet[]> => {
    const now = input.now ?? Date.now();
    const scopeClause = input.scopes
      .map(() => '(scope_type = ? AND (scope_id IS ? OR scope_id = ?))')
      .join(' OR ');
    const params: unknown[] = [input.employeeId];
    for (const scope of input.scopes) {
      params.push(scope.type, scope.id ?? null, scope.id ?? null);
    }

    const rows = this.db
      .prepare(
        `SELECT id, content, kind, scope_type, strength, created_at, last_recalled_at, recall_count, embedding
           FROM employee_memory
          WHERE employee_id = ? AND is_archived = 0 AND valid_until IS NULL
            ${scopeClause ? `AND (${scopeClause})` : ''}
          ORDER BY created_at DESC
          LIMIT 200`,
      )
      .all(...params) as MemoryRow[];

    const queryVector = this.embed ? await this.embed(input.query).catch(() => undefined) : undefined;
    const candidates: MemoryCandidate[] = rows.map((row) => {
      const vector = toFloats(row.embedding);
      return {
        id: row.id,
        content: row.content,
        kind: row.kind,
        scopeType: row.scope_type,
        strength: row.strength,
        createdAt: row.created_at,
        lastRecalledAt: row.last_recalled_at,
        recallCount: row.recall_count,
        similarity: queryVector && vector ? cosine(queryVector, vector) : undefined,
      };
    });

    const ranked = rankMemories(candidates, input.query, input.limit ?? 5, now);
    if (ranked.length > 0) this.recordRecall(ranked.map((entry) => entry.id), now);
    return ranked.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      scopeType: entry.scopeType,
      score: entry.similarity ?? 0,
    }));
  };

  /** Recall strengthens a memory: the decay clock restarts and strength ticks up. */
  private recordRecall = (ids: string[], now: number): void => {
    const statement = this.db.prepare(
      `UPDATE employee_memory
          SET recall_count = recall_count + 1,
              last_recalled_at = ?,
              strength = MIN(1.5, strength * 1.05),
              updated_at = ?
        WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) statement.run(now, now, id);
    });
    tx();
  };

  listForEmployee = (employeeId: string, limit = 50): MemorySnippet[] =>
    (
      this.db
        .prepare(
          `SELECT id, content, kind, scope_type, strength, created_at, last_recalled_at, recall_count, embedding
             FROM employee_memory WHERE employee_id = ? AND is_archived = 0
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(employeeId, limit) as MemoryRow[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      scopeType: row.scope_type,
      score: row.strength,
    }));

  countForEmployee = (employeeId: string): number =>
    (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM employee_memory WHERE employee_id = ? AND is_archived = 0')
        .get(employeeId) as { n: number }
    ).n;
}
