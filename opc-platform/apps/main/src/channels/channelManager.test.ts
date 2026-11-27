import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelRuntimeStatus,
  ChannelTargetView,
  ChannelView,
} from '@opc/shared/domain';
import { ChannelManager, type ChannelChatMirror } from './channelManager';
import { formatDingTalkAddress, parseDingTalkAddress } from './dingtalk/dingtalkFormat';
import { formatFeishuAddress, parseFeishuAddress } from './feishu/feishuFormat';
import { formatGitHubAddress, parseGitHubAddress } from './github/githubFormat';
import { formatSlackAddress, parseSlackAddress } from './slack/slackFormat';
import { formatTelegramAddress, parseTelegramAddress } from './telegram/telegramFormat';
import { formatWeComAddress, parseWeComAddress } from './wecom/wecomFormat';
import { ChannelStore } from './store';
import type {
  ChannelPlugin,
  ChannelPluginContext,
  ChannelSendPayload,
  ChannelSendResult,
  ChannelThinkingCleanup,
  ChannelThinkingCleanupReason,
} from './types';

const testCipher = {
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (buf: Buffer) => {
    const raw = buf.toString('utf8');
    return raw.startsWith('enc:') ? raw.slice(4) : raw;
  },
};

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

class FakeFeishuPlugin implements ChannelPlugin {
  readonly id = 'feishu' as const;
  readonly name = '飞书 / Lark';
  readonly transport = 'socket' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    const cfg = this.store.getFeishuConfig();
    return Boolean(cfg.appId && cfg.appSecret);
  }
  isEnabled(): boolean {
    return this.store.getFeishuConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getFeishuConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getFeishuConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'feishu',
      transport: 'socket',
      state: this.store.getFeishuConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getFeishuSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseFeishuAddress(address) !== null;
  }
  formatTargetAddress(
    _chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return formatFeishuAddress(ids.chatId);
  }
  extractDisplayChatId(address: string): string {
    return parseFeishuAddress(address) ?? address;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: 'Buddy Bot', latencyMs: 12 };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true, messageId: `om_out_${this.sent.length}` };
  }
}

class FakeDingTalkPlugin implements ChannelPlugin {
  readonly id = 'dingtalk' as const;
  readonly name = '钉钉 / DingTalk';
  readonly transport = 'socket' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    const cfg = this.store.getDingTalkConfig();
    return Boolean(cfg.clientId && cfg.clientSecret);
  }
  isEnabled(): boolean {
    return this.store.getDingTalkConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getDingTalkConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getDingTalkConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'dingtalk',
      transport: 'socket',
      state: this.store.getDingTalkConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getDingTalkSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseDingTalkAddress(address) !== null;
  }
  formatTargetAddress(
    chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return formatDingTalkAddress(chatKind, chatKind === 'p2p' ? ids.senderId : ids.chatId);
  }
  extractDisplayChatId(address: string): string {
    const parsed = parseDingTalkAddress(address);
    if (!parsed) return address;
    return parsed.chatKind === 'p2p' ? parsed.staffId : parsed.openConversationId;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: 'ding_bot', latencyMs: 18 };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true, messageId: `dt_out_${this.sent.length}` };
  }
}

class FakeSlackPlugin implements ChannelPlugin {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  readonly transport = 'socket' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    const cfg = this.store.getSlackConfig();
    return Boolean(cfg.botToken && cfg.appToken);
  }
  isEnabled(): boolean {
    return this.store.getSlackConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getSlackConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getSlackConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'slack',
      transport: 'socket',
      state: this.store.getSlackConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getSlackSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseSlackAddress(address) !== null;
  }
  formatTargetAddress(
    _chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return formatSlackAddress(ids.chatId);
  }
  extractDisplayChatId(address: string): string {
    return parseSlackAddress(address) ?? address;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: 'Acme · buddy', botOpenId: 'UBOT1', latencyMs: 15 };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true, messageId: `C123:1700.${this.sent.length}` };
  }
}

