import { useSyncExternalStore } from 'react';
import { AuthMode, PiProvider, ThinkingLevel } from './piCatalog';

export const STORAGE_KEY = 'opc.settings.v1';

export interface ProviderPrefs {
  authMode?: AuthMode;
  /** Regional provider ID (e.g. `moonshotai-cn`) for providers that ship regional variants. */
  region?: string;
  /** Base URL override, written to pi `models.json` → `providers.<id>.baseUrl`. */
  baseUrl?: string;
  /** Non-secret environment values such as project, region or resource name. */
  fields?: Record<string, string>;
}

export interface SettingsPrefs {
  // 通用 · 外观与语言
  theme: 'system' | 'light' | 'dark';
  textSize: 'small' | 'standard' | 'large';
  language: 'zh-CN' | 'zh-TW' | 'en-US';
  timeFormat: '24h' | '12h';
  // 通用 · 通知
  desktopNotify: boolean;
  notifySound: boolean;
  notifyPreview: boolean;
  notifyMentionOnly: boolean;
  notifyTaskDone: boolean;
  dndEnabled: boolean;
  dndStart: string;
  dndEnd: string;
  // 通用 · 工作区与会话（pi settings.json）
  sendShortcut: 'enter' | 'mod-enter';
  steeringMode: 'one-at-a-time' | 'all';
  followUpMode: 'one-at-a-time' | 'all';
  defaultProjectTrust: 'ask' | 'always' | 'never';
  compactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  sessionDir: string;
  sessionShareDestination: 'auto' | 'gist' | 'radius';
  // 通用 · 网络与隐私（pi settings.json）
  transport: 'auto' | 'sse' | 'websocket' | 'websocket-cached';
  httpProxy: string;
  httpIdleTimeoutMs: number;
  websocketConnectTimeoutMs: number;
  retryEnabled: boolean;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  retryMaxAgentDelayMs: number;
  enableInstallTelemetry: boolean;
  enableAnalytics: boolean;
  // 模型 · LLM（empty provider/model = pi "Automatic"）
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  hideThinkingBlock: boolean;
  providers: Record<string, ProviderPrefs>;
  // 模型 · Image
  imageModel: string;
  imagesAutoResize: boolean;
  imagesBlockImages: boolean;
}

/** Defaults mirror the documented pi defaults where a matching pi setting exists. */
export const DEFAULT_PREFS: SettingsPrefs = {
  theme: 'system',
  textSize: 'standard',
  language: 'zh-CN',
  timeFormat: '24h',
  desktopNotify: true,
  notifySound: true,
  notifyPreview: true,
  notifyMentionOnly: false,
  notifyTaskDone: true,
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '08:00',
  sendShortcut: 'enter',
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  defaultProjectTrust: 'ask',
  compactionEnabled: true,
  compactionReserveTokens: 16384,
  compactionKeepRecentTokens: 20000,
  sessionDir: '',
  sessionShareDestination: 'auto',
  transport: 'auto',
  httpProxy: '',
  httpIdleTimeoutMs: 300000,
  websocketConnectTimeoutMs: 15000,
  retryEnabled: true,
  retryMaxRetries: 3,
  retryBaseDelayMs: 2000,
  retryMaxAgentDelayMs: 60000,
  enableInstallTelemetry: true,
  enableAnalytics: false,
  defaultProvider: '',
  defaultModel: '',
  defaultThinkingLevel: 'medium',
  hideThinkingBlock: false,
  providers: {},
  imageModel: '',
  imagesAutoResize: true,
  imagesBlockImages: false,
};

interface Snapshot {
  prefs: SettingsPrefs;
  /** Secrets live in memory only and are never written to browser storage. */
  credentials: Record<string, string>;
  savedAt: number | null;
  persistent: boolean;
}

const loadPrefs = (): { prefs: SettingsPrefs; persistent: boolean } => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { prefs: DEFAULT_PREFS, persistent: true };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prefs = { ...DEFAULT_PREFS } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_PREFS)) {
      const fallback = prefs[key];
      const value = parsed[key];
      // Ignore stale or malformed values so a bad entry can never break the page.
      if (value !== undefined && typeof value === typeof fallback && value !== null) {
        prefs[key] = value;
      }
    }
    return { prefs: prefs as unknown as SettingsPrefs, persistent: true };
  } catch {
    return { prefs: DEFAULT_PREFS, persistent: false };
  }
};

