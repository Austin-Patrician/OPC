import type Database from 'better-sqlite3';
import type {
  ChannelAccessConfig,
  ChannelPairingRequest,
  ChannelTargetView,
  DingTalkChannelSettingsPatch,
  DingTalkChannelSettingsView,
  FeishuChannelSettingsPatch,
  FeishuChannelSettingsView,
  FeishuDomain,
  GitHubChannelSettingsPatch,
  GitHubChannelSettingsView,
  GitHubEventToggles,
  SlackChannelSettingsPatch,
  SlackChannelSettingsView,
  TelegramChannelSettingsPatch,
  TelegramChannelSettingsView,
  WeComChannelSettingsPatch,
  WeComChannelSettingsView,
} from '@opc/shared/domain';
import { decryptSecret, encryptSecret } from '../models/keyCipher';

const FEISHU_CONFIG_KEY = 'channels.feishu.config';
const FEISHU_SECRET_KEY = 'channels.feishu.secret';
const DINGTALK_CONFIG_KEY = 'channels.dingtalk.config';
const DINGTALK_SECRET_KEY = 'channels.dingtalk.secret';
const SLACK_CONFIG_KEY = 'channels.slack.config';
const SLACK_BOT_TOKEN_KEY = 'channels.slack.botToken';
const SLACK_APP_TOKEN_KEY = 'channels.slack.appToken';
const WECOM_CONFIG_KEY = 'channels.wecom.config';
const WECOM_SECRET_KEY = 'channels.wecom.secret';
const TELEGRAM_CONFIG_KEY = 'channels.telegram.config';
const TELEGRAM_BOT_TOKEN_KEY = 'channels.telegram.botToken';
const GITHUB_CONFIG_KEY = 'channels.github.config';
const GITHUB_TOKEN_KEY = 'channels.github.token';
const GITHUB_NOTIFICATIONS_TOKEN_KEY = 'channels.github.notificationsToken';
const PAIRINGS_KEY = 'channels.pairings';
const TARGETS_KEY = 'channels.targets';
const MAX_PAIRINGS = 50;
const MAX_TARGETS = 100;

export interface FeishuInternalConfig extends FeishuChannelSettingsView {
  appSecret: string;
}

export interface DingTalkInternalConfig extends DingTalkChannelSettingsView {
  clientSecret: string;
}

export interface SlackInternalConfig extends SlackChannelSettingsView {
  botToken: string;
  appToken: string;
}

export interface WeComInternalConfig extends WeComChannelSettingsView {
  secret: string;
}

export interface TelegramInternalConfig extends TelegramChannelSettingsView {
  botToken: string;
}

export interface GitHubInternalConfig extends GitHubChannelSettingsView {
  token: string;
  notificationsToken: string;
}

