import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelRuntimeStatus,
  ChannelTargetView,
  ChannelTestDraft,
  ChannelView,
  ChatAttachmentRef,
} from '@opc/shared/domain';
import type { ChannelStore } from '../store';
import type {
  ChannelInboundMessage,
  ChannelPlugin,
  ChannelPluginContext,
  ChannelSendPayload,
  ChannelSendResult,
  ChannelThinkingCleanup,
} from '../types';
import { SlackApi } from './slackApi';
import {
  buildSlackOutboundMessages,
  formatSlackAddress,
  parseSlackAddress,
  stripSlackBotMention,
} from './slackFormat';
import { SlackSocketClient } from './slackSocket';

const MAX_SEEN_EVENTS = 500;
const MAX_THREAD_MAPPINGS = 500;

interface SlackFileEntry {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

interface ThreadMapping {
  channelId: string;
  chatKind: 'p2p' | 'group';
  threadTs: string;
}

function sanitizeFileName(raw: string): string {
  const withoutControls = [...path.basename(raw)]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('');
  const base = withoutControls.replace(/[<>:"/\\|?*]/g, '_').trim();
  return base || `file-${Date.now()}`;
}

export class SlackPlugin implements ChannelPlugin {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  readonly transport = 'socket' as const;

  private ctx: ChannelPluginContext | null = null;
  private api: SlackApi | null = null;
  private socketClient: SlackSocketClient | null = null;
  private botUserId: string | undefined;
  private seenEvents = new Set<string>();
  private messageThreads = new Map<string, ThreadMapping>();
  private status: ChannelRuntimeStatus = {
    channelId: 'slack',
    transport: 'socket',
    state: 'disabled',
  };

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
    return { ...this.status };
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

  private setStatus(patch: Partial<ChannelRuntimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      channelId: this.id,
      transport: this.transport,
    };
    this.ctx?.onStatusChange();
  }

  private stopSocketOnly(): void {
    if (this.socketClient) {
      this.socketClient.stop();
      this.socketClient = null;
    }
    this.api = null;
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    this.stopSocketOnly();

    const cfg = this.store.getSlackConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.botToken || !cfg.appToken) {
      this.setStatus({
        state: 'disconnected',
        lastError: '请填写 Slack Bot Token (xoxb-) 和 App-Level Token (xapp-)',
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.setStatus({
      state: 'connecting',
      lastError: undefined,
      lastErrorAt: undefined,
    });

    const api = new SlackApi({
      botToken: cfg.botToken,
      appToken: cfg.appToken,
    });
    this.api = api;

    try {
      const auth = await api.authTest();
      this.botUserId = auth.userId;
      const botLabel = auth.teamName && auth.botName
        ? `${auth.teamName} · ${auth.botName}`
        : auth.botName ?? auth.teamName;
      this.setStatus({
        ...(botLabel ? { botName: botLabel } : {}),
        botOpenId: auth.userId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        state: 'error',
        lastError: message,
        lastErrorAt: Date.now(),
      });
      return;
    }

    const socketClient = new SlackSocketClient({
      openUrl: () => api.openSocketConnection(),
      onConnected: () => {
        if (this.socketClient !== socketClient) return;
        this.setStatus({
          state: 'connected',
          connectedAt: Date.now(),
          lastError: undefined,
          lastErrorAt: undefined,
        });
      },
      onReconnecting: () => {
        if (this.socketClient !== socketClient) return;
        this.setStatus({ state: 'reconnecting' });
      },
      onError: (message) => {
        if (this.socketClient !== socketClient) return;
        this.setStatus({
          state: 'error',
          lastError: message,
          lastErrorAt: Date.now(),
        });
      },
      onEvent: (event) => this.handleSlackEvent(event),
    });
    this.socketClient = socketClient;

    try {
      await socketClient.start();
    } catch (error) {
      if (this.socketClient === socketClient) {
        this.setStatus({
          state: 'error',
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorAt: Date.now(),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopSocketOnly();
    const cfg = this.store.getSlackConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const stored = this.store.getSlackConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const botToken =
      typeof patch.botToken === 'string' && patch.botToken.trim()
        ? patch.botToken.trim()
        : stored.botToken;
    const appToken =
      typeof patch.appToken === 'string' && patch.appToken.trim()
        ? patch.appToken.trim()
        : stored.appToken;

    if (!botToken || !appToken) {
      return {
        ok: false,
        error: '请先填写 Bot Token (xoxb-) 和 App-Level Token (xapp-)',
        latencyMs: 0,
      };
    }

    const tempApi = new SlackApi({ botToken, appToken });
    return tempApi.verifyConnection();
  }

  private rememberSeenEvent(key: string): boolean {
    if (this.seenEvents.has(key)) return false;
    if (this.seenEvents.size >= MAX_SEEN_EVENTS) {
      const oldest = this.seenEvents.values().next().value;
      if (oldest) this.seenEvents.delete(oldest);
    }
    this.seenEvents.add(key);
    return true;
  }

  private rememberThreadMapping(messageId: string, mapping: ThreadMapping): void {
    if (this.messageThreads.size >= MAX_THREAD_MAPPINGS && !this.messageThreads.has(messageId)) {
      const oldest = this.messageThreads.keys().next().value;
      if (oldest) this.messageThreads.delete(oldest);
    }
    this.messageThreads.set(messageId, mapping);
  }

  private async downloadSlackFiles(
    messageId: string,
    files: SlackFileEntry[],
  ): Promise<ChatAttachmentRef[]> {
    const api = this.api;
    const ctx = this.ctx;
    if (!api || !ctx || files.length === 0) return [];

    const dir = ctx.getAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const attachments: ChatAttachmentRef[] = [];

    for (const file of files) {
      const downloadUrl = file.url_private_download ?? file.url_private;
      if (!downloadUrl) continue;
      try {
        const rawName = file.name ?? file.title ?? `slack-${file.id ?? Date.now()}`;
        const safeName = sanitizeFileName(rawName);
        const idHash = createHash('sha1')
          .update(`${messageId}:${file.id ?? downloadUrl}`)
          .digest('hex')
          .slice(0, 8);
        const destPath = path.join(dir, `${idHash}-${safeName}`);
        const { size } = await api.downloadPrivateFile(downloadUrl, destPath);
        attachments.push({
          id: `slack-${idHash}`,
          name: safeName,
          path: destPath,
          size,
          ...(file.mimetype ? { mimeType: file.mimetype } : {}),
          source: 'file',
          availability: 'available',
        });
      } catch (error) {
        console.warn('[channels:slack] 下载入站附件失败', error);
      }
    }

    return attachments;
  }

  private async handleSlackEvent(event: Record<string, unknown>): Promise<void> {
    const ctx = this.ctx;
    const api = this.api;
    if (!ctx || !api) return;

    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType !== 'message' && eventType !== 'app_mention') return;

    const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
    if (subtype && subtype !== 'file_share') return;

    const userId = typeof event.user === 'string' ? event.user : '';
    const isBotSender =
      Boolean(event.bot_id) ||
      !userId ||
      Boolean(this.botUserId && userId === this.botUserId);
    if (isBotSender) return;

    const channelId = typeof event.channel === 'string' ? event.channel : '';
    const ts = typeof event.ts === 'string' ? event.ts : '';
    if (!channelId || !ts) return;

    const messageId = `${channelId}:${ts}`;
    if (!this.rememberSeenEvent(messageId)) return;

    this.setStatus({ lastEventAt: Date.now() });

    const channelType = typeof event.channel_type === 'string' ? event.channel_type : '';
    const chatKind: 'p2p' | 'group' =
      channelType === 'im' || channelId.startsWith('D') ? 'p2p' : 'group';

    const rawText = typeof event.text === 'string' ? event.text : '';
    const mentionsBot =
      chatKind === 'p2p' ||
      eventType === 'app_mention' ||
      Boolean(this.botUserId && rawText.includes(`<@${this.botUserId}>`));

    const cleanedText = stripSlackBotMention(rawText, this.botUserId);
    const rawFiles = Array.isArray(event.files) ? (event.files as SlackFileEntry[]) : [];
    const attachments = await this.downloadSlackFiles(messageId, rawFiles);
    if (!cleanedText && attachments.length === 0) return;

    const threadTs =
      typeof event.thread_ts === 'string' && event.thread_ts.trim()
        ? event.thread_ts.trim()
        : ts;
    this.rememberThreadMapping(messageId, { channelId, chatKind, threadTs });

    const senderName = await api.getUserName(userId);
    const channelTitle =
      chatKind === 'p2p'
        ? senderName
        : (await api.getChannelName(channelId)) ?? `#${channelId}`;

    const tsNum = Number(ts.split('.')[0]);
    const address = formatSlackAddress(channelId);

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      messageId,
      chatId: channelId,
      chatKind,
      chatTitle: channelTitle,
      senderId: userId,
      senderName,
      isBotSender: false,
      mentionsBot,
      text: cleanedText || (attachments.length > 0 ? '[附件消息]' : ''),
      attachments,
      timestamp: Number.isFinite(tsNum) && tsNum > 0 ? tsNum * 1000 : Date.now(),
      replyTarget: {
        adapterId: this.id,
        source: 'im',
        address,
        messageId,
      },
    };

    await ctx.onInboundMessage(inbound);
  }

  async markThinking(messageId: string): Promise<ChannelThinkingCleanup | undefined> {
    const cfg = this.store.getSlackConfig();
    if (!cfg.thinkingReaction || !this.api || !messageId) return undefined;

    const colonIndex = messageId.indexOf(':');
    if (colonIndex <= 0) return undefined;
    const channel = messageId.slice(0, colonIndex);
    const ts = messageId.slice(colonIndex + 1);
    if (!channel || !ts) return undefined;

    const api = this.api;
    try {
      await api.addReaction(channel, ts, 'thinking_face');
      let cleared = false;
      return async () => {
        if (cleared) return;
        cleared = true;
        await api.removeReaction(channel, ts, 'thinking_face').catch(() => undefined);
      };
    } catch {
      return undefined;
    }
  }

  private resolveReplyThreadTs(replyToMessageId?: string): string | undefined {
    if (!replyToMessageId) return undefined;
    const mapping = this.messageThreads.get(replyToMessageId);
    if (mapping) {
      if (mapping.chatKind === 'p2p') {
        const colonIdx = replyToMessageId.indexOf(':');
        const originalTs = colonIdx > 0 ? replyToMessageId.slice(colonIdx + 1) : '';
        return mapping.threadTs !== originalTs ? mapping.threadTs : undefined;
      }
      if (this.store.getSlackConfig().replyInThread) {
        return mapping.threadTs;
      }
      return undefined;
    }
    return undefined;
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const channelId = parseSlackAddress(payload.address);
    if (!channelId) {
      return { ok: false, error: `无效的 Slack 会话地址: ${payload.address}` };
    }
    if (!this.api) {
      return { ok: false, error: 'Slack 渠道当前未连接，请先在设置中启用并连接 Slack Bot' };
    }

    try {
      let lastTs: string | undefined;
      const threadTs = this.resolveReplyThreadTs(payload.replyToMessageId);
      const chunks = buildSlackOutboundMessages(payload.blocks, payload.text);

      for (const text of chunks) {
        const ts = await this.api.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { threadTs } : {}),
        });
        if (ts) lastTs = ts;
      }

      if (payload.attachments?.length) {
        for (const item of payload.attachments) {
          const fileName = sanitizeFileName(item.name ?? path.basename(item.path));
          await this.api.uploadFileV2({
            channelId,
            filePath: item.path,
            fileName,
            ...(threadTs ? { threadTs } : {}),
          });
        }
      }

      return {
        ok: true,
        ...(lastTs ? { messageId: `${channelId}:${lastTs}` } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