class FakeWeComPlugin implements ChannelPlugin {
  readonly id = 'wecom' as const;
  readonly name = '企业微信 / WeCom';
  readonly transport = 'socket' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];
  thinkingCleanupReasons: Array<ChannelThinkingCleanupReason | undefined> = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    const cfg = this.store.getWeComConfig();
    return Boolean(cfg.botId && cfg.secret);
  }
  isEnabled(): boolean {
    return this.store.getWeComConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getWeComConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getWeComConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'wecom',
      transport: 'socket',
      state: this.store.getWeComConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getWeComSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseWeComAddress(address) !== null;
  }
  formatTargetAddress(
    chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return formatWeComAddress(chatKind, chatKind === 'group' ? ids.chatId : ids.senderId);
  }
  extractDisplayChatId(address: string): string {
    return parseWeComAddress(address)?.targetId ?? address;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: 'aib_wecom_1', botOpenId: 'aib_wecom_1', latencyMs: 14 };
  }
  async markThinking(): Promise<ChannelThinkingCleanup> {
    return async (reason?: ChannelThinkingCleanupReason) => {
      this.thinkingCleanupReasons.push(reason);
    };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true };
  }
}

class FakeTelegramPlugin implements ChannelPlugin {
  readonly id = 'telegram' as const;
  readonly name = 'Telegram';
  readonly transport = 'polling' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    return Boolean(this.store.getTelegramConfig().botToken);
  }
  isEnabled(): boolean {
    return this.store.getTelegramConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getTelegramConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getTelegramConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'telegram',
      transport: 'polling',
      state: this.store.getTelegramConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getTelegramSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseTelegramAddress(address) !== null;
  }
  formatTargetAddress(
    _chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return formatTelegramAddress(ids.chatId || ids.senderId);
  }
  extractDisplayChatId(address: string): string {
    const parsed = parseTelegramAddress(address);
    if (!parsed) return address;
    return parsed.topicId ? `${parsed.chatId}#${parsed.topicId}` : parsed.chatId;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: '@opc_buddy_bot', botOpenId: '9988', latencyMs: 16 };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true, messageId: `tg_out_${this.sent.length}` };
  }
}

class FakeGitHubPlugin implements ChannelPlugin {
  readonly id = 'github' as const;
  readonly name = 'GitHub';
  readonly transport = 'polling' as const;
  readonly silentPairing = true;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    return Boolean(this.store.getGitHubConfig().token);
  }
  isEnabled(): boolean {
    return this.store.getGitHubConfig().enabled;
  }
  shouldMirrorToDesktop(): boolean {
    return this.store.getGitHubConfig().mirrorToDesktop;
  }
  getAccessConfig(): ChannelAccessConfig {
    return this.store.getGitHubConfig().access;
  }
  getRuntimeStatus(): ChannelRuntimeStatus {
    return {
      channelId: 'github',
      transport: 'polling',
      state: this.store.getGitHubConfig().enabled ? 'connected' : 'disabled',
    };
  }
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getGitHubSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }
  matchesAddress(address: string): boolean {
    return parseGitHubAddress(address) !== null;
  }
  formatTargetAddress(
    _chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return ids.chatId.includes('#') ? `github:${ids.chatId}` : ids.chatId || ids.senderId;
  }
  extractDisplayChatId(address: string): string {
    const parsed = parseGitHubAddress(address);
    return parsed ? `${parsed.fullRepo}#${parsed.number}` : address;
  }
  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  async reconnect(): Promise<void> {}
  async testConnection(): Promise<ChannelConnectionTestResult> {
    return { ok: true, botName: '@octocat', botOpenId: 'octocat', latencyMs: 18 };
  }
  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    this.sent.push(payload);
    return { ok: true, messageId: `gh_out_${this.sent.length}` };
  }
}