interface StoredFeishuConfig {
  enabled?: boolean;
  domain?: FeishuDomain;
  appId?: string;
  mirrorToDesktop?: boolean;
  thinkingReaction?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

interface StoredDingTalkConfig {
  enabled?: boolean;
  clientId?: string;
  robotCode?: string;
  mirrorToDesktop?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

interface StoredSlackConfig {
  enabled?: boolean;
  mirrorToDesktop?: boolean;
  thinkingReaction?: boolean;
  replyInThread?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

interface StoredWeComConfig {
  enabled?: boolean;
  botId?: string;
  mirrorToDesktop?: boolean;
  thinkingStream?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

interface StoredTelegramConfig {
  enabled?: boolean;
  apiBaseUrl?: string;
  mirrorToDesktop?: boolean;
  typingAction?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

interface StoredGitHubConfig {
  enabled?: boolean;
  apiBaseUrl?: string;
  pollIntervalSec?: number;
  watchRepos?: string[];
  events?: Partial<GitHubEventToggles>;
  wakeWord?: string;
  autoReplyToGitHub?: boolean;
  thinkingReaction?: boolean;
  mirrorToDesktop?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

const DEFAULT_ACCESS: ChannelAccessConfig = {
  dmPolicy: 'pairing',
  dmAllowlist: [],
  groupPolicy: 'mention',
  groupAllowlist: [],
};

const DEFAULT_GITHUB_EVENTS: GitHubEventToggles = {
  mention: true,
  reviewRequested: true,
  assigned: true,
  repoActivity: false,
};

function sanitizeWatchRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
    if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(cleaned)) {
      unique.add(cleaned);
    }
  }
  return [...unique];
}

function clampPollIntervalSec(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 60;
  return Math.min(600, Math.max(30, Math.round(raw)));
}

const DEFAULT_FEISHU_CONFIG: Omit<FeishuInternalConfig, 'hasAppSecret' | 'appSecret'> = {
  enabled: false,
  domain: 'feishu',
  appId: '',
  mirrorToDesktop: true,
  thinkingReaction: true,
  access: DEFAULT_ACCESS,
};

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique];
}

function normalizeAccess(raw?: Partial<ChannelAccessConfig>): ChannelAccessConfig {
  const dmPolicy =
    raw?.dmPolicy === 'pairing' || raw?.dmPolicy === 'allowlist' || raw?.dmPolicy === 'open'
      ? raw.dmPolicy
      : DEFAULT_ACCESS.dmPolicy;
  const groupPolicy =
    raw?.groupPolicy === 'mention' ||
    raw?.groupPolicy === 'allowlist' ||
    raw?.groupPolicy === 'open' ||
    raw?.groupPolicy === 'disabled'
      ? raw.groupPolicy
      : DEFAULT_ACCESS.groupPolicy;
  return {
    dmPolicy,
    dmAllowlist: sanitizeStringArray(raw?.dmAllowlist),
    groupPolicy,
    groupAllowlist: sanitizeStringArray(raw?.groupAllowlist),
  };
}

export interface SecretCipher {
  encrypt(plain: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/**
 * Persistence layer for external channel configuration, OS-keychain encrypted
 * secrets, pending DM pairing requests, and recent external chat targets.
 */
export class ChannelStore {
  private readonly cipher: SecretCipher;

  constructor(
    private readonly db: Database.Database,
    cipher?: SecretCipher,
  ) {
    this.cipher = cipher ?? { encrypt: encryptSecret, decrypt: decryptSecret };
  }

  private readSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private writeSetting(key: string, value: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  private readJson<T>(key: string, fallback: T): T {
    const raw = this.readSetting(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private readFeishuSecret(): string {
    const encoded = this.readSetting(FEISHU_SECRET_KEY);
    if (!encoded) return '';
    try {
      return this.cipher.decrypt(Buffer.from(encoded, 'base64'));
    } catch {
      return '';
    }
  }

  private writeFeishuSecret(plain: string): void {
    const trimmed = plain.trim();
    if (!trimmed) {
      this.db.prepare('DELETE FROM app_setting WHERE key = ?').run(FEISHU_SECRET_KEY);
      return;
    }
    const encrypted = this.cipher.encrypt(trimmed);
    this.writeSetting(FEISHU_SECRET_KEY, encrypted.toString('base64'));
  }

  getFeishuConfig(): FeishuInternalConfig {
    const stored = this.readJson<StoredFeishuConfig>(FEISHU_CONFIG_KEY, {});
    const appSecret = this.readFeishuSecret();
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_FEISHU_CONFIG.enabled,
      domain: stored.domain === 'lark' ? 'lark' : 'feishu',
      appId: typeof stored.appId === 'string' ? stored.appId.trim() : '',
      hasAppSecret: appSecret.length > 0,
      appSecret,
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean'
          ? stored.mirrorToDesktop
          : DEFAULT_FEISHU_CONFIG.mirrorToDesktop,
      thinkingReaction:
        typeof stored.thinkingReaction === 'boolean'
          ? stored.thinkingReaction
          : DEFAULT_FEISHU_CONFIG.thinkingReaction,
      access: normalizeAccess(stored.access),
    };
  }

  getFeishuSettingsView(): FeishuChannelSettingsView {
    const full = this.getFeishuConfig();
    return {
      enabled: full.enabled,
      domain: full.domain,
      appId: full.appId,
      hasAppSecret: full.hasAppSecret,
      mirrorToDesktop: full.mirrorToDesktop,
      thinkingReaction: full.thinkingReaction,
      access: full.access,
    };
  }

  /** Returns true if connection-affecting credentials or enabled toggle changed. */
  updateFeishuConfig(patch: FeishuChannelSettingsPatch): { connectionChanged: boolean } {
    const current = this.getFeishuConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextDomain: FeishuDomain =
      patch.domain === 'lark' || patch.domain === 'feishu' ? patch.domain : current.domain;
    const nextAppId = typeof patch.appId === 'string' ? patch.appId.trim() : current.appId;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextThinking =
      typeof patch.thinkingReaction === 'boolean'
        ? patch.thinkingReaction
        : current.thinkingReaction;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let secretChanged = false;
    if (patch.appSecret !== undefined) {
      const nextSecret = patch.appSecret.trim();
      secretChanged = nextSecret !== current.appSecret;
      this.writeFeishuSecret(nextSecret);
    }

    const storedPayload: StoredFeishuConfig = {
      enabled: nextEnabled,
      domain: nextDomain,
      appId: nextAppId,
      mirrorToDesktop: nextMirror,
      thinkingReaction: nextThinking,
      access: nextAccess,
    };
    this.writeSetting(FEISHU_CONFIG_KEY, JSON.stringify(storedPayload));

    const connectionChanged =
      nextEnabled !== current.enabled ||
      nextDomain !== current.domain ||
      nextAppId !== current.appId ||
      secretChanged;

    return { connectionChanged };
  }

  private readEncryptedSecret(settingKey: string): string {
    const encoded = this.readSetting(settingKey);
    if (!encoded) return '';
    try {
      return this.cipher.decrypt(Buffer.from(encoded, 'base64'));
    } catch {
      return '';
    }
  }

  private writeEncryptedSecret(settingKey: string, plain: string): void {
    const trimmed = plain.trim();
    if (!trimmed) {
      this.db.prepare('DELETE FROM app_setting WHERE key = ?').run(settingKey);
      return;
    }
    const encrypted = this.cipher.encrypt(trimmed);
    this.writeSetting(settingKey, encrypted.toString('base64'));
  }

  getDingTalkConfig(): DingTalkInternalConfig {
    const stored = this.readJson<StoredDingTalkConfig>(DINGTALK_CONFIG_KEY, {});
    const clientSecret = this.readEncryptedSecret(DINGTALK_SECRET_KEY);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
      clientId: typeof stored.clientId === 'string' ? stored.clientId.trim() : '',
      hasClientSecret: clientSecret.length > 0,
      clientSecret,
      robotCode: typeof stored.robotCode === 'string' ? stored.robotCode.trim() : '',
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean' ? stored.mirrorToDesktop : true,
      access: normalizeAccess(stored.access),
    };
  }

  getDingTalkSettingsView(): DingTalkChannelSettingsView {
    const full = this.getDingTalkConfig();
    return {
      enabled: full.enabled,
      clientId: full.clientId,
      hasClientSecret: full.hasClientSecret,
      robotCode: full.robotCode,
      mirrorToDesktop: full.mirrorToDesktop,
      access: full.access,
    };
  }

  updateDingTalkConfig(patch: DingTalkChannelSettingsPatch): { connectionChanged: boolean } {
    const current = this.getDingTalkConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextClientId =
      typeof patch.clientId === 'string' ? patch.clientId.trim() : current.clientId;
    const nextRobotCode =
      typeof patch.robotCode === 'string' ? patch.robotCode.trim() : current.robotCode;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let secretChanged = false;
    if (patch.clientSecret !== undefined) {
      const nextSecret = patch.clientSecret.trim();
      secretChanged = nextSecret !== current.clientSecret;
      this.writeEncryptedSecret(DINGTALK_SECRET_KEY, nextSecret);
    }

    const storedPayload: StoredDingTalkConfig = {
      enabled: nextEnabled,
      clientId: nextClientId,
      robotCode: nextRobotCode,
      mirrorToDesktop: nextMirror,
      access: nextAccess,
    };
    this.writeSetting(DINGTALK_CONFIG_KEY, JSON.stringify(storedPayload));

    const connectionChanged =
      nextEnabled !== current.enabled ||
      nextClientId !== current.clientId ||
      nextRobotCode !== current.robotCode ||
      secretChanged;

    return { connectionChanged };
  }

  getSlackConfig(): SlackInternalConfig {
    const stored = this.readJson<StoredSlackConfig>(SLACK_CONFIG_KEY, {});
    const botToken = this.readEncryptedSecret(SLACK_BOT_TOKEN_KEY);
    const appToken = this.readEncryptedSecret(SLACK_APP_TOKEN_KEY);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
      hasBotToken: botToken.length > 0,
      hasAppToken: appToken.length > 0,
      botToken,
      appToken,
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean' ? stored.mirrorToDesktop : true,
      thinkingReaction:
        typeof stored.thinkingReaction === 'boolean' ? stored.thinkingReaction : true,
      replyInThread:
        typeof stored.replyInThread === 'boolean' ? stored.replyInThread : true,
      access: normalizeAccess(stored.access),
    };
  }

  getSlackSettingsView(): SlackChannelSettingsView {
    const full = this.getSlackConfig();
    return {
      enabled: full.enabled,
      hasBotToken: full.hasBotToken,
      hasAppToken: full.hasAppToken,
      mirrorToDesktop: full.mirrorToDesktop,
      thinkingReaction: full.thinkingReaction,
      replyInThread: full.replyInThread,
      access: full.access,
    };
  }

  updateSlackConfig(patch: SlackChannelSettingsPatch): { connectionChanged: boolean } {
    const current = this.getSlackConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextThinking =
      typeof patch.thinkingReaction === 'boolean'
        ? patch.thinkingReaction
        : current.thinkingReaction;
    const nextReplyInThread =
      typeof patch.replyInThread === 'boolean'
        ? patch.replyInThread
        : current.replyInThread;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let tokenChanged = false;
    if (patch.botToken !== undefined) {
      const nextBotToken = patch.botToken.trim();
      tokenChanged = tokenChanged || nextBotToken !== current.botToken;
      this.writeEncryptedSecret(SLACK_BOT_TOKEN_KEY, nextBotToken);
    }
    if (patch.appToken !== undefined) {
      const nextAppToken = patch.appToken.trim();
      tokenChanged = tokenChanged || nextAppToken !== current.appToken;
      this.writeEncryptedSecret(SLACK_APP_TOKEN_KEY, nextAppToken);
    }

    const storedPayload: StoredSlackConfig = {
      enabled: nextEnabled,
      mirrorToDesktop: nextMirror,
      thinkingReaction: nextThinking,
      replyInThread: nextReplyInThread,
      access: nextAccess,
    };
    this.writeSetting(SLACK_CONFIG_KEY, JSON.stringify(storedPayload));

    return {
      connectionChanged: nextEnabled !== current.enabled || tokenChanged,
    };
  }

  getWeComConfig(): WeComInternalConfig {
    const stored = this.readJson<StoredWeComConfig>(WECOM_CONFIG_KEY, {});
    const secret = this.readEncryptedSecret(WECOM_SECRET_KEY);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
      botId: typeof stored.botId === 'string' ? stored.botId.trim() : '',
      hasSecret: secret.length > 0,
      secret,
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean' ? stored.mirrorToDesktop : true,
      thinkingStream:
        typeof stored.thinkingStream === 'boolean' ? stored.thinkingStream : true,
      access: normalizeAccess(stored.access),
    };
  }

  getWeComSettingsView(): WeComChannelSettingsView {
    const full = this.getWeComConfig();
    return {
      enabled: full.enabled,
      botId: full.botId,
      hasSecret: full.hasSecret,
      mirrorToDesktop: full.mirrorToDesktop,
      thinkingStream: full.thinkingStream,
      access: full.access,
    };
  }

  updateWeComConfig(patch: WeComChannelSettingsPatch): { connectionChanged: boolean } {
    const current = this.getWeComConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextBotId = typeof patch.botId === 'string' ? patch.botId.trim() : current.botId;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextThinkingStream =
      typeof patch.thinkingStream === 'boolean'
        ? patch.thinkingStream
        : current.thinkingStream;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let secretChanged = false;
    if (patch.secret !== undefined) {
      const nextSecret = patch.secret.trim();
      secretChanged = nextSecret !== current.secret;
      this.writeEncryptedSecret(WECOM_SECRET_KEY, nextSecret);
    }

    const storedPayload: StoredWeComConfig = {
      enabled: nextEnabled,
      botId: nextBotId,
      mirrorToDesktop: nextMirror,
      thinkingStream: nextThinkingStream,
      access: nextAccess,
    };
    this.writeSetting(WECOM_CONFIG_KEY, JSON.stringify(storedPayload));

    return {
      connectionChanged:
        nextEnabled !== current.enabled || nextBotId !== current.botId || secretChanged,
    };
  }

  getTelegramConfig(): TelegramInternalConfig {
    const stored = this.readJson<StoredTelegramConfig>(TELEGRAM_CONFIG_KEY, {});
    const botToken = this.readEncryptedSecret(TELEGRAM_BOT_TOKEN_KEY);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
      hasBotToken: botToken.length > 0,
      botToken,
      apiBaseUrl:
        typeof stored.apiBaseUrl === 'string'
          ? stored.apiBaseUrl.trim().replace(/\/+$/, '')
          : '',
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean' ? stored.mirrorToDesktop : true,
      typingAction:
        typeof stored.typingAction === 'boolean' ? stored.typingAction : true,
      access: normalizeAccess(stored.access),
    };
  }