const initial = loadPrefs();
let snapshot: Snapshot = {
  prefs: initial.prefs,
  credentials: {},
  savedAt: null,
  persistent: initial.persistent,
};
const listeners = new Set<() => void>();

const commit = (next: Partial<Snapshot>, persist: boolean) => {
  snapshot = { ...snapshot, ...next };
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.prefs));
      snapshot = { ...snapshot, savedAt: Date.now(), persistent: true };
    } catch {
      snapshot = { ...snapshot, persistent: false };
    }
  }
  listeners.forEach((listener) => listener());
};

export const settingsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  set<K extends keyof SettingsPrefs>(key: K, value: SettingsPrefs[K]) {
    commit({ prefs: { ...snapshot.prefs, [key]: value } }, true);
  },
  patch(partial: Partial<SettingsPrefs>) {
    commit({ prefs: { ...snapshot.prefs, ...partial } }, true);
  },
  updateProvider(providerId: string, partial: ProviderPrefs) {
    const current = snapshot.prefs.providers[providerId] ?? {};
    const merged: ProviderPrefs = {
      ...current,
      ...partial,
      fields: partial.fields ? { ...current.fields, ...partial.fields } : current.fields,
    };
    commit(
      { prefs: { ...snapshot.prefs, providers: { ...snapshot.prefs.providers, [providerId]: merged } } },
      true
    );
  },
  setCredential(providerId: string, value: string) {
    commit({ credentials: { ...snapshot.credentials, [providerId]: value } }, false);
  },
  resetAll() {
    commit({ prefs: DEFAULT_PREFS, credentials: {} }, true);
  },
};

export const useSettings = () =>
  useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

export type StatusTone = 'green' | 'blue' | 'amber' | 'red' | 'gray';

export interface ProviderStatus {
  tone: StatusTone;
  label: string;
  /** Credentials (or ambient settings) are present; nothing has been verified remotely. */
  ready: boolean;
}

export const activeAuthMode = (provider: PiProvider, prefs?: ProviderPrefs): AuthMode =>
  prefs?.authMode && provider.auth.includes(prefs.authMode) ? prefs.authMode : provider.auth[0];

export const activeRegion = (provider: PiProvider, prefs?: ProviderPrefs) =>
  provider.regions?.find((r) => r.id === prefs?.region) ?? provider.regions?.[0];

/** The provider ID pi actually uses, accounting for regional variants. */
export const effectiveProviderId = (provider: PiProvider, prefs?: ProviderPrefs) =>
  activeRegion(provider, prefs)?.id ?? provider.id;

export const defaultBaseUrl = (provider: PiProvider, prefs?: ProviderPrefs) =>
  activeRegion(provider, prefs)?.baseUrl ?? provider.baseUrl;

export const credentialEnv = (provider: PiProvider, prefs?: ProviderPrefs) =>
  activeRegion(provider, prefs)?.envVar ?? provider.envVars[0];

export const getProviderStatus = (
  provider: PiProvider,
  prefs: SettingsPrefs,
  credentials: Record<string, string>
): ProviderStatus => {
  const providerPrefs = prefs.providers[provider.id];
  const mode = activeAuthMode(provider, providerPrefs);
  const fieldValue = (env: string) => providerPrefs?.fields?.[env]?.trim();

  if (mode === 'oauth') return { tone: 'gray', label: '待登录', ready: false };
  if (mode === 'ambient') {
    const missing = provider.fields?.some((f) => f.required && !fieldValue(f.env));
    return missing
      ? { tone: 'amber', label: '待配置', ready: false }
      : { tone: 'gray', label: '未检查', ready: true };
  }
  if (!credentials[effectiveProviderId(provider, providerPrefs)]?.trim()) {
    return { tone: 'amber', label: '待配置', ready: false };
  }
  if (
    provider.id === 'azure' &&
    !fieldValue('AZURE_OPENAI_RESOURCE_NAME') &&
    !providerPrefs?.baseUrl?.trim()
  ) {
    return { tone: 'amber', label: '缺少资源名称', ready: false };
  }
  return { tone: 'blue', label: '已填写 · 未验证', ready: true };
};

/** Validates an optional proxy URL; returns an error message or null. */
export const validateProxy = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
      return '仅支持 http、https 或 socks5 协议';
    }
    return null;
  } catch {
    return '不是有效的 URL，例如 http://127.0.0.1:7890';
  }
};
