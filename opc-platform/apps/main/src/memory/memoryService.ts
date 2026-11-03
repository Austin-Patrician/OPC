import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';
import {
  decayedStrength,
  halfLifeOf,
  rankMemories,
  relevanceOf,
  scoreCandidate,
  type MemoryCandidate,
  type MemoryVolatility,
} from './memoryScore';

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
 * 记忆的类型。
 *
 * `kind` 以前是个自由字符串，实际上只有一个值（`'preference'`）。后果是「他否决过的
 * 方向」和「回复不要用被动语态」在库里是同一类，之后既不能按类型筛，也不能按类型
 * 决定该注入给谁——只有 Router 关心的（称呼、语气）和执行体也必须遵守的（格式、
 * 验收口径）被混在一起。
 *
 * 分档不是为了好看，是为了**注入时机**：`format` / `workflow` 要进执行体的提示词，
 * `person` / `term` 只在被问到的时候才有意义。
 */
export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'fact'
  | 'person'
  | 'term'
  | 'format'
  | 'workflow'
  | 'experience'
  | 'summary';

/**
 * 常驻层的硬上限。
 *
 * 上限不是节省，是**纪律**：每轮都进上下文的东西必须少。20 条一旦满了，系统就被迫
 * 做一件正确的事——要么撤掉一条，要么把它合并成更宽的一条。没有上限的"常驻"最后会
 * 变成一段谁都不读的日志。
 */
export const MAX_STANDING = 20;

/**
 * 观察到几次才升进常驻层。
 *
 * 三次。一次可能是一时兴起，两次可能是碰巧，三次是习惯。这里用阈值而不是"看到就升"，
 * 是因为公理 A2 说的：**应用一条错误的推断**比忘掉一条更贵——而常驻层每一轮都在生效。
 */
export const PROMOTE_AFTER = 3;

export interface MemoryServiceOptions {
  /** 一条记忆升进常驻层时通知外面（组合根用它去说话）。 */
  onPromoted?: (memory: { id: string; content: string; observations: number }) => void;
}

export interface RememberInput {
  ownerId: string;
  kind: MemoryKind;
  content: string;
  scope: MemoryScope;
  sourceType: 'task' | 'conversation' | 'consolidation' | 'manual';
  sourceId?: string;
  /** 默认 `long`。只有用户明说「以后都这样」时才该是 `standing`。 */
  tier?: MemoryTier;
  /**
   * 主题键：这条记忆讲的是哪件事（`output.format`、`称呼`、`accent.color`）。
   *
   * 给了它，同一个主题上就**只留一条活着的**——新的取代旧的，旧的留档。没给就只按
   * 内容完全相同去重，因为主题是"这条讲什么"，猜错了会把两件不相干的事合成一件。
   */
  subject?: string | null;
  /** 默认 `slow`。`stable` 是"永久有效"，`session` 是"这阵子的事"。 */
  volatility?: MemoryVolatility;
}

/**
 * 主题键的规范化。
 *
 * 只做无歧义的变换：去空白、转小写、限长。不做同义词合并——`output.format` 与
 * `reply.format` 是不是一回事，那是语义判断，属于 P3 的抽取管线，不该在写入路径上猜。
 */