  getTelegramSettingsView(): TelegramChannelSettingsView {
    const full = this.getTelegramConfig();
    return {
      enabled: full.enabled,
      hasBotToken: full.hasBotToken,
      apiBaseUrl: full.apiBaseUrl,
      mirrorToDesktop: full.mirrorToDesktop,
      typingAction: full.typingAction,
      access: full.access,
    };
  }

  updateTelegramConfig(patch: TelegramChannelSettingsPatch): { connectionChanged: boolean } {
    const current = this.getTelegramConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextApiBaseUrl =
      typeof patch.apiBaseUrl === 'string'
        ? patch.apiBaseUrl.trim().replace(/\/+$/, '')
        : current.apiBaseUrl;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextTyping =
      typeof patch.typingAction === 'boolean' ? patch.typingAction : current.typingAction;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let tokenChanged = false;
    if (patch.botToken !== undefined) {
      const nextToken = patch.botToken.trim();
      tokenChanged = nextToken !== current.botToken;
      this.writeEncryptedSecret(TELEGRAM_BOT_TOKEN_KEY, nextToken);
    }

    const storedPayload: StoredTelegramConfig = {
      enabled: nextEnabled,
      apiBaseUrl: nextApiBaseUrl,
      mirrorToDesktop: nextMirror,
      typingAction: nextTyping,
      access: nextAccess,
    };
    this.writeSetting(TELEGRAM_CONFIG_KEY, JSON.stringify(storedPayload));

    return {
      connectionChanged:
        nextEnabled !== current.enabled ||
        nextApiBaseUrl !== current.apiBaseUrl ||
        tokenChanged,
    };
  }

