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
import { ChannelStore } from './store';
import type {
  ChannelPlugin,
  ChannelPluginContext,
  ChannelSendPayload,
  ChannelSendResult,
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

  it('supports Feishu and DingTalk simultaneously with isolated secrets, pairing, and routing', async () => {
    const db = makeInMemoryDb();
    dbs.push(db);
    const store = new ChannelStore(db, testCipher);
    store.updateFeishuConfig({ enabled: true, appId: 'cli_fs', appSecret: 'sec_fs' });
    store.updateDingTalkConfig({ enabled: true, clientId: 'ding_dt', clientSecret: 'sec_dt' });

    expect(store.getFeishuConfig().appSecret).toBe('sec_fs');
    expect(store.getDingTalkConfig().clientSecret).toBe('sec_dt');
    const dtView = store.getDingTalkSettingsView() as unknown as Record<string, unknown>;
    expect(dtView.hasClientSecret).toBe(true);
    expect('clientSecret' in dtView).toBe(false);

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
    manager.registerPlugin(feishu);
    manager.registerPlugin(dingtalk);
    await manager.startEnabled();

    expect(manager.listViews().map((v) => v.id)).toEqual(['feishu', 'dingtalk']);

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

    // Proactive message to DingTalk group routes exclusively to DingTalk plugin.
    const proactive = await manager.sendProactiveMessage({
      address: 'dingtalk:group:cid_ops',
      text: '运维日报已生成',
    });
    expect(proactive.ok).toBe(true);
    expect(dingtalk.sent.at(-1)?.address).toBe('dingtalk:group:cid_ops');
    expect(feishu.sent).toHaveLength(0);
  });
});
