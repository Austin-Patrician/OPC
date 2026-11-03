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

/**
 * 记忆的层。
 *
 * - `standing`：**常驻约束**。每轮进上下文，不参与检索、不衰减、有硬上限。
 *   存的是"违反了就会被指出来"的东西：称呼、语气、格式禁令。
 * - `long`：长期记忆。按相关度召回，衰减只影响排序。
 *
 * 区别不是重要程度，是**失效方式**：常驻约束漏一次用户就看见了；长期记忆想不起来
 * 只是慢一点。用同一条衰减曲线套两者，必然要么漏前者、要么被后者撑爆。
 */
export type MemoryTier = 'long' | 'standing';

/**
 * 常驻层的硬上限。
 *
 * 上限不是节省，是**纪律**：每轮都进上下文的东西必须少。20 条一旦满了，系统就被迫
 * 做一件正确的事——要么撤掉一条，要么把它合并成更宽的一条。没有上限的"常驻"最后会
 * 变成一段谁都不读的日志。
 */
export const MAX_STANDING = 20;

export interface RememberInput {
  ownerId: string;
  kind: MemoryCandidate['kind'] | 'preference' | 'summary';
  content: string;
  scope: MemoryScope;
  sourceType: 'task' | 'conversation' | 'consolidation' | 'manual';
  sourceId?: string;
  /** 默认 `long`。只有用户明说「以后都这样」时才该是 `standing`。 */
  tier?: MemoryTier;
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
  /** 常驻约束还是长期记忆。界面用它分组，调用方用它决定要不要按相关度筛。 */
  tier: MemoryTier;
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
  tier: MemoryTier;
  embedding: Buffer | null;
}

/** 所有取回路径读同一组列：少一列，某个调用方就会悄悄拿不到指针。 */
const SNIPPET_COLUMNS =
  'id, owner_id, content, kind, scope_type, scope_id, strength, created_at, ' +
  'last_recalled_at, recall_count, source_type, source_id, tier, embedding';

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
    const tier: MemoryTier = input.tier ?? 'long';
    const content = input.content.trim();
    if (tier === 'standing') this.admitStanding(input.ownerId, content);
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
            source_type, source_id, valid_from, strength, created_at, updated_at, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?)`,
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
        tier,
      );
    return id;
  };

  /**
   * 进常驻层之前的两道门：**同样的内容不记第二遍**，**满了就明说满了**。
   *
   * 第一道是必要的而不是优化：常驻层只有 20 个位置，一句「别写注释」被记三遍就吃掉
   * 三个位置，而那三遍在上下文里长得一模一样。
   *
   * 第二道选择抛错而不是"自动淘汰最旧的"：淘汰是无提示的删除，而常驻层里被删掉的
   * 那一条，正是用户以为还在生效的那一条。让调用方把话说清楚，比悄悄换掉一条诚实。
   */
  private admitStanding(ownerId: string, content: string): void {
    const existing = this.db
      .prepare(
        `SELECT id FROM memory
          WHERE owner_id = ? AND tier = 'standing' AND content = ?
            AND is_archived = 0 AND valid_until IS NULL
          LIMIT 1`,
      )
      .get(ownerId, content) as { id: string } | undefined;
    if (existing) throw new Error(`这条已经在常驻约束里了（${existing.id}）`);

    const used = this.countStanding(ownerId);
    if (used >= MAX_STANDING) {
      throw new Error(
        `常驻约束已经 ${used} 条，满了（上限 ${MAX_STANDING}）。` +
          '先撤掉一条、或者把两条合并成一条更宽的，再记新的。',
      );
    }
  }

  countStanding = (ownerId: string): number =>
    (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory
            WHERE owner_id = ? AND tier = 'standing' AND is_archived = 0 AND valid_until IS NULL`,
        )
        .get(ownerId) as { n: number }
    ).n;

  /**
   * 常驻层。**不排序、不衰减、不按相关度挑**——它每一轮原样进上下文。
   *
   * 按创建时间正序而不是倒序：这个列表会出现在每一轮的输入里，顺序稳定才能吃到
   * provider 的提示词缓存，也让"上一轮和这一轮的区别"一眼看得出来。
   */
  standing = (ownerId: string): MemorySnippet[] => {
    const rows = this.db
      .prepare(
        `SELECT ${SNIPPET_COLUMNS}
           FROM memory
          WHERE owner_id = ? AND tier = 'standing' AND is_archived = 0 AND valid_until IS NULL
          ORDER BY created_at ASC
          LIMIT ${MAX_STANDING}`,
      )
      .all(ownerId) as MemoryRow[];
    return rows.map(toSnippetRow);
  };

  /**
   * 撤掉一条。
   *
   * 归档而不是删除：用户撤掉的那一条本身就是信息（他以前要求过什么、后来不要了）。
   * 而且撤错了还能找回来。
   */
  forget = (id: string): boolean => {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE memory SET is_archived = 1, valid_until = ?, updated_at = ? WHERE id = ? AND is_archived = 0')
      .run(now, now, id);
    return result.changes > 0;
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
            -- 常驻层不参与检索：它本来就在上下文里，再挤进 top-5 只是占掉一个名额。
            AND tier = 'long'
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
    tier: row.tier ?? 'long',
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
    tier: row?.tier ?? 'long',
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
