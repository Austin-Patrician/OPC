import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';
import { decayedStrength, rankMemories, relevanceOf, scoreCandidate, type MemoryCandidate } from './memoryScore';

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

/**
 * 一条被取回的记忆。
 *
 * `id` 和 `source*` 不是装饰：**没有指针的记忆不可追溯**，模型看到「他说文档放 README 里
 * 就够了」却不知道这条是从哪次对话、哪条线的返工里来的，用户也没法核对。
 * 事件链路早就是这么做的（`recall <id>`），记忆链路以前只回正文。
 */
export interface MemorySnippet {
  id: string;
  kind: string;
  content: string;
  scopeType: string;
  scopeId: string | null;
  strength: number;
  createdAt: number;
  sourceType: string;
  sourceId: string | null;
  /**
   * 相关度：这条记忆和这次问的东西有没有关系。
   *
   * 调用方靠它区分「真对上了」和「一条都没对上，这是我记得最牢的几条」。
   * 不能用 `score` 判断——排序分里有一项强度，不相干但新鲜的记忆也会有分数。
   */
  relevance: number;
  /** 排序分（相关度 + 强度 + 召回加成）。 */
  score: number;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  content: string;
  kind: string;
  scope_type: string;
  scope_id: string | null;
  strength: number;
  created_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  source_type: string;
  source_id: string | null;
  embedding: Buffer | null;
}

/** 所有取回路径读同一组列：少一列，某个调用方就会悄悄拿不到指针。 */
const SNIPPET_COLUMNS =
  'id, owner_id, content, kind, scope_type, scope_id, strength, created_at, ' +
  'last_recalled_at, recall_count, source_type, source_id, embedding';

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

  /**
   * 跨归属取回。
   *
   * `owners` 是复数，因为三个归属域是并列的：这个人、这条线、这个执行体（见
   * `owners.ts`）。用一个 owner 的接口做不到「既读人的偏好，又读这条线的经验」，
   * 而这两种东西必须同时在场——只查人就查不到这单踩过的坑，只查线就查不到他本人的要求。
   */
  retrieve = async (input: {
    owners: readonly string[];
    query: string;
    scopes: MemoryScope[];
    limit?: number;
    now?: number;
    /** 显式回忆起话时传 0：不因为"不相关"就把仅有的几条也藏起来。 */
    minRelevance?: number;
  }): Promise<MemorySnippet[]> => {
    const now = input.now ?? Date.now();
    if (input.owners.length === 0) return [];

    const scopeClause = input.scopes
      .map(() => '(scope_type = ? AND (scope_id IS ? OR scope_id = ?))')
      .join(' OR ');
    const params: unknown[] = [...input.owners];
    for (const scope of input.scopes) {
      params.push(scope.type, scope.id ?? null, scope.id ?? null);
    }
    const ownerPlaceholders = input.owners.map(() => '?').join(', ');

    const rows = this.db
      .prepare(
        `SELECT ${SNIPPET_COLUMNS}
           FROM memory
          WHERE owner_id IN (${ownerPlaceholders}) AND is_archived = 0 AND valid_until IS NULL
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

    const ranked = rankMemories(candidates, input.query, input.limit ?? 5, now, {
      ...(input.minRelevance === undefined ? {} : { minRelevance: input.minRelevance }),
    });
    if (ranked.length > 0) this.recordRecall(ranked.map((entry) => entry.id), now);
    return ranked.map((entry) => toSnippet(entry, rows, input.query, now));
  };

  /** 按 id 取一条，给「顺着记忆里的一行往回走」用（Inline & Spill 的读侧）。 */
  get = (id: string): MemorySnippet | null => {
    const row = this.db
      .prepare(`SELECT ${SNIPPET_COLUMNS} FROM memory WHERE id = ?`)
      .get(id) as MemoryRow | undefined;
    return row ? toSnippetRow(row) : null;
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
          `SELECT ${SNIPPET_COLUMNS}
             FROM memory WHERE owner_id = ? AND is_archived = 0
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(ownerId, limit) as MemoryRow[]
    ).map(toSnippetRow);

  countForOwner = (ownerId: string): number =>
    (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM memory WHERE owner_id = ? AND is_archived = 0')
        .get(ownerId) as { n: number }
    ).n;
}

function toSnippetRow(row: MemoryRow): MemorySnippet {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? null,
    strength: row.strength,
    createdAt: row.created_at,
    sourceType: row.source_type,
    sourceId: row.source_id ?? null,
    relevance: 0,
    score: row.strength,
  };
}

/**
 * 排序后的候选 + 原始行：指针字段不必进打分函数，但要原样带出去。
 *
 * `score` 单独算回来，是因为 `rankMemories` 只返回候选本身。它的用途不是炫耀数字，
 * 是让调用方分得清「这条真对上了」和「一条都没对上，这是我记得最牢的几条」。
 */
function toSnippet(
  candidate: MemoryCandidate,
  rows: readonly MemoryRow[],
  query: string,
  now: number,
): MemorySnippet {
  const row = rows.find((entry) => entry.id === candidate.id);
  return {
    id: candidate.id,
    kind: candidate.kind,
    content: candidate.content,
    scopeType: candidate.scopeType,
    scopeId: row?.scope_id ?? null,
    // 衰减后的强度：界面上问「这条现在还结不结实」时，答案是衰减之后的值。
    strength: decayedStrength(
      candidate.strength,
      candidate.lastRecalledAt,
      candidate.createdAt,
      now,
    ),
    createdAt: candidate.createdAt,
    sourceType: row?.source_type ?? 'manual',
    sourceId: row?.source_id ?? null,
    relevance: relevanceOf(candidate, query),
    score: scoreCandidate(candidate, query, now),
  };
}
