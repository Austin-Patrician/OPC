import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ModelConfigService } from './modelConfigService';

/**
 * A refresh only knows the ids the endpoint returns. Everything the user typed
 * (prices, context windows, capability, hand-added models) must survive it, and
 * the merged list has to come back in the result so the settings table repaints
 * without a remount.
 */
let dir: string;
let db: CompanyDatabase;
let service: ModelConfigService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-models-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  service = new ModelConfigService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ModelConfigService.refreshModels', () => {  it('merges the fetched ids with the stored pricing and manual models', async () => {
    service.saveProvider({
      id: 'custom-relay',
      name: 'Custom relay',
      baseUrl: 'https://relay.test/v1',
      api: 'openai-completions',
      isCustom: true,
    });
    service.setModels('custom-relay', [
      {
        id: 'relay-a',
        name: 'Relay A',
        capability: 'chat',
        contextWindow: 128_000,
        inputUsdPerM: 1.5,
        outputUsdPerM: 3,
      },
      { id: 'manual-only', name: 'Manual only', capability: 'chat' },
    ]);

    service.runtime.testProvider = async () => ({
      ok: true,
      message: 'ok',
      models: [
        { id: 'relay-a', name: 'relay-a', capability: 'chat' },
        { id: 'relay-b', name: 'relay-b', capability: 'chat' },
      ],
    });

    const result = await service.refreshModels('custom-relay');

    expect(result.ok).toBe(true);
    expect(result.added).toEqual(['relay-b']);

    const provider = result.providers.find((entry) => entry.id === 'custom-relay');
    expect(provider?.models.map((model) => model.id).sort()).toEqual([
      'manual-only',
      'relay-a',
      'relay-b',
    ]);

    const relayA = provider?.models.find((model) => model.id === 'relay-a');
    expect(relayA).toMatchObject({
      name: 'Relay A',
      contextWindow: 128_000,
      inputUsdPerM: 1.5,
      outputUsdPerM: 3,
    });
  });

  it('fills vision from the built-in catalogue when the endpoint only lists ids', async () => {
    service.saveProvider({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      isCustom: false,
    });
    service.setModels('openai', [{ id: 'gpt-4o', name: 'GPT-4o', capability: 'chat' }]);

    service.runtime.testProvider = async () => ({
      ok: true,
      message: 'ok',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', capability: 'chat' }],
    });

    const result = await service.refreshModels('openai');
    const model = result.providers
      .find((entry) => entry.id === 'openai')
      ?.models.find((entry) => entry.id === 'gpt-4o');

    expect(model?.vision).toBe(true);
  });
});

describe('ModelConfigService.setModels', () => {
  it('keeps capability flags, api and cache prices', () => {
    service.saveProvider({
      id: 'custom-relay',
      name: 'Custom relay',
      baseUrl: 'https://relay.test/v1',
      api: 'openai-completions',
      isCustom: true,
    });
    service.setModels('custom-relay', [
      {
        id: 'vision-model',
        name: 'Vision model',
        capability: 'chat',
        api: 'openai-completions',
        contextWindow: 64_000,
        vision: true,
        reasoning: true,
        cacheReadUsdPerM: 0.1,
        cacheWriteUsdPerM: 0.2,
      },
    ]);

    expect(service.listProviders().find((entry) => entry.id === 'custom-relay')?.models).toEqual([
      expect.objectContaining({
        id: 'vision-model',
        api: 'openai-completions',
        vision: true,
        reasoning: true,
        cacheReadUsdPerM: 0.1,
        cacheWriteUsdPerM: 0.2,
      }),
    ]);
  });

  it('does not erase flags when a later save omits them', () => {
    service.saveProvider({
      id: 'custom-relay',
      name: 'Custom relay',
      baseUrl: 'https://relay.test/v1',
      api: 'openai-completions',
      isCustom: true,
    });
    service.setModels('custom-relay', [
      { id: 'vision-model', name: 'Vision', capability: 'chat', vision: true },
    ]);
    service.setModels('custom-relay', [
      { id: 'vision-model', name: 'Vision renamed', capability: 'chat' },
    ]);

    expect(
      service.listProviders().find((entry) => entry.id === 'custom-relay')?.models[0],
    ).toMatchObject({ name: 'Vision renamed', vision: true });
  });
});

describe('ModelConfigService.addModel', () => {
  it('stores the price columns typed in the table row', () => {
    service.saveProvider({
      id: 'custom-relay',
      name: 'Custom relay',
      baseUrl: 'https://relay.test/v1',
      api: 'openai-completions',
      isCustom: true,
    });

    service.addModel('custom-relay', {
      id: 'relay-hand-made',
      name: 'Hand made',
      contextWindow: 64_000,
      inputUsdPerM: 0.25,
      outputUsdPerM: 1.75,
      cacheReadUsdPerM: 0.05,
      cacheWriteUsdPerM: 0.5,
    });

    expect(service.listProviders().find((entry) => entry.id === 'custom-relay')?.models).toEqual([
      {
        id: 'relay-hand-made',
        name: 'Hand made',
        api: 'openai-completions',
        capability: 'chat',
        contextWindow: 64_000,
        inputUsdPerM: 0.25,
        outputUsdPerM: 1.75,
        cacheReadUsdPerM: 0.05,
        cacheWriteUsdPerM: 0.5,
      },
    ]);
  });
});

describe('ModelConfigService provider icon', () => {
  const base = {
    id: 'custom-relay',
    name: 'Custom relay',
    baseUrl: 'https://relay.test/v1',
    api: 'openai-completions',
    isCustom: true,
  };

  it('keeps a chosen icon when a later save does not mention it', () => {
    service.saveProvider({ ...base, icon: 'openai' });
    // Base-URL edits and other internal saves omit `icon`; they must not clear it.
    service.saveProvider({ ...base, baseUrl: 'https://relay.test/v2' });

    const provider = service.listProviders().find((entry) => entry.id === 'custom-relay');
    expect(provider?.icon).toBe('openai');
    expect(provider?.baseUrl).toBe('https://relay.test/v2');
  });

  it('clears the icon when an empty value is sent on purpose', () => {
    service.saveProvider({ ...base, icon: 'openai' });
    service.saveProvider({ ...base, icon: '' });

    expect(service.listProviders().find((entry) => entry.id === 'custom-relay')?.icon).toBeUndefined();
  });
});
