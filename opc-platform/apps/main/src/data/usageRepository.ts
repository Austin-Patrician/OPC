import crypto from "node:crypto";
import type {
  UsageCallView,
  UsageCostSource,
  UsageFilter,
  UsageReport,
} from "@opc/shared/ipc";
import type { CompanyDatabase } from "./companyDatabase";

export interface UsageCallDraft {
  idempotencyKey: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  employeeId?: string;
  workerId?: string;
  taskId?: string;
  conversationId?: string;
  capability: UsageCallView["capability"];
  operation: string;
  origin: string;
  providerId: string;
  modelId: string;
  status: UsageCallView["status"];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  tokenSource?: string;
  billingUnit: UsageCallView["billingUnit"];
  billedQuantity?: number;
  providerCostUsd?: number;
  configuredCostUsd?: number;
  chargedCostUsd?: number;
  costSource?: UsageCostSource;
  priceSnapshot?: unknown;
  error?: string;
}

interface CallRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  employee_id: string | null;
  worker_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  capability: UsageCallView["capability"];
  operation: string;
  origin: string;
  provider_id: string;
  model_id: string;
  status: UsageCallView["status"];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number | null;
  total_tokens: number;
  token_source: string;
  billing_unit: UsageCallView["billingUnit"];
  billed_quantity: number;
  provider_cost_usd: number | null;
  configured_cost_usd: number | null;
  charged_cost_usd: number | null;
  cost_source: UsageCostSource;
  error: string | null;
}

