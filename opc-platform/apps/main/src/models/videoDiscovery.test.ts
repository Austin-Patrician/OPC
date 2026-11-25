import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@opc/shared/domain';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import type { NetworkClient } from '../network/networkClient';
import { ModelConfigService } from './modelConfigService';
import { discoverVideoModels } from './videoDiscovery';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const providerRow = (over: Partial<ProviderConfig> & { id: string }): ProviderConfig => ({
  name: over.id,
  baseUrl: over.baseUrl ?? '',
  api: over.api ?? 'openai-videos',
  isCustom: false,
  hasKey: true,
  models: [],
  updatedAt: 0,
  ...over,
});

describe('discoverVideoModels', () => {
  it('fetches live fal.ai video endpoints and enriches preset rates while skipping deprecated entries', async () => {
    const network: NetworkClient = {
      childEnv: (base = process.env) => ({ ...base }),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('category=text-to-video')) {
          return json({
            models: [
              { endpoint_id: 'kling/v4/text-to-video', name: 'Kling 4.0 T2V', status: 'active' },
              { endpoint_id: 'fal-ai/legacy', name: 'Legacy', status: 'deprecated' },
            ],
          });
        }
        return json({
          models: [
            { endpoint_id: 'kling/v4/text-to-video', name: 'Duplicate T2V' },
            { endpoint_id: 'bytedance/seedance-2.5/image-to-video', name: 'Seedance 2.5 I2V' },
          ],
        });
      },
    };

    const result = await discoverVideoModels(
      providerRow({ id: 'fal', baseUrl: 'https://queue.fal.run', api: 'fal-queue' }),
      'fal-key',
      network,
    );

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: 'kling/v4/text-to-video', name: 'Kling 4.0 T2V', api: 'fal-queue', usdPerSecond: 0.157 },
      { id: 'bytedance/seedance-2.5/image-to-video', name: 'Seedance 2.5 I2V', api: 'fal-queue', usdPerSecond: 0.216 },
    ]);
  });

  it('fetches Volcengine Ark video models using domain/task_type/id filters and skips chat models', async () => {
    const network: NetworkClient = {
      childEnv: (base = process.env) => ({ ...base }),
      fetch: async () =>
        json({
          data: [
            { id: 'deepseek-v3', owned_by: 'volcengine', domain: 'LLM' },
            {
              id: 'doubao-seedance-2-5-flash-261115',
              domain: 'VideoGeneration',
              task_type: ['text_to_video', 'image_to_video'],
            },
            { id: 'doubao-seedance-3-0-alpha', task_type: ['text_to_video'] },
          ],
        }),
    };

    const result = await discoverVideoModels(
      providerRow({
        id: 'volcengine-ark',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        api: 'volcengine-ark-video',
      }),
      'ark-key',
      network,
    );

    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([
      'doubao-seedance-2-5-flash-261115',
      'doubao-seedance-3-0-alpha',
    ]);
    expect(result.models[0]?.usdPerSecond).toBe(0.152);
  });

  it('fetches Google Veo models from Gemini /models and strips models/ prefix', async () => {
    const network: NetworkClient = {
      childEnv: (base = process.env) => ({ ...base }),
      fetch: async () =>
        json({
          models: [
            { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
            {
              name: 'models/veo-3.1-fast-generate-001',
              displayName: 'Veo 3.1 Fast',
              supportedGenerationMethods: ['predictLongRunning'],
            },
          ],
        }),
    };

    const result = await discoverVideoModels(
      providerRow({
        id: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        api: 'google-veo',
      }),
      'goog-key',
      network,
    );

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: 'veo-3.1-fast-generate-001', name: 'Veo 3.1 Fast', api: 'google-veo', usdPerSecond: 0.15 },
    ]);
  });

  it('returns clear explanation for official Kling/MiniMax hosts lacking /models, but fetches custom gateways', async () => {
    const network: NetworkClient = {
      childEnv: (base = process.env) => ({ ...base }),
      fetch: async () => json({ data: [{ id: 'kling-v4-0' }, { id: 'gpt-5.5' }] }),
    };

    const official = await discoverVideoModels(
      providerRow({ id: 'kling', baseUrl: 'https://api.klingai.com', api: 'kling-video' }),
      'bearer',
      network,
    );
    expect(official.ok).toBe(false);
    expect(official.message).toContain('官方接口暂未开放');

    const gateway = await discoverVideoModels(
      providerRow({ id: 'kling', baseUrl: 'https://relay.example.com/v1', api: 'kling-video' }),
      'bearer',
      network,
    );
    expect(gateway.ok).toBe(true);
    expect(gateway.models.map((m) => m.id)).toEqual(['kling-v4-0']);
  });
});

describe('ModelConfigService.refreshModels video scope', () => {
  let dir: string;
  let db: CompanyDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'opc-video-refresh-'));
    db = openCompanyDatabase(path.join(dir, 'company.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges live video models while keeping existing chat models and user videoEnabled/rate overrides', async () => {
    const network: NetworkClient = {
      childEnv: (base = process.env) => ({ ...base }),
      fetch: async () =>
        json({
          data: [
            { id: 'doubao-seedance-2-5-260628', domain: 'VideoGeneration' },
            { id: 'doubao-seedance-2-5-flash-261115', domain: 'VideoGeneration' },
          ],
        }),
    };
    const service = new ModelConfigService(db, undefined, network);
    service.saveProvider({
      id: 'volcengine-ark',
      name: '火山引擎方舟',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      api: 'volcengine-ark-video',
      isCustom: false,
      scope: 'video',
    });
    // Stub readKey without safeStorage
    (service as unknown as { readKey: (id: string) => string }).readKey = () => 'ark-token';
    service.setModels('volcengine-ark', [
      { id: 'doubao-pro-chat', name: 'Doubao Chat', capability: 'chat' },
      {
        id: 'doubao-seedance-2-5-260628',
        name: '豆包 Seedance 2.5',
        capability: 'video',
        api: 'volcengine-ark-video',
        videoEnabled: true,
        usdPerSecond: 0.25,
      },
    ]);

    const res = await service.refreshModels('volcengine-ark', 'video');
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(['doubao-seedance-2-5-flash-261115']);

    const provider = res.providers.find((p) => p.id === 'volcengine-ark')!;
    expect(provider.models.find((m) => m.id === 'doubao-pro-chat')).toMatchObject({ capability: 'chat' });
    expect(provider.models.find((m) => m.id === 'doubao-seedance-2-5-260628')).toMatchObject({
      videoEnabled: true,
      usdPerSecond: 0.25,
    });
    expect(provider.models.find((m) => m.id === 'doubao-seedance-2-5-flash-261115')).toMatchObject({
      capability: 'video',
      videoEnabled: false,
      usdPerSecond: 0.152,
    });
  });
});
