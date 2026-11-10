import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { CompanyDatabase } from '../data/companyDatabase';
import { decryptSecret, encryptSecret } from '../models/keyCipher';
import type { NetworkClient } from '../network/networkClient';

export type SearchProvider = 'exa' | 'tavily' | 'firecrawl';
const PROVIDERS: SearchProvider[] = ['exa', 'tavily', 'firecrawl'];
const SETTINGS_KEY = 'assistant.tools';
const DEFAULT_SETTINGS: AssistantSettings = { timezone: null, weatherCity: '', defaultSearch: 'exa', enabled: { exa: false, tavily: false, firecrawl: false } };
export interface AssistantSettings { timezone: string | null; weatherCity: string; defaultSearch: SearchProvider; enabled: Record<SearchProvider, boolean> }
export interface AssistantSettingsView extends AssistantSettings {
  configured: Record<SearchProvider, boolean>;
  keys: Partial<Record<SearchProvider, string>>;
}
type Stored = { settings: AssistantSettings; keys: Partial<Record<SearchProvider, string>> };

export class AssistantToolsService {
  constructor(private readonly db: CompanyDatabase, private readonly network: NetworkClient) {}

  private stored(): Stored {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { settings: { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled } }, keys: {} };
    try {
      const value = JSON.parse(row.value) as { settings?: Partial<AssistantSettings>; keys?: Partial<Record<SearchProvider, string>> };
      const keys: Partial<Record<SearchProvider, string>> = {};
      for (const provider of PROVIDERS) {
        try { if (value.keys?.[provider]) keys[provider] = decryptSecret(Buffer.from(value.keys[provider]!, 'base64')); }
        catch { /* a missing OS keychain must not hide non-secret preferences */ }
      }
      const enabled = Object.fromEntries(PROVIDERS.map((provider) => [
        provider,
        value.settings?.enabled?.[provider] ?? Boolean(keys[provider]),
      ])) as Record<SearchProvider, boolean>;
      const defaultSearch = PROVIDERS.includes(value.settings?.defaultSearch as SearchProvider) ? value.settings!.defaultSearch! : 'exa';
      return { settings: { ...DEFAULT_SETTINGS, ...value.settings, enabled, defaultSearch }, keys };
    } catch { return { settings: { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled } }, keys: {} }; }
  }

  private save(value: Stored): void {
    const keys: Partial<Record<SearchProvider, string>> = {};
    for (const provider of PROVIDERS) if (value.keys[provider]) keys[provider] = encryptSecret(value.keys[provider]!).toString('base64');
    this.db.prepare('INSERT INTO app_setting(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(SETTINGS_KEY, JSON.stringify({ settings: value.settings, keys }), Date.now());
  }

  getSettings(): AssistantSettingsView {
    const value = this.stored();
    return {
      ...value.settings,
      configured: Object.fromEntries(PROVIDERS.map((name) => [name, Boolean(value.keys[name])])) as Record<SearchProvider, boolean>,
      keys: value.keys,
    };
  }

  updateSettings(patch: { timezone?: string | null; weatherCity?: string; defaultSearch?: SearchProvider; enabled?: Partial<Record<SearchProvider, boolean>>; keys?: Partial<Record<SearchProvider, string | null>> }): AssistantSettingsView {
    const value = this.stored();
    if (patch.timezone !== undefined) {
      if (patch.timezone !== null) { try { new Intl.DateTimeFormat('en', { timeZone: patch.timezone }); } catch { throw new Error('无效的 IANA 时区'); } }
      value.settings.timezone = patch.timezone;
    }
    if (patch.weatherCity !== undefined) value.settings.weatherCity = patch.weatherCity.trim().slice(0, 120);
    for (const provider of PROVIDERS) if (patch.keys?.[provider] !== undefined) {
      const key = patch.keys[provider]?.trim();
      if (key) value.keys[provider] = key;
    }
    for (const provider of PROVIDERS) if (patch.enabled?.[provider] !== undefined) value.settings.enabled[provider] = patch.enabled[provider]!;
    if (patch.defaultSearch !== undefined) {
      if (!PROVIDERS.includes(patch.defaultSearch)) throw new Error('未知搜索服务');
      if (!value.settings.enabled[patch.defaultSearch] || !value.keys[patch.defaultSearch]) throw new Error('默认搜索源必须已配置 API Key 并处于启用状态');
      value.settings.defaultSearch = patch.defaultSearch;
    } else if (!value.settings.enabled[value.settings.defaultSearch] || !value.keys[value.settings.defaultSearch]) {
      value.settings.defaultSearch = PROVIDERS.find((provider) => value.settings.enabled[provider] && value.keys[provider]) ?? 'exa';
    }
    this.save(value);
    return this.getSettings();
  }

  currentTime(timezone?: string): string {
    const zone = timezone?.trim() || this.stored().settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: zone }).format(new Date()); }
    catch { throw new Error(`无效的 IANA 时区：${zone}`); }
  }

  async weather(city?: string): Promise<string> {
    const name = city?.trim() || this.stored().settings.weatherCity;
    if (!name) throw new Error('请指定城市，或先在设置中配置常用城市');
    const geo = await this.json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`);
    const place = (geo.results as Array<{ name: string; country?: string; latitude: number; longitude: number }> | undefined)?.[0];
    if (!place) throw new Error(`没有找到城市：${name}`);
    const forecast = await this.json(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
    const current = forecast.current as Record<string, unknown>;
    const daily = forecast.daily as Record<string, unknown>;
    return JSON.stringify({ location: `${place.name}${place.country ? `, ${place.country}` : ''}`, timezone: forecast.timezone, current, today: daily }, null, 2);
  }

  async search(query: string, provider?: SearchProvider): Promise<string> {
    const value = this.stored();
    const preferred = provider ?? value.settings.defaultSearch;
    const order = [preferred, ...PROVIDERS.filter((item) => item !== preferred)];
    const attempts = order.filter((item) => value.settings.enabled[item] && value.keys[item]);
    if (!attempts.length) throw new Error('没有已启用的网页搜索服务，请先配置 API Key 并在设置中启用搜索源');
    const failures: string[] = [];
    for (const item of attempts) {
      try { return JSON.stringify({ provider: item, results: await this.searchWith(item, value.keys[item]!, query) }, null, 2); }
      catch (error) { failures.push(`${item}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new Error(`所有已启用搜索服务均失败：${failures.join('；')}`);
  }

  async readUrl(url: string): Promise<string> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持读取 HTTP/HTTPS 网页');
    const value = this.stored();
    const order: SearchProvider[] = [value.settings.defaultSearch, ...PROVIDERS.filter((p) => p !== value.settings.defaultSearch)];
    for (const provider of order) {
      const key = value.keys[provider]; if (!key || !value.settings.enabled[provider]) continue;
      try {
        if (provider === 'exa') {
          const data = await this.post('https://api.exa.ai/contents', { urls: [url], text: { maxCharacters: 12000 } }, { 'x-api-key': key });
          return JSON.stringify(data, null, 2);
        }
        if (provider === 'tavily') return JSON.stringify(await this.post('https://api.tavily.com/extract', { urls: [url], format: 'markdown' }, { Authorization: `Bearer ${key}` }), null, 2);
        return JSON.stringify(await this.post('https://api.firecrawl.dev/v2/scrape', { url, formats: ['markdown'] }, { Authorization: `Bearer ${key}` }), null, 2);
      } catch { /* try the next configured compatible reader */ }
    }
    throw new Error('读取网页需要配置 Exa、Tavily 或 Firecrawl API Key，且所有已配置服务均失败');
  }

  async crawlUrl(url: string, limit = 10): Promise<string> {
    new URL(url);
    const value = this.stored();
    const key = value.settings.enabled.firecrawl ? value.keys.firecrawl : undefined;
    if (!key) throw new Error('站点抓取需要配置并启用 Firecrawl');
    return JSON.stringify(await this.post('https://api.firecrawl.dev/v2/crawl', { url, limit: Math.max(1, Math.min(50, Math.floor(limit))), scrapeOptions: { formats: ['markdown'] } }, { Authorization: `Bearer ${key}` }), null, 2);
  }

  async crawlStatus(crawlId: string): Promise<string> {
    if (!/^[\w-]+$/.test(crawlId)) throw new Error('抓取任务 ID 格式非法');
    const stored = this.stored();
    const key = stored.settings.enabled.firecrawl ? stored.keys.firecrawl : undefined;
    if (!key) throw new Error('查询站点抓取状态需要配置并启用 Firecrawl');
    const response = await this.network.fetch(`https://api.firecrawl.dev/v2/crawl/${encodeURIComponent(crawlId)}`, { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' } }, { purpose: 'tool', timeoutMs: 20000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return JSON.stringify(await response.json(), null, 2);
  }

  private async searchWith(provider: SearchProvider, key: string, query: string): Promise<unknown> {
    const data = provider === 'exa'
      ? await this.post('https://api.exa.ai/search', { query, type: 'auto', numResults: 8, contents: { text: { maxCharacters: 2500 } } }, { 'x-api-key': key })
      : provider === 'tavily'
        ? await this.post('https://api.tavily.com/search', { query, search_depth: 'basic', max_results: 8, include_answer: true }, { Authorization: `Bearer ${key}` })
        : await this.post('https://api.firecrawl.dev/v2/search', { query, limit: 8 }, { Authorization: `Bearer ${key}` });
    return data;
  }

  private async json(url: string): Promise<Record<string, unknown>> {
    const response = await this.network.fetch(url, { headers: { accept: 'application/json' } }, { purpose: 'tool', timeoutMs: 15000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.network.fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, { purpose: 'tool', timeoutMs: 20000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return await response.json() as Record<string, unknown>;
  }
}

export function createAssistantToolsExtension(service: AssistantToolsService) {
  return defineExtension({ name: 'opc.assistant-tools', tools: [
    defineTool({ name: 'current_time', description: '获取当前准确日期和时间。默认使用设置的时区（或系统时区），也可传入 IANA 时区。', parameters: Type.Object({ timezone: Type.Optional(Type.String()) }), async execute(args) { return { output: [{ type: 'text', text: service.currentTime(args.timezone) }] }; } }),
    defineTool({ name: 'weather', description: '查询城市当前天气和今日预报。默认城市可在设置中配置，也可以临时指定。', parameters: Type.Object({ city: Type.Optional(Type.String()) }), async execute(args) { return { output: [{ type: 'text', text: await service.weather(args.city) }] }; } }),
    defineTool({ name: 'web_search', description: '搜索网页。默认搜索源失败时会依次尝试其他已配置服务。', parameters: Type.Object({ query: Type.String(), provider: Type.Optional(Type.Union(PROVIDERS.map((name) => Type.Literal(name)))) }), async execute(args) { return { output: [{ type: 'text', text: await service.search(args.query, args.provider) }] }; } }),
    defineTool({ name: 'web_read', description: '读取并提取指定网页的正文内容。', parameters: Type.Object({ url: Type.String() }), async execute(args) { return { output: [{ type: 'text', text: await service.readUrl(args.url) }] }; } }),
    defineTool({ name: 'web_crawl', description: '启动一个站点抓取任务，返回 Firecrawl 的任务标识和状态。', parameters: Type.Object({ url: Type.String(), limit: Type.Optional(Type.Number()) }), async execute(args) { return { output: [{ type: 'text', text: await service.crawlUrl(args.url, args.limit) }] }; } }),
    defineTool({ name: 'web_crawl_status', description: '查询站点抓取任务状态和结果。', parameters: Type.Object({ crawlId: Type.String() }), async execute(args) { return { output: [{ type: 'text', text: await service.crawlStatus(args.crawlId) }] }; } }),
    defineTool({ name: 'calculate', description: '计算安全的算术表达式或常用单位换算。', parameters: Type.Object({ expression: Type.String() }), async execute(args) { return { output: [{ type: 'text', text: calculate(args.expression) }] }; } }),
  ] });
}

export function calculate(source: string): string {
  const input = source.trim();
  if (input.length > 200) throw new Error('表达式过长（最多 200 个字符）');
  const conversion = input.match(/^\s*(-?\d+(?:\.\d+)?)\s*(km|m|cm|mm|mi|kg|g|lb|c|f)\s*(?:to|->|转)\s*(km|m|cm|mm|mi|kg|g|lb|c|f)\s*$/i);
  if (conversion) {
    const n = Number(conversion[1]); const from = conversion[2]!.toLowerCase(); const to = conversion[3]!.toLowerCase();
    const groups: Record<string, Record<string, number>> = {
      length: { km: 1000, m: 1, cm: .01, mm: .001, mi: 1609.344 }, mass: { kg: 1, g: .001, lb: .45359237 },
    };
    for (const group of Object.values(groups)) if (group[from] && group[to]) return `${n} ${from} = ${n * group[from]! / group[to]!} ${to}`;
    if (from === 'c' && to === 'f') return `${n} C = ${n * 9 / 5 + 32} F`;
    if (from === 'f' && to === 'c') return `${n} F = ${(n - 32) * 5 / 9} C`;
    throw new Error('不支持该单位换算');
  }
  if (!/^[\d\s()+\-*/%.]+$/.test(input) || !/\d/.test(input)) throw new Error('只支持数字与 + - * / % 括号运算，或 km/m/cm/mm/mi、kg/g/lb、C/F 换算');
  const result = Function(`"use strict"; return (${input})`)() as number;
  if (!Number.isFinite(result)) throw new Error('计算结果不是有限数字');
  return String(result);
}