/** Idempotent call ledger and filterable report projection. */
export class UsageRepository {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: CompanyDatabase) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  record = (call: UsageCallDraft): void => {
    const values = [
      call.idempotencyKey,
      call.startedAt,
      call.finishedAt ?? null,
      call.durationMs ?? null,
      call.employeeId ?? null,
      call.workerId ?? null,
      call.taskId ?? null,
      call.conversationId ?? null,
      call.capability,
      call.operation,
      call.origin,
      call.providerId,
      call.modelId,
      call.status,
      call.inputTokens ?? 0,
      call.outputTokens ?? 0,
      call.cacheReadTokens ?? 0,
      call.cacheWriteTokens ?? 0,
      call.reasoningTokens ?? null,
      call.totalTokens ?? 0,
      call.tokenSource ?? "missing",
      call.billingUnit,
      call.billedQuantity ?? 0,
      call.providerCostUsd ?? null,
      call.configuredCostUsd ?? null,
      call.chargedCostUsd ?? null,
      call.costSource ?? "unpriced",
      call.priceSnapshot === undefined
        ? null
        : JSON.stringify(call.priceSnapshot),
      call.error ?? null,
    ];
    this.db
      .prepare(
        `
      INSERT INTO ai_call (
        id, idempotency_key, started_at, finished_at, duration_ms, employee_id, worker_id,
        task_id, conversation_id, capability, operation, origin, provider_id, model_id, status,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_tokens, token_source, billing_unit, billed_quantity, provider_cost_usd,
        configured_cost_usd, charged_cost_usd, cost_source, price_snapshot, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        finished_at=excluded.finished_at, duration_ms=excluded.duration_ms, status=excluded.status,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
        reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens,
        token_source=excluded.token_source, billed_quantity=excluded.billed_quantity,
        provider_cost_usd=excluded.provider_cost_usd, configured_cost_usd=excluded.configured_cost_usd,
        charged_cost_usd=excluded.charged_cost_usd, cost_source=excluded.cost_source, error=excluded.error
    `,
      )
      .run(crypto.randomUUID(), ...values);
    for (const listener of this.listeners) listener();
  };

  recordSafely = (call: UsageCallDraft): void => {
    try {
      this.record(call);
    } catch (error) {
      console.warn("[usage] 用量记录未能写入", error);
    }
  };

  /** Import trustworthy task-level totals written before the call ledger existed. */
  backfillLegacyTasks = (): number => {
    const current = this.db
      .prepare(
        "SELECT value FROM app_setting WHERE key = 'usage.backfill' LIMIT 1",
      )
      .get() as { value: string } | undefined;
    try {
      if (
        current &&
        (JSON.parse(current.value) as { backfillComplete?: boolean })
          .backfillComplete
      )
        return 0;
    } catch {
      // Repair malformed progress metadata by repeating the idempotent import.
    }

    const rows = this.db
      .prepare(
        `SELECT t.id, t.worker_id, t.status, t.tokens_used, t.cost_usd, t.started_at, t.finished_at, t.created_at, t.updated_at
         FROM task t
         WHERE (t.tokens_used > 0 OR t.cost_usd > 0)
           AND NOT EXISTS (SELECT 1 FROM ai_call c WHERE c.task_id = t.id)
         ORDER BY t.created_at, t.id`,
      )
      .all() as Array<{
      id: string;
      worker_id: string | null;
      status: string;
      tokens_used: number;
      cost_usd: number;
      started_at: number | null;
      finished_at: number | null;
      created_at: number;
      updated_at: number;
    }>;
    const insert = this.db.transaction(() => {
      let imported = 0;
      for (const row of rows) {
        const before = this.db
          .prepare("SELECT 1 AS found FROM ai_call WHERE idempotency_key = ?")
          .get(`legacy-task:${row.id}`);
        this.record({
          idempotencyKey: `legacy-task:${row.id}`,
          startedAt: row.started_at ?? row.created_at,
          finishedAt: row.finished_at ?? row.updated_at,
          durationMs: Math.max(
            0,
            (row.finished_at ?? row.updated_at) -
              (row.started_at ?? row.created_at),
          ),
          workerId: row.worker_id ?? undefined,
          taskId: row.id,
          capability: "chat",
          operation: "historical task usage total",
          origin: "worker",
          providerId: "legacy-history",
          modelId: "task aggregate",
          status: legacyTaskStatus(row.status),
          totalTokens: row.tokens_used,
          tokenSource: "legacy-task-total",
          billingUnit: "token",
          billedQuantity: row.tokens_used,
          ...(row.cost_usd > 0
            ? { chargedCostUsd: row.cost_usd, configuredCostUsd: row.cost_usd }
            : {}),
          costSource: "legacy",
        });
        if (!before) imported += 1;
      }
      const backfillFrom =
        rows.length > 0
          ? (rows[0]?.started_at ?? rows[0]?.created_at ?? null)
          : null;
      this.db
        .prepare(
          "INSERT INTO app_setting (key, value, updated_at) VALUES ('usage.backfill', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .run(
          JSON.stringify({
            backfillComplete: true,
            backfillFrom,
            updatedAt: Date.now(),
          }),
          Date.now(),
        );
      return imported;
    });
    return insert();
  };

  report = (filter: UsageFilter): UsageReport => {
    const normalized = normalizeFilter(filter);
    const { where, values } = this.where(normalized);
    const rows = this.db
      .prepare(
        `SELECT c.*, w.name AS worker_name
      FROM ai_call c LEFT JOIN worker w ON w.id = c.worker_id
      WHERE ${where} ORDER BY c.started_at DESC, c.id DESC`,
      )
      .iterate(...values) as IterableIterator<
      CallRow & { worker_name: string | null }
    >;
    const pageStart = (normalized.page - 1) * normalized.pageSize;
    const pageEnd = pageStart + normalized.pageSize;
    const calls: UsageCallView[] = [];
    let totalCalls = 0;
    let terminalCalls = 0;
    let successfulCalls = 0;
    const summary: UsageReport["summary"] = {
      chargedCostUsd: 0,
      unpricedCalls: 0,
      totalTokens: 0,
      requests: 0,
      successRate: null,
      images: 0,
      asrSeconds: 0,
      ttsCharacters: 0,
    };
    const seriesMap = new Map<string, UsageReport["series"][number]>();
    const breakdownMap = new Map<string, UsageReport["breakdown"][number]>();
    const modelSeries = new Map<
      string,
      Map<
        string,
        UsageReport["actors"]["modelSeries"][number]["models"][number]
      >
    >();
    const routerSeries = new Map<
      string,
      UsageReport["actors"]["router"][number]
    >();
    const workerSeries = new Map<
      string,
      Map<
        string,
        UsageReport["actors"]["workerSeries"][number]["workers"][number]
      >
    >();
    const workerTotals = new Map<
      string,
      UsageReport["actors"]["workers"][number]
    >();
    const providers = new Set<string>();
    const models = new Set<string>();
    const origins = new Set<string>();
    const workers = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      if (totalCalls >= pageStart && totalCalls < pageEnd)
        calls.push(toView(row));
      totalCalls += 1;
      providers.add(row.provider_id);
      models.add(row.model_id);
      origins.add(row.origin);
      if (row.worker_id)
        workers.set(row.worker_id, {
          id: row.worker_id,
          name: row.worker_name || row.worker_id,
        });
      if (["ok", "error", "aborted", "interrupted"].includes(row.status)) {
        terminalCalls += 1;
        if (row.status === "ok") successfulCalls += 1;
      }
      summary.chargedCostUsd += row.charged_cost_usd ?? 0;
      summary.unpricedCalls += row.cost_source === "unpriced" ? 1 : 0;
      summary.totalTokens += row.total_tokens;
      summary.requests += 1;
      if (row.capability === "image") summary.images += row.billed_quantity;
      if (row.capability === "asr" && row.billing_unit === "second")
        summary.asrSeconds += row.billed_quantity;
      if (row.capability === "tts" && row.billing_unit === "character")
        summary.ttsCharacters += row.billed_quantity;
      const bucket = timeBucket(row.started_at, normalized);
      const point = seriesMap.get(bucket.key) ?? {
        at: bucket.at,
        label: bucket.label,
        costUsd: 0,
        tokens: 0,
        requests: 0,
        unpricedCalls: 0,
      };
      point.costUsd += row.charged_cost_usd ?? 0;
      point.tokens += row.total_tokens;
      point.requests += 1;
      if (row.cost_source === "unpriced") point.unpricedCalls += 1;
      seriesMap.set(bucket.key, point);
      if (row.origin === "router") {
        const actorPoint = routerSeries.get(bucket.key) ?? {
          at: bucket.at,
          label: bucket.label,
          costUsd: 0,
          tokens: 0,
        };
        actorPoint.costUsd += row.charged_cost_usd ?? 0;
        actorPoint.tokens += row.total_tokens;
        routerSeries.set(bucket.key, actorPoint);
      }
      if (row.origin === "worker" && row.worker_id) {
        const workerId = row.worker_id;
        const workerName = row.worker_name || workerId;
        const periodWorkers = workerSeries.get(bucket.key) ?? new Map();
        const periodWorker = periodWorkers.get(workerId) ?? {
          id: workerId,
          name: workerName,
          costUsd: 0,
          tokens: 0,
        };
        periodWorker.costUsd += row.charged_cost_usd ?? 0;
        periodWorker.tokens += row.total_tokens;
        periodWorkers.set(workerId, periodWorker);
        workerSeries.set(bucket.key, periodWorkers);
        const totalWorker = workerTotals.get(workerId) ?? {
          id: workerId,
          name: workerName,
          costUsd: 0,
          tokens: 0,
          requests: 0,
        };
        totalWorker.costUsd += row.charged_cost_usd ?? 0;
        totalWorker.tokens += row.total_tokens;
        totalWorker.requests += 1;
        workerTotals.set(workerId, totalWorker);
      }
      const groupKey = `${row.provider_id}\u0000${row.model_id}`;
      const group = breakdownMap.get(groupKey) ?? {
        key: groupKey,
        label: `${row.provider_id} / ${row.model_id}`,
        costUsd: 0,
        tokens: 0,
        requests: 0,
        unpricedCalls: 0,
      };
      group.costUsd += row.charged_cost_usd ?? 0;
      group.tokens += row.total_tokens;
      group.requests += 1;
      if (row.cost_source === "unpriced") group.unpricedCalls += 1;
      breakdownMap.set(groupKey, group);
      const periodModels = modelSeries.get(bucket.key) ?? new Map();
      const periodModel = periodModels.get(groupKey) ?? {
        key: groupKey,
        label: group.label,
        requests: 0,
      };
      periodModel.requests += 1;
      periodModels.set(groupKey, periodModel);
      modelSeries.set(bucket.key, periodModels);
    }
    const page = normalized.page;
    const pageSize = normalized.pageSize;
    const workerLifecycle = this.workerLifecycle(normalized);
    summary.successRate = terminalCalls
      ? successfulCalls / terminalCalls
      : null;
    const backfill = this.db
      .prepare(
        "SELECT value FROM app_setting WHERE key = 'usage.backfill' LIMIT 1",
      )
      .get() as { value: string } | undefined;
    let coverage: UsageReport["coverage"] = {
      backfillComplete: false,
      backfillFrom: null,
      updatedAt: 0,
    };
    try {
      if (backfill)
        coverage = {
          ...coverage,
          ...(JSON.parse(backfill.value) as UsageReport["coverage"]),
        };
    } catch {
      /* show conservative defaults */
    }
    return {
      summary,
      series: [...seriesMap.values()].sort((a, b) => a.at - b.at),
      breakdown: [...breakdownMap.values()]
        .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)
        .slice(0, 12),
      actors: {
        models: [...breakdownMap.values()].sort(
          (a, b) => b.requests - a.requests || b.costUsd - a.costUsd,
        ),
        modelSeries: [...modelSeries.entries()]
          .map(([key, models]) => ({
            at: seriesMap.get(key)?.at ?? 0,
            label: seriesMap.get(key)?.label ?? key,
            models: [...models.values()],
          }))
          .sort((a, b) => a.at - b.at),
        router: [...routerSeries.values()].sort((a, b) => a.at - b.at),
        workers: [...workerTotals.values()].sort(
          (a, b) => b.costUsd - a.costUsd || b.requests - a.requests,
        ),
        workerSeries: [...workerSeries.entries()]
          .map(([key, workers]) => ({
            at: seriesMap.get(key)?.at ?? 0,
            label: seriesMap.get(key)?.label ?? key,
            workers: [...workers.values()],
          }))
          .sort((a, b) => a.at - b.at),
      },
      workerLifecycle,
      calls,
      totalCalls,
      page,
      pageSize,
      options: {
        providers: [...providers].sort(),
        models: [...models].sort(),
        origins: [...origins].sort(),
        workers: [...workers.values()],
      },
      coverage,
    };
  };

  rowsForExport = (filter: UsageFilter): UsageCallView[] => {
    const normalized = normalizeFilter(filter);
    const { where, values } = this.where(normalized);
    return (
      this.db
        .prepare(
          `SELECT c.*, w.name AS worker_name
      FROM ai_call c LEFT JOIN worker w ON w.id = c.worker_id
      WHERE ${where} ORDER BY c.started_at DESC, c.id DESC`,
        )
        .all(...values) as (CallRow & { worker_name: string | null })[]
    ).map(toView);
  };

  private where(filter: ReturnType<typeof normalizeFilter>): {
    where: string;
    values: unknown[];
  } {
    const terms = ["c.started_at >= ?", "c.started_at < ?"];
    const values: unknown[] = [filter.startAt, filter.endAt];
    const inList = (column: string, entries: readonly string[] | undefined) => {
      if (!entries?.length) return;
      terms.push(`${column} IN (${entries.map(() => "?").join(",")})`);
      values.push(...entries);
    };
    inList("c.capability", filter.capabilities);
    inList("c.provider_id", filter.providers);
    inList("c.model_id", filter.models);
    inList("c.origin", filter.origins);
    inList("c.worker_id", filter.workers);
    inList("c.status", filter.statuses);
    inList("c.cost_source", filter.costSources);
    if (filter.query) {
      const like = `%${filter.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      terms.push(
        "(c.provider_id LIKE ? ESCAPE '\\' OR c.model_id LIKE ? ESCAPE '\\' OR c.operation LIKE ? ESCAPE '\\' OR c.task_id LIKE ? ESCAPE '\\' OR c.conversation_id LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')",
      );
      values.push(like, like, like, like, like, like);
    }
    const range = (
      column: string,
      min: number | undefined,
      max: number | undefined,
    ) => {
      if (min !== undefined) {
        terms.push(`${column} >= ?`);
        values.push(min);
      }
      if (max !== undefined) {
        terms.push(`${column} <= ?`);
        values.push(max);
      }
    };
    range("c.total_tokens", filter.minTokens, filter.maxTokens);
    range("c.charged_cost_usd", filter.minCostUsd, filter.maxCostUsd);
    range("c.duration_ms", filter.minDurationMs, filter.maxDurationMs);
    return { where: terms.join(" AND "), values };
  }

  private workerLifecycle(
    filter: ReturnType<typeof normalizeFilter>,
  ): UsageReport["workerLifecycle"] {
    const rows = this.db
      .prepare(
        `SELECT created_at, retired_at FROM worker
       WHERE created_at <= ? AND (retired_at IS NULL OR retired_at >= ?)
       ORDER BY created_at`,
      )
      .all(filter.endAt, filter.startAt) as Array<{
      created_at: number;
      retired_at: number | null;
    }>;
    const events = new Map<
      string,
      {
        bucket: ReturnType<typeof timeBucket>;
        created: number;
        retired: number;
      }
    >();
    let active = rows.filter(
      (row) =>
        row.created_at < filter.startAt &&
        (row.retired_at === null || row.retired_at >= filter.startAt),
    ).length;
    const add = (at: number, kind: "created" | "retired") => {
      if (at < filter.startAt || at >= filter.endAt) return;
      const bucket = timeBucket(at, filter);
      const event = events.get(bucket.key) ?? {
        bucket,
        created: 0,
        retired: 0,
      };
      event[kind] += 1;
      events.set(bucket.key, event);
    };
    for (const row of rows) {
      add(row.created_at, "created");
      if (row.retired_at !== null) add(row.retired_at, "retired");
    }
    return [...events.values()]
      .sort((a, b) => a.bucket.at - b.bucket.at)
      .map((event) => {
        active += event.created - event.retired;
        return {
          at: event.bucket.at,
          label: event.bucket.label,
          active,
          created: event.created,
          retired: event.retired,
        };
      });
  }
}

function legacyTaskStatus(status: string): UsageCallView["status"] {
  if (status === "accepted" || status === "delivered") return "ok";
  if (status === "failed" || status === "rejected") return "error";
  if (status === "cancelled") return "aborted";
  return "unknown";
}

export function normalizeFilter(
  input: UsageFilter,
): UsageFilter & { page: number; pageSize: number } {
  if (
    !Number.isFinite(input.startAt) ||
    !Number.isFinite(input.endAt) ||
    input.endAt <= input.startAt
  )
    throw new Error("Usage 时间范围无效");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  } catch {
    throw new Error("Usage 时区无效");
  }
  const bounded = (value: number | undefined, min: number, max: number) =>
    value === undefined
      ? undefined
      : Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : undefined;
  return {
    ...input,
    page: Math.floor(bounded(input.page, 1, 1_000_000) ?? 1),
    pageSize: Math.floor(bounded(input.pageSize, 1, 200) ?? 50),
    query: input.query?.trim().slice(0, 200) || undefined,
  };
}

function toView(row: CallRow & { worker_name: string | null }): UsageCallView {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    employeeId: row.employee_id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    capability: row.capability,
    operation: row.operation,
    origin: row.origin,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    tokenSource: row.token_source,
    billingUnit: row.billing_unit,
    billedQuantity: row.billed_quantity,
    providerCostUsd: row.provider_cost_usd,
    configuredCostUsd: row.configured_cost_usd,
    chargedCostUsd: row.charged_cost_usd,
    costSource: row.cost_source,
    error: row.error,
  };
}

function timeBucket(
  at: number,
  filter: UsageFilter,
): { key: string; at: number; label: string } {
  const span = filter.endAt - filter.startAt;
  const granularity =
    span <= 48 * 60 * 60_000
      ? "hour"
      : span <= 90 * 24 * 60 * 60_000
        ? "day"
        : "month";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: filter.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(granularity !== "month"
      ? { hour: "2-digit", hourCycle: "h23" as const }
      : {}),
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const key =
    granularity === "month"
      ? `${p.year}-${p.month}`
      : granularity === "day"
        ? `${p.year}-${p.month}-${p.day}`
        : `${p.year}-${p.month}-${p.day}T${p.hour}`;
  const label =
    granularity === "month"
      ? key
      : granularity === "day"
        ? `${p.month}/${p.day}`
        : `${p.month}/${p.day} ${p.hour}:00`;
  return {
    key,
    at: Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour ?? 0),
    ),
    label,
  };
}
