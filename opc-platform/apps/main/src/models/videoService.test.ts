import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelDefaults, ProviderConfig } from '@opc/shared/domain';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { UsageRepository } from '../data/usageRepository';
import type { ModelConfigService } from './modelConfigService';
import { VideoService } from './videoService';
import type { NetworkClient } from '../network/networkClient';

let dir: string;
let db: CompanyDatabase;
let usage: UsageRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-video-svc-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  usage = new UsageRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function createModelsStub(providers: ProviderConfig[], defaults: ModelDefaults): ModelConfigService {
  return {
    listProviders: () => providers,
    getDefaults: () => defaults,
    readKey: () => 'bearer-token',
  } as unknown as ModelConfigService;
}

function createKlingMockNetwork(): NetworkClient {
  return {
    childEnv: (base = process.env) => ({ ...base }),
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://api.klingai.com/v1/videos/text2video') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'kl-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.klingai.com/v1/videos/text2video/kl-1') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_status: 'succeed',
              task_result: { videos: [{ url: 'https://cdn.klingai.com/v.mp4', duration: '5' }] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    },
  };
}

describe('VideoService pricing & usage recording', () => {
  it('computes per-second USD cost from stored usdPerSecond and records it in UsageRepository', async () => {
    const models = createModelsStub(
      [
        {
          id: 'kling',
          name: '可灵 Kling',
          baseUrl: 'https://api.klingai.com',
          api: 'kling-video',
          isCustom: false,
          hasKey: true,
          models: [
            {
              id: 'kling-3.0',
              name: '可灵 Kling 3.0',
              capability: 'video',
              api: 'kling-video',
              videoEnabled: true,
              usdPerSecond: 0.2,
            },
          ],
          updatedAt: 0,
        },
      ],
      {
        llm: null,
        router: null,
        image: null,
        video: { providerId: 'kling', modelId: 'kling-3.0' },
        asr: null,
        tts: null,
        decision: null,
      },
    );

    const service = new VideoService(models, createKlingMockNetwork(), usage, () => 'provider_first');
    const result = await service.generateBytes({ prompt: 'Drone shot over mountains', duration: 5 });
    expect(result.ok).toBe(true);

    const report = usage.report({
      startAt: Date.now() - 60_000,
      endAt: Date.now() + 60_000,
      timezone: 'UTC',
    });
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({
      capability: 'video',
      providerId: 'kling',
      modelId: 'kling-3.0',
      billingUnit: 'second',
      billedQuantity: 5,
      configuredCostUsd: 1,
      chargedCostUsd: 1,
      costSource: 'configured',
    });
  });

  it('falls back to catalog built-in usdPerSecond when stored row omits rate', async () => {
    const models = createModelsStub(
      [
        {
          id: 'kling',
          name: '可灵 Kling',
          baseUrl: 'https://api.klingai.com',
          api: 'kling-video',
          isCustom: false,
          hasKey: true,
          models: [
            {
              id: 'kling-3.0',
              name: '可灵 Kling 3.0',
              capability: 'video',
              api: 'kling-video',
              videoEnabled: true,
            },
          ],
          updatedAt: 0,
        },
      ],
      {
        llm: null,
        router: null,
        image: null,
        video: { providerId: 'kling', modelId: 'kling-3.0' },
        asr: null,
        tts: null,
        decision: null,
      },
    );

    const service = new VideoService(models, createKlingMockNetwork(), usage, () => 'provider_first');
    const result = await service.generateBytes({ prompt: 'Catalog fallback test', duration: 5 });
    expect(result.ok).toBe(true);

    const report = usage.report({
      startAt: Date.now() - 60_000,
      endAt: Date.now() + 60_000,
      timezone: 'UTC',
    });
    expect(report.calls[0]).toMatchObject({
      configuredCostUsd: 0.56,
      chargedCostUsd: 0.56,
      costSource: 'configured',
    });
  });
});
