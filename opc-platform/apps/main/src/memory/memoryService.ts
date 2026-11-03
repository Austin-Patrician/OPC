import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';
import { rankMemories, type MemoryCandidate } from './memoryScore';

export interface MemoryScope {
  /**
   * 只有两层：`thread`（这条工作线的经验）和 `personal`（你自己的习惯）。
   *
   * 曾经还有 `org` / `department` / `project` 三层——它们对应的工作台里的组织早就
   * 不存在了，V33 把库里的旧值收敛到了 `personal`。
   */
  type: 'personal' | 'thread';
  id?: string;
}

export interface RememberInput {
  ownerId: string;
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
 * 记忆：写一次，按相关度召回，每次用到就变结实一点。
 *
 * 值得留下的几个决定：
 * - 作用域是显式存下来的，所以"只在这条线里算数"是一个过滤，而不是一次重写；
 * - 向量是可选的：没有 embedding provider 时同一套排序按字面跑（含中文 bigram），
 *   所以这个功能永远不会卡在配置上；
 * - 衰减在读取时由 strength + 上次召回算出，没有后台任务，也不会因为长期不开而丢数据。
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
        `INSERT INTO memory
           (id, owner_id, kind, content, scope_type, scope_id, embedding, embedding_model,
            source_type, source_id, valid_from, strength, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)`,
      )
      .run(
        id,
        input.ownerId,
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

  /** Retrieves the top memories for a query within the owner's allowed scopes. */
  retrieve = async (input: {
    ownerId: string;
    query: string;
    scopes: MemoryScope[];
    limit?: number;
    now?: number;
  }): Promise<MemorySnippet[]> => {
    const now = input.now ?? Date.now();
    const scopeClause = input.scopes
      .map(() => '(scope_type = ? AND (scope_id IS ? OR scope_id = ?))')
      .join(' OR ');
    const params: unknown[] = [input.ownerId];
    for (const scope of input.scopes) {
      params.push(scope.type, scope.id ?? null, scope.id ?? null);
    }

    const rows = this.db
      .prepare(
        `SELECT id, content, kind, scope_type, strength, created_at, last_recalled_at, recall_count, embedding
           FROM memory
          WHERE owner_id = ? AND is_archived = 0 AND valid_until IS NULL
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
      `UPDATE memory
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

  listForOwner = (ownerId: string, limit = 50): MemorySnippet[] =>
    (
      this.db
        .prepare(
          `SELECT id, content, kind, scope_type, strength, created_at, last_recalled_at, recall_count, embedding
             FROM memory WHERE owner_id = ? AND is_archived = 0
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(ownerId, limit) as MemoryRow[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      scopeType: row.scope_type,
      score: row.strength,
    }));

  countForOwner = (ownerId: string): number =>
    (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM memory WHERE owner_id = ? AND is_archived = 0')
        .get(ownerId) as { n: number }
    ).n;
}