  getGitHubConfig(): GitHubInternalConfig {
    const stored = this.readJson<StoredGitHubConfig>(GITHUB_CONFIG_KEY, {});
    const token = this.readEncryptedSecret(GITHUB_TOKEN_KEY);
    const notificationsToken = this.readEncryptedSecret(GITHUB_NOTIFICATIONS_TOKEN_KEY);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
      hasToken: token.length > 0,
      hasNotificationsToken: notificationsToken.length > 0,
      token,
      notificationsToken,
      apiBaseUrl:
        typeof stored.apiBaseUrl === 'string'
          ? stored.apiBaseUrl.trim().replace(/\/+$/, '')
          : '',
      pollIntervalSec: clampPollIntervalSec(stored.pollIntervalSec),
      watchRepos: sanitizeWatchRepos(stored.watchRepos),
      events: {
        mention:
          typeof stored.events?.mention === 'boolean'
            ? stored.events.mention
            : DEFAULT_GITHUB_EVENTS.mention,
        reviewRequested:
          typeof stored.events?.reviewRequested === 'boolean'
            ? stored.events.reviewRequested
            : DEFAULT_GITHUB_EVENTS.reviewRequested,
        assigned:
          typeof stored.events?.assigned === 'boolean'
            ? stored.events.assigned
            : DEFAULT_GITHUB_EVENTS.assigned,
        repoActivity:
          typeof stored.events?.repoActivity === 'boolean'
            ? stored.events.repoActivity
            : DEFAULT_GITHUB_EVENTS.repoActivity,
      },
      wakeWord:
        typeof stored.wakeWord === 'string' && stored.wakeWord.trim()
          ? stored.wakeWord.trim()
          : '/buddy',
      autoReplyToGitHub:
        typeof stored.autoReplyToGitHub === 'boolean' ? stored.autoReplyToGitHub : true,
      thinkingReaction:
        typeof stored.thinkingReaction === 'boolean' ? stored.thinkingReaction : true,
      mirrorToDesktop:
        typeof stored.mirrorToDesktop === 'boolean' ? stored.mirrorToDesktop : true,
      access: normalizeAccess(stored.access),
    };
  }

