import type Database from 'better-sqlite3';
import type {
  ChannelAccessConfig,
  ChannelPairingRequest,
  ChannelTargetView,
  FeishuChannelSettingsPatch,
  FeishuChannelSettingsView,
  FeishuDomain,
} from '@opc/shared/domain';
import { decryptSecret, encryptSecret } from '../models/keyCipher';

const FEISHU_CONFIG_KEY = 'channels.feishu.config';
const FEISHU_SECRET_KEY = 'channels.feishu.secret';
const PAIRINGS_KEY = 'channels.pairings';
const TARGETS_KEY = 'channels.targets';
const MAX_PAIRINGS = 50;
const MAX_TARGETS = 100;

export interface FeishuInternalConfig extends FeishuChannelSettingsView {
  appSecret: string;
}

interface StoredFeishuConfig {
  enabled?: boolean;
  domain?: FeishuDomain;
  appId?: string;
  mirrorToDesktop?: boolean;
  thinkingReaction?: boolean;
  access?: Partial<ChannelAccessConfig>;
}

const DEFAULT_ACCESS: ChannelAccessConfig = {
  dmPolicy: 'pairing',
  dmAllowlist: [],
  groupPolicy: 'mention',
  groupAllowlist: [],
};

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
    if (channelId !== 'feishu') return;
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
