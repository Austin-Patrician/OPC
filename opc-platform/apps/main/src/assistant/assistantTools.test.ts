import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../models/keyCipher', () => ({
  encryptSecret: (value: string) => Buffer.from(value),
  decryptSecret: (value: Buffer) => value.toString(),
}));

import { AssistantToolsService, calculate } from './assistantTools';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { NetworkClient } from '../network/networkClient';

function database() {
  const rows = new Map<string, string>();
  const db = {
    prepare(_sql: string) {
      return {
        get(key: string) { return rows.has(key) ? { value: rows.get(key)! } : undefined; },
        run(key: string, value: string, _updatedAt: number) { rows.set(key, value); },
      };
    },
  };
  return { db: db as unknown as CompanyDatabase, rows };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('assistant tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses validated IANA time zones and persists the preference', () => {
    const { db } = database();
    const service = new AssistantToolsService(db, { fetch: vi.fn() } as unknown as NetworkClient);
    expect(service.getSettings().timezone).toBeNull();
    expect(() => service.updateSettings({ timezone: 'Not/AZone' })).toThrow('无效的 IANA 时区');
    service.updateSettings({ timezone: 'Asia/Shanghai' });
    expect(service.getSettings().timezone).toBe('Asia/Shanghai');
    expect(service.currentTime()).toContain('GMT+8');
  });

  it('calculates arithmetic and common conversions without evaluating arbitrary code', () => {
    expect(calculate('(2 + 3) * 4')).toBe('20');
    expect(calculate('1 mi to km')).toBe('1 mi = 1.609344 km');
    expect(calculate('0 c to f')).toBe('0 C = 32 F');
    expect(() => calculate('process.exit()')).toThrow();
    expect(() => calculate('1 / 0')).toThrow('有限数字');
  });

  it('fails over from the selected web search source to configured providers', async () => {
    const { db } = database();
    let calls = 0;
    const network = {
      fetch: vi.fn(async (input: string | URL | Request) => {
        calls += 1;
        const url = String(input);
        if (url.includes('exa.ai')) return response({ error: 'unavailable' }, 503);
        return response({ results: [{ title: 'Result' }] });
      }),
    } as unknown as NetworkClient;
    const service = new AssistantToolsService(db, network);
    service.updateSettings({ defaultSearch: 'exa', enabled: { exa: true, tavily: true }, keys: { exa: 'exa-test', tavily: 'tavily-test' } });
    const result = await service.search('test query');
    expect(JSON.parse(result).provider).toBe('tavily');
    expect(calls).toBe(2);
    expect(service.getSettings().configured).toEqual({ exa: true, tavily: true, firecrawl: false });
  });

  it('uses the saved city through geocoding and forecast endpoints', async () => {
    const { db } = database();
    const network = {
      fetch: vi.fn(async (input: string | URL | Request) => String(input).includes('geocoding')
        ? response({ results: [{ name: 'Shanghai', country: 'China', latitude: 31.2, longitude: 121.5 }] })
        : response({ timezone: 'Asia/Shanghai', current: { temperature_2m: 22 }, daily: { temperature_2m_max: [25] } })),
    } as unknown as NetworkClient;
    const service = new AssistantToolsService(db, network);
    service.updateSettings({ weatherCity: '上海' });
    const weather = JSON.parse(await service.weather());
    expect(weather.location).toBe('Shanghai, China');
    expect(weather.current.temperature_2m).toBe(22);
  });

  it('stores Firecrawl credentials encrypted and reports only configured state', () => {
    const { db, rows } = database();
    const service = new AssistantToolsService(db, { fetch: vi.fn() } as unknown as NetworkClient);
    const result = service.updateSettings({ keys: { firecrawl: 'fc-test-key' } });
    expect(result.configured.firecrawl).toBe(true);
    expect(result.keys.firecrawl).toBe('fc-test-key');
    expect(rows.get('assistant.tools')).not.toContain('fc-test-key');
  });

  it('requires an enabled configured source as default and excludes disabled sources from fallback', async () => {
    const { db } = database();
    const network = { fetch: vi.fn(async () => response({ results: [{ title: 'Tavily result' }] })) } as unknown as NetworkClient;
    const service = new AssistantToolsService(db, network);
    service.updateSettings({ keys: { exa: 'exa-key', tavily: 'tavily-key' }, enabled: { exa: false, tavily: true } });
    expect(service.getSettings().defaultSearch).toBe('tavily');
    expect(() => service.updateSettings({ defaultSearch: 'exa' })).toThrow('必须已配置 API Key 并处于启用状态');
    const result = JSON.parse(await service.search('hello'));
    expect(result.provider).toBe('tavily');
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(network.fetch).mock.calls[0]?.[0])).toContain('tavily.com');
  });
});