  getGitHubSettingsView(): GitHubChannelSettingsView {
    const full = this.getGitHubConfig();
    return {
      enabled: full.enabled,
      hasToken: full.hasToken,
      hasNotificationsToken: full.hasNotificationsToken,
      apiBaseUrl: full.apiBaseUrl,
      pollIntervalSec: full.pollIntervalSec,
      watchRepos: full.watchRepos,
      events: full.events,
      wakeWord: full.wakeWord,
      autoReplyToGitHub: full.autoReplyToGitHub,
      thinkingReaction: full.thinkingReaction,
      mirrorToDesktop: full.mirrorToDesktop,
      access: full.access,
    };
  }

  updateGitHubConfig(patch: GitHubChannelSettingsPatch): {
    connectionChanged: boolean;
    watchReposChanged: boolean;
  } {
    const current = this.getGitHubConfig();
    const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextApiBaseUrl =
      typeof patch.apiBaseUrl === 'string'
        ? patch.apiBaseUrl.trim().replace(/\/+$/, '')
        : current.apiBaseUrl;
    const nextPollIntervalSec =
      patch.pollIntervalSec !== undefined
        ? clampPollIntervalSec(patch.pollIntervalSec)
        : current.pollIntervalSec;
    const nextWatchRepos =
      patch.watchRepos !== undefined ? sanitizeWatchRepos(patch.watchRepos) : current.watchRepos;
    const nextEvents: GitHubEventToggles = {
      mention:
        typeof patch.events?.mention === 'boolean'
          ? patch.events.mention
          : current.events.mention,
      reviewRequested:
        typeof patch.events?.reviewRequested === 'boolean'
          ? patch.events.reviewRequested
          : current.events.reviewRequested,
      assigned:
        typeof patch.events?.assigned === 'boolean'
          ? patch.events.assigned
          : current.events.assigned,
      repoActivity:
        typeof patch.events?.repoActivity === 'boolean'
          ? patch.events.repoActivity
          : current.events.repoActivity,
    };
    const nextWakeWord =
      typeof patch.wakeWord === 'string'
        ? patch.wakeWord.trim() || '/buddy'
        : current.wakeWord;
    const nextAutoReply =
      typeof patch.autoReplyToGitHub === 'boolean'
        ? patch.autoReplyToGitHub
        : current.autoReplyToGitHub;
    const nextThinking =
      typeof patch.thinkingReaction === 'boolean'
        ? patch.thinkingReaction
        : current.thinkingReaction;
    const nextMirror =
      typeof patch.mirrorToDesktop === 'boolean'
        ? patch.mirrorToDesktop
        : current.mirrorToDesktop;
    const nextAccess = normalizeAccess({
      ...current.access,
      ...(patch.access ?? {}),
    });

    let tokenChanged = false;
    if (patch.token !== undefined) {
      const nextToken = patch.token.trim();
      tokenChanged = nextToken !== current.token;
      this.writeEncryptedSecret(GITHUB_TOKEN_KEY, nextToken);
    }

    let notificationsTokenChanged = false;
    if (patch.notificationsToken !== undefined) {
      const nextNotificationsToken = patch.notificationsToken.trim();
      notificationsTokenChanged = nextNotificationsToken !== current.notificationsToken;
      this.writeEncryptedSecret(GITHUB_NOTIFICATIONS_TOKEN_KEY, nextNotificationsToken);
    }

    const storedPayload: StoredGitHubConfig = {
      enabled: nextEnabled,
      apiBaseUrl: nextApiBaseUrl,
      pollIntervalSec: nextPollIntervalSec,
      watchRepos: nextWatchRepos,
      events: nextEvents,
      wakeWord: nextWakeWord,
      autoReplyToGitHub: nextAutoReply,
      thinkingReaction: nextThinking,
      mirrorToDesktop: nextMirror,
      access: nextAccess,
    };
    this.writeSetting(GITHUB_CONFIG_KEY, JSON.stringify(storedPayload));

    return {
      connectionChanged:
        nextEnabled !== current.enabled ||
        nextApiBaseUrl !== current.apiBaseUrl ||
        nextPollIntervalSec !== current.pollIntervalSec ||
        tokenChanged ||
        notificationsTokenChanged,
      watchReposChanged:
        JSON.stringify(nextWatchRepos) !== JSON.stringify(current.watchRepos),
    };
  }

