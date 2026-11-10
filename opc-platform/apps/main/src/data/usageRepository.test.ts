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
});