describe('ChannelManager', () => {
  const dbs: Database.Database[] = [];

  afterEach(() => {
    while (dbs.length) dbs.pop()?.close();
  });

  it('creates pairing request for first-time DM sender and routes after approval', async () => {
    const db = makeInMemoryDb();
    dbs.push(db);
    const store = new ChannelStore(db, testCipher);
    store.updateFeishuConfig({
      enabled: true,
      appId: 'cli_a1',
      appSecret: 'sec_live_123',
      mirrorToDesktop: true,
    });
    expect(store.getFeishuConfig().appSecret).toBe('sec_live_123');
    const safeView = store.getFeishuSettingsView() as unknown as Record<string, unknown>;
    expect(safeView.hasAppSecret).toBe(true);
    expect('appSecret' in safeView).toBe(false);

    const enqueued: unknown[] = [];
    const mirroredUser: unknown[] = [];
    const mirroredAssistant: unknown[] = [];
    const pairingNotices: unknown[] = [];

    const chat: ChannelChatMirror = {
      appendMirroredUserMessage: (input) => mirroredUser.push(input),
      appendMirroredAssistantMessage: (input) => mirroredAssistant.push(input),
    };

    const manager = new ChannelManager({
      store,
      threads: {
        enqueueOnce: (input) => {
          enqueued.push(input);
          return { inserted: true, event: { id: 'ev_1' } as never };
        },
      },
      chat,
      attachmentsDir: 'C:\\temp\\attachments',
      onAcceptedEvent: vi.fn(),
      onPairingRequest: (req) => pairingNotices.push(req),
    });

    const plugin = new FakeFeishuPlugin(store);
    manager.registerPlugin(plugin);
    await manager.startEnabled();

    await plugin.ctx!.onInboundMessage({
      channelId: 'feishu',
      channelName: '飞书 / Lark',
      transport: 'socket',
      messageId: 'om_1',
      chatId: 'oc_dm_1',
      chatKind: 'p2p',
      chatTitle: '张三',
      senderId: 'ou_zhangsan',
      senderName: '张三',
      isBotSender: false,
      mentionsBot: true,
      text: '你好 Buddy',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'feishu',
        source: 'im',
        address: 'feishu:chat:oc_dm_1',
        messageId: 'om_1',
      },
    });

    expect(enqueued).toHaveLength(0);
    expect(pairingNotices).toHaveLength(1);
    expect(plugin.sent).toHaveLength(1);
    expect(plugin.sent[0]?.text).toContain('配对请求');

    const pairings = store.listPairings('feishu');
    expect(pairings).toHaveLength(1);

    manager.approvePairing(pairings[0]!.id);
    expect(store.listPairings('feishu')).toHaveLength(0);
    expect(store.getFeishuConfig().access.dmAllowlist).toContain('ou_zhangsan');

    await plugin.ctx!.onInboundMessage({
      channelId: 'feishu',
      channelName: '飞书 / Lark',
      transport: 'socket',
      messageId: 'om_2',
      chatId: 'oc_dm_1',
      chatKind: 'p2p',
      chatTitle: '张三',
      senderId: 'ou_zhangsan',
      senderName: '张三',
      isBotSender: false,
      mentionsBot: true,
      text: '帮我总结一下今天的数据',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'feishu',
        source: 'im',
        address: 'feishu:chat:oc_dm_1',
        messageId: 'om_2',
      },
    });

    expect(enqueued).toHaveLength(1);
    expect(mirroredUser).toHaveLength(1);

    const replyOutcome = await manager.sendExternalReply(
      { adapterId: 'feishu', source: 'im', address: 'feishu:chat:oc_dm_1', messageId: 'om_2' },
      {
        blocks: [{ type: 'markdown', text: '汇总如下' }],
      },
      '汇总如下',
    );
    expect(replyOutcome.ok).toBe(true);
    expect(mirroredAssistant).toHaveLength(1);
  });

  it('supports Feishu, DingTalk, Slack, WeCom, Telegram, and GitHub simultaneously with isolated secrets, pairing, and routing', async () => {
    const db = makeInMemoryDb();
    dbs.push(db);
    const store = new ChannelStore(db, testCipher);
    store.updateFeishuConfig({ enabled: true, appId: 'cli_fs', appSecret: 'sec_fs' });
    store.updateDingTalkConfig({ enabled: true, clientId: 'ding_dt', clientSecret: 'sec_dt' });
    store.updateSlackConfig({ enabled: true, botToken: 'xoxb-slk', appToken: 'xapp-slk' });
    store.updateWeComConfig({ enabled: true, botId: 'aib_wc', secret: 'sec_wc' });
    store.updateTelegramConfig({ enabled: true, botToken: '12345:tg-secret', apiBaseUrl: 'https://tg.custom/' });
    store.updateGitHubConfig({
      enabled: true,
      token: 'ghp_secret_123',
      notificationsToken: 'ghp_notif_456',
      watchRepos: ['https://github.com/Acme/Api.git'],
    });

    expect(store.getFeishuConfig().appSecret).toBe('sec_fs');
    expect(store.getDingTalkConfig().clientSecret).toBe('sec_dt');
    expect(store.getSlackConfig().botToken).toBe('xoxb-slk');
    expect(store.getSlackConfig().appToken).toBe('xapp-slk');
    expect(store.getWeComConfig().secret).toBe('sec_wc');
    expect(store.getTelegramConfig().botToken).toBe('12345:tg-secret');
    expect(store.getTelegramConfig().apiBaseUrl).toBe('https://tg.custom');
    expect(store.getGitHubConfig().token).toBe('ghp_secret_123');
    expect(store.getGitHubConfig().notificationsToken).toBe('ghp_notif_456');
    expect(store.getGitHubConfig().watchRepos).toEqual(['acme/api']);
    const dtView = store.getDingTalkSettingsView() as unknown as Record<string, unknown>;
    expect(dtView.hasClientSecret).toBe(true);
    expect('clientSecret' in dtView).toBe(false);
    const slackView = store.getSlackSettingsView() as unknown as Record<string, unknown>;
    expect(slackView.hasBotToken).toBe(true);
    expect(slackView.hasAppToken).toBe(true);
    expect('botToken' in slackView).toBe(false);
    expect('appToken' in slackView).toBe(false);
    const wcView = store.getWeComSettingsView() as unknown as Record<string, unknown>;
    expect(wcView.hasSecret).toBe(true);
    expect('secret' in wcView).toBe(false);
    const tgView = store.getTelegramSettingsView() as unknown as Record<string, unknown>;
    expect(tgView.hasBotToken).toBe(true);
    expect('botToken' in tgView).toBe(false);
    const ghView = store.getGitHubSettingsView() as unknown as Record<string, unknown>;
    expect(ghView.hasToken).toBe(true);
    expect(ghView.hasNotificationsToken).toBe(true);
    expect('token' in ghView).toBe(false);
    expect('notificationsToken' in ghView).toBe(false);

    const enqueued: unknown[] = [];
    const pairingChannels: string[] = [];

    const manager = new ChannelManager({
      store,
      threads: {
        enqueueOnce: (input) => {
          enqueued.push(input);
          return { inserted: true, event: { id: `ev_${enqueued.length}` } as never };
        },
      },
      attachmentsDir: 'C:\\temp\\attachments',
      onPairingRequest: (_req, channelName) => pairingChannels.push(channelName),
    });

    const feishu = new FakeFeishuPlugin(store);
    const dingtalk = new FakeDingTalkPlugin(store);
    const slack = new FakeSlackPlugin(store);
    const wecom = new FakeWeComPlugin(store);
    const telegram = new FakeTelegramPlugin(store);
    const github = new FakeGitHubPlugin(store);
    manager.registerPlugin(feishu);
    manager.registerPlugin(dingtalk);
    manager.registerPlugin(slack);
    manager.registerPlugin(wecom);
    manager.registerPlugin(telegram);
    manager.registerPlugin(github);
    await manager.startEnabled();

    expect(manager.listViews().map((v) => v.id)).toEqual([
      'feishu',
      'dingtalk',
      'slack',
      'wecom',
      'telegram',
      'github',
    ]);

    // First DingTalk DM requires pairing and sends notice to dingtalk:dm:<staffId>.
    await dingtalk.ctx!.onInboundMessage({
      channelId: 'dingtalk',
      channelName: '钉钉 / DingTalk',
      transport: 'socket',
      messageId: 'dt_msg_1',
      chatId: 'staff_li',
      chatKind: 'p2p',
      chatTitle: '李四',
      senderId: 'staff_li',
      senderName: '李四',
      isBotSender: false,
      mentionsBot: true,
      text: 'Hi Buddy',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'dingtalk',
        source: 'im',
        address: 'dingtalk:dm:staff_li',
        messageId: 'dt_msg_1',
      },
    });

    expect(pairingChannels).toEqual(['钉钉 / DingTalk']);
    const dtPairings = store.listPairings('dingtalk');
    expect(dtPairings).toHaveLength(1);

    manager.approvePairing(dtPairings[0]!.id);
    expect(dingtalk.sent.at(-1)?.address).toBe('dingtalk:dm:staff_li');
    expect(store.getDingTalkConfig().access.dmAllowlist).toContain('staff_li');
    expect(feishu.sent).toHaveLength(0);
    expect(slack.sent).toHaveLength(0);
    expect(wecom.sent).toHaveLength(0);

    // First Slack DM queues pairing request and approves cleanly to slack:channel:D0123456789.
    await slack.ctx!.onInboundMessage({
      channelId: 'slack',
      channelName: 'Slack',
      transport: 'socket',
      messageId: 'D0123456789:1700.1',
      chatId: 'D0123456789',
      chatKind: 'p2p',
      chatTitle: 'Alice',
      senderId: 'U0123456789',
      senderName: 'Alice',
      isBotSender: false,
      mentionsBot: true,
      text: 'Hello from Slack',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'slack',
        source: 'im',
        address: 'slack:channel:D0123456789',
        messageId: 'D0123456789:1700.1',
      },
    });

    expect(pairingChannels).toEqual(['钉钉 / DingTalk', 'Slack']);
    const slackPairings = store.listPairings('slack');
    expect(slackPairings).toHaveLength(1);
    manager.approvePairing(slackPairings[0]!.id);
    expect(slack.sent.at(-1)?.address).toBe('slack:channel:D0123456789');
    expect(store.getSlackConfig().access.dmAllowlist).toContain('U0123456789');

    // First WeCom DM queues pairing request and approves cleanly to wecom:dm:wangwu.
    await wecom.ctx!.onInboundMessage({
      channelId: 'wecom',
      channelName: '企业微信 / WeCom',
      transport: 'socket',
      messageId: 'wc_msg_1',
      chatId: 'wangwu',
      chatKind: 'p2p',
      chatTitle: 'wangwu',
      senderId: 'wangwu',
      senderName: 'wangwu',
      isBotSender: false,
      mentionsBot: true,
      text: '你好企业微信助手',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'wecom',
        source: 'im',
        address: 'wecom:dm:wangwu',
        messageId: 'wc_msg_1',
      },
    });

    expect(pairingChannels).toEqual(['钉钉 / DingTalk', 'Slack', '企业微信 / WeCom']);
    const wcPairings = store.listPairings('wecom');
    expect(wcPairings).toHaveLength(1);
    manager.approvePairing(wcPairings[0]!.id);
    expect(wecom.sent.at(-1)?.address).toBe('wecom:dm:wangwu');
    expect(store.getWeComConfig().access.dmAllowlist).toContain('wangwu');

    // Proactive message to DingTalk group routes exclusively to DingTalk plugin.
    const proactive = await manager.sendProactiveMessage({
      address: 'dingtalk:group:cid_ops',
      text: '运维日报已生成',
    });
    expect(proactive.ok).toBe(true);
    expect(dingtalk.sent.at(-1)?.address).toBe('dingtalk:group:cid_ops');

    // Proactive message to Slack channel routes exclusively to Slack plugin.
    const slackProactive = await manager.sendProactiveMessage({
      address: 'slack:channel:C0123456789',
      text: 'Deploy succeeded',
    });
    expect(slackProactive.ok).toBe(true);
    expect(slack.sent.at(-1)?.address).toBe('slack:channel:C0123456789');

    // Proactive message to WeCom group routes exclusively to WeCom plugin.
    const wecomProactive = await manager.sendProactiveMessage({
      address: 'wecom:group:wr_ops_group',
      text: '巡检已完成',
    });
    expect(wecomProactive.ok).toBe(true);
    expect(wecom.sent.at(-1)?.address).toBe('wecom:group:wr_ops_group');

    // First Telegram DM queues pairing request and approves cleanly to telegram:chat:10086.
    await telegram.ctx!.onInboundMessage({
      channelId: 'telegram',
      channelName: 'Telegram',
      transport: 'polling',
      messageId: '10086:1',
      chatId: '10086',
      chatKind: 'p2p',
      chatTitle: 'Tom',
      senderId: '10086',
      senderName: 'Tom',
      isBotSender: false,
      mentionsBot: true,
      text: '你好',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'telegram',
        source: 'im',
        address: 'telegram:chat:10086',
        messageId: '10086:1',
      },
    });
    expect(pairingChannels).toEqual(['钉钉 / DingTalk', 'Slack', '企业微信 / WeCom', 'Telegram']);
    const tgPairings = store.listPairings('telegram');
    expect(tgPairings).toHaveLength(1);
    manager.approvePairing(tgPairings[0]!.id);
    expect(telegram.sent.at(-1)?.address).toBe('telegram:chat:10086');
    expect(store.getTelegramConfig().access.dmAllowlist).toContain('10086');

    // Proactive message to Telegram Forum Topic routes exclusively to Telegram plugin.
    const tgProactive = await manager.sendProactiveMessage({
      address: 'telegram:chat:-100123456:topic:42',
      text: 'Release finished',
    });
    expect(tgProactive.ok).toBe(true);
    expect(telegram.sent.at(-1)?.address).toBe('telegram:chat:-100123456:topic:42');

    // First external GitHub collaborator triggers silent pairing (no spam comment on GitHub!).
    await github.ctx!.onInboundMessage({
      channelId: 'github',
      channelName: 'GitHub',
      transport: 'polling',
      source: 'github',
      eventKind: 'github.comment',
      threadKey: formatGitHubAddress('acme/api', 12),
      messageId: 'gh:comment:1',
      chatId: 'acme/api',
      chatKind: 'p2p',
      chatTitle: 'acme/api#12 Fix auth race',
      senderId: 'alice',
      senderName: '@alice',
      isBotSender: false,
      mentionsBot: true,
      text: '请看下这个 PR',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'github',
        source: 'github',
        address: 'github:acme/api#12',
        messageId: 'gh:comment:1',
      },
    });
    expect(pairingChannels).toEqual([
      '钉钉 / DingTalk',
      'Slack',
      '企业微信 / WeCom',
      'Telegram',
      'GitHub',
    ]);
    // Silent pairing: zero public comments posted to GitHub before approval.
    expect(github.sent).toHaveLength(0);
    const ghPairings = store.listPairings('github');
    expect(ghPairings).toHaveLength(1);
    manager.approvePairing(ghPairings[0]!.id);
    expect(github.sent).toHaveLength(0);
    expect(store.getGitHubConfig().access.dmAllowlist).toContain('alice');

    // Approved collaborator GitHub event enqueues with source='github' & threadKey for passthrough.
    await github.ctx!.onInboundMessage({
      channelId: 'github',
      channelName: 'GitHub',
      transport: 'polling',
      source: 'github',
      eventKind: 'github.comment',
      threadKey: 'github:acme/api#12',
      messageId: 'gh:comment:2',
      chatId: 'acme/api',
      chatKind: 'p2p',
      chatTitle: 'acme/api#12 Fix auth race',
      senderId: 'alice',
      senderName: '@alice',
      isBotSender: false,
      mentionsBot: true,
      text: '已允许后继续分析 PR #12',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'github',
        source: 'github',
        address: 'github:acme/api#12',
        messageId: 'gh:comment:2',
      },
    });
    const lastEnqueued = enqueued.at(-1) as {
      source: string;
      kind: string;
      payload: { threadKey?: string };
    };
    expect(lastEnqueued.source).toBe('github');
    expect(lastEnqueued.kind).toBe('github.comment');
    expect(lastEnqueued.payload.threadKey).toBe('github:acme/api#12');

    // Proactive message to GitHub Issue/PR routes exclusively to GitHub plugin.
    const ghProactive = await manager.sendProactiveMessage({
      address: 'github:acme/api#12',
      text: '已完成 PR #12 自动排查总结',
    });
    expect(ghProactive.ok).toBe(true);
    expect(github.sent.at(-1)?.address).toBe('github:acme/api#12');
    expect(feishu.sent).toHaveLength(0);
  });

  it('passes replied and cancelled reasons to ChannelThinkingCleanup for streaming channels', async () => {
    const db = makeInMemoryDb();
    dbs.push(db);
    const store = new ChannelStore(db, testCipher);
    store.updateWeComConfig({
      enabled: true,
      botId: 'aib_wc',
      secret: 'sec_wc',
      access: { dmPolicy: 'open', groupPolicy: 'open' },
    });

    const manager = new ChannelManager({
      store,
      threads: {
        enqueueOnce: () => ({ inserted: true, event: { id: 'ev_1' } as never }),
      },
      attachmentsDir: 'C:\\temp\\attachments',
    });

    const wecom = new FakeWeComPlugin(store);
    manager.registerPlugin(wecom);
    await manager.startEnabled();

    await wecom.ctx!.onInboundMessage({
      channelId: 'wecom',
      channelName: '企业微信 / WeCom',
      transport: 'socket',
      messageId: 'wc_stream_1',
      chatId: 'wangwu',
      chatKind: 'p2p',
      chatTitle: 'wangwu',
      senderId: 'wangwu',
      senderName: 'wangwu',
      isBotSender: false,
      mentionsBot: true,
      text: '测试流式清理',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'wecom',
        source: 'im',
        address: 'wecom:dm:wangwu',
        messageId: 'wc_stream_1',
      },
    });

    // Wait for async trackThinking registration before replying.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.sendExternalReply(
      { adapterId: 'wecom', source: 'im', address: 'wecom:dm:wangwu', messageId: 'wc_stream_1' },
      { blocks: [{ type: 'markdown', text: '最终答复' }] },
      '最终答复',
    );
    expect(wecom.thinkingCleanupReasons).toEqual(['replied']);

    await wecom.ctx!.onInboundMessage({
      channelId: 'wecom',
      channelName: '企业微信 / WeCom',
      transport: 'socket',
      messageId: 'wc_stream_2',
      chatId: 'wangwu',
      chatKind: 'p2p',
      chatTitle: 'wangwu',
      senderId: 'wangwu',
      senderName: 'wangwu',
      isBotSender: false,
      mentionsBot: true,
      text: '测试关闭清理',
      attachments: [],
      timestamp: Date.now(),
      replyTarget: {
        adapterId: 'wecom',
        source: 'im',
        address: 'wecom:dm:wangwu',
        messageId: 'wc_stream_2',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.stopAll();
    expect(wecom.thinkingCleanupReasons).toEqual(['replied', 'cancelled']);
  });
});