  listPairings(channelId?: string): ChannelPairingRequest[] {
    const all = this.readJson<ChannelPairingRequest[]>(PAIRINGS_KEY, []);
    const filtered = channelId ? all.filter((item) => item.channelId === channelId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Inserts or refreshes a pairing request for `(channelId, senderId)`. Returns `isNew`. */
  upsertPairing(request: ChannelPairingRequest): {
    request: ChannelPairingRequest;
    isNew: boolean;
  } {
    const all = this.readJson<ChannelPairingRequest[]>(PAIRINGS_KEY, []);
    const existing = all.find(
      (item) => item.channelId === request.channelId && item.senderId === request.senderId,
    );
    if (existing) {
      const updated: ChannelPairingRequest = {
        ...existing,
        senderName: request.senderName || existing.senderName,
        chatId: request.chatId,
        firstMessagePreview: request.firstMessagePreview || existing.firstMessagePreview,
        createdAt: request.createdAt,
      };
      const next = [updated, ...all.filter((item) => item.id !== existing.id)].slice(
        0,
        MAX_PAIRINGS,
      );
      this.writeSetting(PAIRINGS_KEY, JSON.stringify(next));
      return { request: updated, isNew: false };
    }

    const next = [request, ...all].slice(0, MAX_PAIRINGS);
    this.writeSetting(PAIRINGS_KEY, JSON.stringify(next));
    return { request, isNew: true };
  }

  approvePairing(requestId: string): ChannelPairingRequest | null {
    const all = this.readJson<ChannelPairingRequest[]>(PAIRINGS_KEY, []);
    const target = all.find((item) => item.id === requestId);
    if (!target) return null;

    this.writeSetting(PAIRINGS_KEY, JSON.stringify(all.filter((item) => item.id !== requestId)));
    if (target.channelId === 'feishu') {
      const config = this.getFeishuConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateFeishuConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    } else if (target.channelId === 'dingtalk') {
      const config = this.getDingTalkConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateDingTalkConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    } else if (target.channelId === 'slack') {
      const config = this.getSlackConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateSlackConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    } else if (target.channelId === 'wecom') {
      const config = this.getWeComConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateWeComConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    } else if (target.channelId === 'telegram') {
      const config = this.getTelegramConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateTelegramConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    } else if (target.channelId === 'github') {
      const config = this.getGitHubConfig();
      if (!config.access.dmAllowlist.includes(target.senderId)) {
        this.updateGitHubConfig({
          access: {
            dmAllowlist: [...config.access.dmAllowlist, target.senderId],
          },
        });
      }
    }
    return target;
  }

  rejectPairing(requestId: string): boolean {
    const all = this.readJson<ChannelPairingRequest[]>(PAIRINGS_KEY, []);
    const next = all.filter((item) => item.id !== requestId);
    if (next.length === all.length) return false;
    this.writeSetting(PAIRINGS_KEY, JSON.stringify(next));
    return true;
  }

  removeAllowlistEntry(channelId: string, kind: 'dm' | 'group', entryId: string): void {
    if (channelId === 'feishu') {
      const config = this.getFeishuConfig();
      if (kind === 'dm') {
        this.updateFeishuConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateFeishuConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
      return;
    }

    if (channelId === 'dingtalk') {
      const config = this.getDingTalkConfig();
      if (kind === 'dm') {
        this.updateDingTalkConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateDingTalkConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
      return;
    }

    if (channelId === 'slack') {
      const config = this.getSlackConfig();
      if (kind === 'dm') {
        this.updateSlackConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateSlackConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
      return;
    }

    if (channelId === 'wecom') {
      const config = this.getWeComConfig();
      if (kind === 'dm') {
        this.updateWeComConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateWeComConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
      return;
    }

    if (channelId === 'telegram') {
      const config = this.getTelegramConfig();
      if (kind === 'dm') {
        this.updateTelegramConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateTelegramConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
      return;
    }

    if (channelId === 'github') {
      const config = this.getGitHubConfig();
      if (kind === 'dm') {
        this.updateGitHubConfig({
          access: {
            dmAllowlist: config.access.dmAllowlist.filter((id) => id !== entryId),
          },
        });
        return;
      }
      this.updateGitHubConfig({
        access: {
          groupAllowlist: config.access.groupAllowlist.filter((id) => id !== entryId),
        },
      });
    }
  }

  listTargets(channelId?: string): ChannelTargetView[] {
    const all = this.readJson<ChannelTargetView[]>(TARGETS_KEY, []);
    const filtered = channelId ? all.filter((item) => item.channelId === channelId) : all;
    return filtered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  recordTarget(target: ChannelTargetView): void {
    const all = this.readJson<ChannelTargetView[]>(TARGETS_KEY, []);
    const existing = all.find(
      (item) => item.channelId === target.channelId && item.address === target.address,
    );
    const merged: ChannelTargetView = {
      channelId: target.channelId,
      address: target.address,
      chatKind: target.chatKind,
      title: target.title || existing?.title || target.address,
      lastActiveAt: Math.max(target.lastActiveAt, existing?.lastActiveAt ?? 0),
    };
    const next = [
      merged,
      ...all.filter(
        (item) => !(item.channelId === target.channelId && item.address === target.address),
      ),
    ].slice(0, MAX_TARGETS);
    this.writeSetting(TARGETS_KEY, JSON.stringify(next));
  }

  forgetTarget(channelId: string, address: string): void {
    const all = this.readJson<ChannelTargetView[]>(TARGETS_KEY, []);
    const next = all.filter(
      (item) => !(item.channelId === channelId && item.address === address),
    );
    this.writeSetting(TARGETS_KEY, JSON.stringify(next));
  }
}
