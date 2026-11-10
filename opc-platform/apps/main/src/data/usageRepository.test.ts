import { afterEach, describe, expect, it } from "vitest";
import { openCompanyDatabase } from "./companyDatabase";
import { UsageRepository } from "./usageRepository";

const dbs: ReturnType<typeof openCompanyDatabase>[] = [];
function repository() {
  const db = openCompanyDatabase(":memory:");
  dbs.push(db);
  return new UsageRepository(db);
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("UsageRepository", () => {
  it("imports legacy task totals once without inventing request or model details", () => {
    const usage = repository();
    const db = dbs.at(-1)!;
    db.prepare(
      `INSERT INTO task (id, title, owner_id, owner_name, workspace_rel_path, status,
                         tokens_used, cost_usd, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-old",
      "旧任务",
      "company-local",
      "旧执行体",
      "tasks/old",
      "accepted",
      1250,
      0.025,
      1000,
      2500,
      900,
      2500,
    );

    expect(usage.backfillLegacyTasks()).toBe(1);
    expect(usage.backfillLegacyTasks()).toBe(0);

    const report = usage.report({ startAt: 0, endAt: 3000, timezone: "UTC" });
    expect(report.totalCalls).toBe(1);
    expect(report.calls[0]).toMatchObject({
      taskId: "task-old",
      workerId: null,
      status: "ok",
      totalTokens: 1250,
      inputTokens: 0,
      outputTokens: 0,
      tokenSource: "legacy-task-total",
      providerId: "legacy-history",
      modelId: "task aggregate",
      chargedCostUsd: 0.025,
      costSource: "legacy",
    });
    expect(report.coverage).toMatchObject({
      backfillComplete: true,
      backfillFrom: 1000,
    });
  });

  it("marks the historical import complete when there are no legacy totals", () => {
    const usage = repository();
    expect(usage.backfillLegacyTasks()).toBe(0);
    expect(
      usage.report({ startAt: 0, endAt: 1, timezone: "UTC" }).coverage
        .backfillComplete,
    ).toBe(true);
  });

  it("upserts a stable call key and keeps unknown cost distinct from zero", () => {
    const usage = repository();
    usage.record({
      idempotencyKey: "worker:session:1",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      capability: "chat",
      operation: "pi conversation usage delta",
      origin: "worker",
      providerId: "relay",
      modelId: "model-a",
      status: "ok",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      tokenSource: "pi.session-delta",
      billingUnit: "token",
      costSource: "unpriced",
    });
    usage.record({
      idempotencyKey: "worker:session:1",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_002_000,
      capability: "chat",
      operation: "pi conversation usage delta",
      origin: "worker",
      providerId: "relay",
      modelId: "model-a",
      status: "ok",
      inputTokens: 15,
      outputTokens: 10,
      totalTokens: 25,
      tokenSource: "pi.session-delta",
      billingUnit: "token",
      costSource: "unpriced",
    });

    const report = usage.report({
      startAt: 1_699_999_999_000,
      endAt: 1_700_000_010_000,
      timezone: "UTC",
    });
    expect(report.totalCalls).toBe(1);
    expect(report.calls[0]).toMatchObject({
      totalTokens: 25,
      chargedCostUsd: null,
      costSource: "unpriced",
    });
    expect(report.summary.chargedCostUsd).toBe(0);
    expect(report.summary.unpricedCalls).toBe(1);
  });

  it("applies composable filters before calculating the visible totals", () => {
    const usage = repository();
    const base = {
      startedAt: 1_700_000_000_000,
      capability: "chat" as const,
      operation: "completion",
      origin: "worker",
      providerId: "relay",
      status: "ok" as const,
      billingUnit: "token" as const,
    };
    usage.record({
      ...base,
      idempotencyKey: "a",
      modelId: "model-a",
      totalTokens: 100,
      chargedCostUsd: 0.02,
      costSource: "configured",
    });
    usage.record({
      ...base,
      idempotencyKey: "b",
      modelId: "model-b",
      origin: "router",
      totalTokens: 50,
      chargedCostUsd: 0.01,
      costSource: "configured",
    });

    const report = usage.report({
      startAt: 1_699_999_999_000,
      endAt: 1_700_000_010_000,
      timezone: "UTC",
      providers: ["relay"],
      models: ["model-a"],
      origins: ["worker"],
      minTokens: 80,
    });
    expect(report.totalCalls).toBe(1);
    expect(report.summary).toMatchObject({
      requests: 1,
      totalTokens: 100,
      chargedCostUsd: 0.02,
    });
    expect(report.options.models).toEqual(["model-a"]);
  });

  it("returns full analytics independent of detail pagination and call filters", () => {
    const usage = repository();
    const db = dbs.at(-1)!;
    const worker = db.prepare(
      `INSERT INTO worker (id, name, template, skills, status, spent_tokens, created_at, retired_at)
       VALUES (?, ?, 'research', '[]', ?, 0, ?, ?)`,
    );
    worker.run(
      "w-old",
      "Old worker",
      "retired",
      1_700_000_000_000,
      1_700_000_008_000,
    );
    worker.run("w-live", "Live worker", "idle", 1_700_000_004_000, null);

    const base = {
      startedAt: 1_700_000_005_000,
      capability: "chat" as const,
      operation: "completion",
      status: "ok" as const,
      billingUnit: "token" as const,
    };
    usage.record({
      ...base,
      idempotencyKey: "router-a",
      origin: "router",
      providerId: "relay",
      modelId: "fast",
      totalTokens: 10,
      chargedCostUsd: 0.01,
      costSource: "configured",
    });
    usage.record({
      ...base,
      idempotencyKey: "worker-a",
      origin: "worker",
      workerId: "w-live",
      providerId: "relay",
      modelId: "deep",
      totalTokens: 40,
      chargedCostUsd: 0.04,
      costSource: "configured",
    });
    usage.record({
      ...base,
      idempotencyKey: "worker-b",
      origin: "worker",
      workerId: "w-live",
      providerId: "relay",
      modelId: "deep",
      status: "error",
      totalTokens: 5,
      costSource: "unpriced",
    });

    const report = usage.report({
      startAt: 1_700_000_000_000,
      endAt: 1_700_000_010_000,
      timezone: "UTC",
      providers: ["relay"],
      models: ["deep"],
      statuses: ["ok"],
      page: 1,
      pageSize: 1,
    });

    expect(report.calls).toHaveLength(1);
    expect(report.totalCalls).toBe(1);
    expect(report.actors.models).toMatchObject([
      { label: "relay / deep", requests: 1, tokens: 40 },
    ]);
    expect(report.actors.router).toEqual([]);
    expect(report.actors.workers).toMatchObject([
      { id: "w-live", name: "Live worker", requests: 1 },
    ]);
    expect(report.actors.workerSeries).toHaveLength(1);
    expect(
      report.workerLifecycle.map(({ active, created, retired }) => ({
        active,
        created,
        retired,
      })),
    ).toEqual([{ active: 1, created: 2, retired: 1 }]);
  });
});