export function normalizeSubject(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 80);
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
  /** 主题键。同一个主题上只会有一条活着的。 */
  subject: string | null;
  /** 被谁取代（`null` = 还是当前这条）。 */
  supersededBy: string | null;
  volatility: MemoryVolatility;
  /** 这个主题被观察到几次。到 3 次会自己升进常驻层。 */
  observations: number;
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
  subject: string | null;
  superseded_by: string | null;
  volatility: MemoryVolatility;
  observations: number;
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
  'last_recalled_at, recall_count, source_type, source_id, tier, ' +
  'subject, superseded_by, volatility, observations, embedding';

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

  constructor(
    private readonly db: CompanyDatabase,
    private readonly options: MemoryServiceOptions = {},
  ) {}

  remember = async (input: RememberInput): Promise<string> => {
    const id = `mem-${crypto.randomUUID()}`;
    const now = Date.now();
    const tier: MemoryTier = input.tier ?? 'long';
    const content = input.content.trim();
    const subject = normalizeSubject(input.subject);
    const volatility: MemoryVolatility = input.volatility ?? 'slow';

    // 一级：同一个主题、同样的内容 → 什么都不做。这不是优化，是**唯一能保证库不烂的
    // 地方**——同一句话记三遍，之后 recall 时三条会挤占五个名额里的三个。
    // 没有 subject 时退一步：同样的内容也只留一条。这不是同义词合并，是"同一句话说
    // 了两遍"——最常见的那种脏数据，而它能被**确定性地**认出来。
    const live = subject
      ? this.liveBySubject(input.ownerId, subject)
      : this.liveByContent(input.ownerId, content, tier);

    // 已经在常驻层的那条，被重新说一遍时**不许掉回长期层**：用户再提一次，是把它说得
    // 更清楚，不是要它失效。
    const effectiveTier: MemoryTier = live && 'tier' in live && live.tier === 'standing' ? 'standing' : tier;

    // 同样的内容再说一遍不是"没有新信息"——**它是最强的信号**。计数加一，也许就到了
    // 该升进常驻层的时候。
    if (live && live.content === content) {
      this.bumpObservations(live.id, live.observations + 1);
      this.maybePromote(live.id);
      return live.id;
    }

    // 同一主题上要替换掉旧的，净增为 0，所以不占常驻层的新位置。
    if (effectiveTier === 'standing') this.admitStanding(input.ownerId, live?.id ?? null);
    let embedding: Buffer | null = null;
    let embeddingModel: string | null = null;
    if (this.embed) {
      const vector = await this.embed(input.content).catch(() => undefined);
      if (vector) {
        embedding = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        embeddingModel = 'configured';
      }
    }

    const observations = this.observationCount(input.ownerId, subject);
    const insert = this.db.prepare(
      `INSERT INTO memory
         (id, owner_id, kind, content, scope_type, scope_id, embedding, embedding_model,
          source_type, source_id, valid_from, strength, created_at, updated_at, tier,
          subject, volatility, observations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?)`,
    );
    const close = this.db.prepare(
      `UPDATE memory SET valid_until = ?, superseded_by = ?, updated_at = ? WHERE id = ?`,
    );

    // 二级：同一个主题、不同的内容 → 取代。旧行只关掉、不删：**他以前要求过什么、
    // 后来改成什么**本身就是信息，而且用户说「改回去」时那条还在。
    this.db.transaction(() => {
      if (live) close.run(now, id, now, live.id);
      insert.run(
        id,
        input.ownerId,
        input.kind,
        content,
        input.scope.type,
        input.scope.id ?? null,
        embedding,
        embeddingModel,
        input.sourceType,
        input.sourceId ?? null,
        now,
        now,
        now,
        effectiveTier,
        subject,
        volatility,
        // 同一个主题上的第 N 次观察：计数跟着主题走，不跟着某一版内容走。
        observations,
      );
    })();

    this.maybePromote(id);
    return id;
  };

  /**
   * 这个主题是第几次被观察到。
   *
   * 有 subject 就数这条主题上的历史（含被取代的旧版本）；没有 subject 时每次都是独立的
   * 一条，所以是 1。**计数跟着主题走**——他先要三段，后改成五段，那是同一件事被看了两次。
   */
  private observationCount(ownerId: string, subject: string | null): number {
    if (!subject) return 1;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory WHERE owner_id = ? AND subject = ?')
      .get(ownerId, subject) as { n: number };
    return row.n + 1;
  }

  private bumpObservations(id: string, observations: number): void {
    this.db
      .prepare('UPDATE memory SET observations = ?, updated_at = ? WHERE id = ?')
      .run(observations, Date.now(), id);
  }

  /**
   * 到了次数就升进常驻层。
   *
   * 三个前提：还在长期记忆层、观察次数够了、常驻层还有位置。**没有位置就不升**——
   * 淘汰一条别人正在生效的约束，比少升一条糟糕得多。
   *
   * 升完要通知外面：不可见的自动升级是赌博（`07-memory.md` §5④）。
   */
  private maybePromote(id: string): void {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, content, observations, tier FROM memory
          WHERE id = ? AND is_archived = 0 AND valid_until IS NULL`,
      )
      .get(id) as
      | { id: string; owner_id: string; content: string; observations: number; tier: MemoryTier }
      | undefined;
    if (!row || row.tier === 'standing' || row.observations < PROMOTE_AFTER) return;
    if (this.countStanding(row.owner_id) >= MAX_STANDING) return;

    this.db.prepare('UPDATE memory SET tier = ?, updated_at = ? WHERE id = ?').run(
      'standing',
      Date.now(),
      row.id,
    );
    this.options.onPromoted?.({ id: row.id, content: row.content, observations: row.observations });
  }

  /** 改一条的内容。改完还是同一条、同一层——改的是说法，不是归属。 */
  update = (id: string, content: string): boolean => {
    const text = content.trim();
    if (text.length === 0) return false;
    const result = this.db
      .prepare('UPDATE memory SET content = ?, updated_at = ? WHERE id = ? AND is_archived = 0')
      .run(text, Date.now(), id);
    return result.changes > 0;
  };

  /**
   * 当前有效的全部记忆，常驻的排在最前。
   *
   * 「它记得什么」这个问题的答案必须是一份清单，而不是两套接口：用户不关心我们要靠
   * `tier` 分成两条路径去查，他只想知道"这东西到底记住了我什么"。
   */
  list = (ownerId: string, limit = 200): MemorySnippet[] => {
    const rows = this.db
      .prepare(
        `SELECT ${SNIPPET_COLUMNS}
           FROM memory
          WHERE owner_id = ? AND is_archived = 0 AND valid_until IS NULL
          ORDER BY CASE tier WHEN 'standing' THEN 0 ELSE 1 END, created_at DESC
          LIMIT ?`,
      )
      .all(ownerId, limit) as MemoryRow[];
    return rows.map(toSnippetRow);
  };

  /** 同一句原话已经记过了，没有就是 null。 */
  private liveByContent(
    ownerId: string,
    content: string,
    tier: MemoryTier,
  ): { id: string; content: string; observations: number } | null {
    const row = this.db
      .prepare(
        `SELECT id, content, observations FROM memory
          WHERE owner_id = ? AND content = ? AND tier = ?
            AND is_archived = 0 AND valid_until IS NULL
          LIMIT 1`,
      )
      .get(ownerId, content, tier) as
      | { id: string; content: string; observations: number }
      | undefined;
    return row ?? null;
  }

  /** 这个主题上还活着的那条，没有就是 null。 */
  private liveBySubject(
    ownerId: string,
    subject: string,
  ): { id: string; content: string; observations: number; tier: MemoryTier } | null {
    const row = this.db
      .prepare(
        `SELECT id, content, observations, tier FROM memory
          WHERE owner_id = ? AND subject = ?
            AND is_archived = 0 AND valid_until IS NULL
          LIMIT 1`,
      )
      .get(ownerId, subject) as
      | { id: string; content: string; observations: number; tier: MemoryTier }
      | undefined;
    return row ?? null;
  }

  /**
   * 进常驻层之前的闸门：**满了就明说满了**。
   *
   * 选择抛错而不是"自动淘汰最旧的"：淘汰是无提示的删除，而常驻层里被删掉的那一条，
   * 正是用户以为还在生效的那一条。让调用方把话说清楚，比悄悄换掉一条诚实。
   *
   * 内容重复不在这里管——`remember` 的通用去重已经先一步拦住了（同样的原话直接
   * 返回已有那条），常驻层不重复实现第二套判断。
   *
   * `replaces` 是"这次会替换掉同主题上的旧条目"，净增为 0，所以不占新位置。
   */
  private admitStanding(ownerId: string, replaces: string | null = null): void {
    if (replaces) return;

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
        volatility: row.volatility ?? 'slow',
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

  /**
   * 这个归属下**当前有效**的记忆。
   *
   * 被取代的（`superseded_by` 有值）不算：它们还在库里、还能按 id 取回，但不该出现在
   * "它现在记得什么"的答案里。以前这里没过滤，于是同一条规矩改过两次就有三条并列——
   * 那个列表既读不出结论，也会让界面把历史当现状。
   */
  listForOwner = (ownerId: string, limit = 50): MemorySnippet[] =>
    (
      this.db
        .prepare(
          `SELECT ${SNIPPET_COLUMNS}
             FROM memory
            WHERE owner_id = ? AND is_archived = 0 AND valid_until IS NULL
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
    subject: row.subject ?? null,
    supersededBy: row.superseded_by ?? null,
    volatility: row.volatility ?? 'slow',
    observations: row.observations ?? 1,
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
    subject: row?.subject ?? null,
    supersededBy: row?.superseded_by ?? null,
    volatility: candidate.volatility ?? 'slow',
    observations: row?.observations ?? 1,
    // 衰减后的强度：界面上问「这条现在还结不结实」时，答案是衰减之后的值。
    strength: decayedStrength(
      candidate.strength,
      candidate.lastRecalledAt,
      candidate.createdAt,
      now,
      halfLifeOf(candidate),
    ),
    createdAt: candidate.createdAt,
    sourceType: row?.source_type ?? 'manual',
    sourceId: row?.source_id ?? null,
    relevance: relevanceOf(candidate, query),
    score: scoreCandidate(candidate, query, now),
  };
}
