import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelRuntimeStatus,
  FeishuChannelSettingsView,
} from '@opc/shared/domain';
import { ChannelManager, type ChannelChatMirror } from './channelManager';
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
  readonly id = 'feishu';
  readonly name = '飞书 / Lark';
  readonly transport = 'socket' as const;
  ctx: ChannelPluginContext | null = null;
  sent: ChannelSendPayload[] = [];

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    const cfg = this.store.getFeishuConfig();
    return Boolean(cfg.appId && cfg.appSecret);
  }
  getSettingsView(): FeishuChannelSettingsView {
    return this.store.getFeishuSettingsView();
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

    // Unknown sender triggers pairing instead of reaching Router.
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
      replyTarget: { adapterId: 'feishu', source: 'im', address: 'feishu:chat:oc_dm_1', messageId: 'om_1' },
    });

    expect(enqueued).toHaveLength(0);
    expect(pairingNotices).toHaveLength(1);
    expect(plugin.sent).toHaveLength(1);
    expect(plugin.sent[0]?.text).toContain('配对请求');

    const pairings = store.listPairings('feishu');
    expect(pairings).toHaveLength(1);

    // Approve pairing request.
    manager.approvePairing(pairings[0]!.id);
    expect(store.listPairings('feishu')).toHaveLength(0);
    expect(store.getFeishuConfig().access.dmAllowlist).toContain('ou_zhangsan');

    // Second message from approved sender reaches Router & mirrors to desktop.
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
      replyTarget: { adapterId: 'feishu', source: 'im', address: 'feishu:chat:oc_dm_1', messageId: 'om_2' },
    });

    expect(enqueued).toHaveLength(1);
    expect(mirroredUser).toHaveLength(1);

    // Outbound reply sends back to Feishu and mirrors to desktop.
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
});
