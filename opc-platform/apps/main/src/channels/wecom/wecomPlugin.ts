import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateReqId,
  MessageType,
  WSClient,
  type BaseMessage,
  type FileContent,
  type ImageContent,
  type Logger,
  type MixedMsgItem,
  type VideoContent,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
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
  ChannelThinkingCleanupReason,
} from '../types';
import {
  buildWeComOutboundMessages,
  detectWeComMediaType,
  formatWeComAddress,
  parseWeComAddress,
  stripWeComAtMention,
} from './wecomFormat';

const MAX_SEEN_MESSAGES = 500;
const MAX_PENDING_REPLIES = 300;
const PASSIVE_REPLY_TTL_MS = 5 * 60 * 1000;
const TEST_CONNECT_TIMEOUT_MS = 10_000;

interface PendingWeComReply {
  frame: WsFrame<BaseMessage>;
  streamId?: string;
  finished: boolean;
  receivedAt: number;
}

interface MediaDownloadSpec {
  url: string;
  aesKey?: string;
  fallbackName: string;
  mimeHint?: string;
}

const quietSdkLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, ...args) => {
    console.warn(`[channels:wecom] ${message}`, ...args);
  },
  error: (message, ...args) => {
    console.warn(`[channels:wecom] ${message}`, ...args);
  },
};

function sanitizeFileName(raw: string): string {
  const withoutControls = [...path.basename(raw)]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('');
  const base = withoutControls.replace(/[<>:"/\\|?*]/g, '_').trim();
  return base || `file-${Date.now()}`;
}

export class WeComPlugin implements ChannelPlugin {
  readonly id = 'wecom' as const;
  readonly name = '企业微信 / WeCom';
  readonly transport = 'socket' as const;

  private ctx: ChannelPluginContext | null = null;
  private client: WSClient | null = null;
  private seenMessages = new Set<string>();
  private pendingReplies = new Map<string, PendingWeComReply>();
  private kickedByPeer = false;
  private status: ChannelRuntimeStatus = {
    channelId: 'wecom',
    transport: 'socket',
    state: 'disabled',
  };

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
    const targetId = chatKind === 'group' ? ids.chatId || ids.senderId : ids.senderId || ids.chatId;
    return formatWeComAddress(chatKind, targetId);
  }

  extractDisplayChatId(address: string): string {
    return parseWeComAddress(address)?.targetId ?? address;
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

  private stopClientOnly(): void {
    if (this.client) {
      const existing = this.client;
      this.client = null;
      try {
        existing.disconnect();
      } catch {
        // Ignore disconnect errors on stale client.
      }
    }
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    this.stopClientOnly();
    this.kickedByPeer = false;

    const cfg = this.store.getWeComConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.botId || !cfg.secret) {
      this.setStatus({
        state: 'disconnected',
        lastError: '请填写企业微信智能机器人的 BotID 和 Secret',
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.setStatus({
      state: 'connecting',
      botName: cfg.botId,
      botOpenId: cfg.botId,
      lastError: undefined,
      lastErrorAt: undefined,
    });

    const client = new WSClient({
      botId: cfg.botId,
      secret: cfg.secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 5,
      logger: quietSdkLogger,
    });
    this.client = client;

    client.on('authenticated', () => {
      if (this.client !== client) return;
      this.kickedByPeer = false;
      this.setStatus({
        state: 'connected',
        botName: cfg.botId,
        botOpenId: cfg.botId,
        connectedAt: Date.now(),
        lastError: undefined,
        lastErrorAt: undefined,
      });
    });

    client.on('reconnecting', () => {
      if (this.client !== client) return;
      this.setStatus({ state: 'reconnecting' });
    });

    client.on('event.disconnected_event', () => {
      if (this.client !== client) return;
      this.kickedByPeer = true;
      this.setStatus({
        state: 'disconnected',
        lastError: '同一 BotID 在另一客户端建立长连接，当前会话已下线。',
        lastErrorAt: Date.now(),
      });
    });

    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      if (this.kickedByPeer) return;
      this.setStatus({
        state: this.store.getWeComConfig().enabled ? 'reconnecting' : 'disabled',
        ...(reason ? { lastError: reason, lastErrorAt: Date.now() } : {}),
      });
    });

    client.on('error', (error) => {
      if (this.client !== client) return;
      this.setStatus({
        state: 'error',
        lastError: error.message || String(error),
        lastErrorAt: Date.now(),
      });
    });

    client.on('message', (frame) => {
      if (this.client !== client) return;
      void this.handleInboundFrame(frame);
    });

    try {
      client.connect();
    } catch (error) {
      if (this.client === client) {
        this.setStatus({
          state: 'error',
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorAt: Date.now(),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopClientOnly();
    const cfg = this.store.getWeComConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const stored = this.store.getWeComConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const botId =
      typeof patch.botId === 'string' && patch.botId.trim() ? patch.botId.trim() : stored.botId;
    const secret =
      typeof patch.secret === 'string' && patch.secret.trim()
        ? patch.secret.trim()
        : stored.secret;

    if (!botId || !secret) {
      return {
        ok: false,
        error: '请先填写企业微信机器人的 BotID 和 Secret',
        latencyMs: 0,
      };
    }

    const sameAsSaved = botId === stored.botId && secret === stored.secret;
    // WeCom permits only 1 active WebSocket session per BotID: avoid self-kicking an
    // already healthy saved session unless credentials actually changed or offline.
    if (sameAsSaved && this.client?.isConnected && this.status.state === 'connected') {
      return {
        ok: true,
        botName: this.status.botName ?? botId,
        botOpenId: botId,
        latencyMs: 0,
      };
    }

    const startedAt = Date.now();
    const probe = new WSClient({
      botId,
      secret,
      maxReconnectAttempts: 0,
      maxAuthFailureAttempts: 0,
      logger: quietSdkLogger,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('连接企业微信长连接服务超时（10 秒）'));
        }, TEST_CONNECT_TIMEOUT_MS);

        probe.once('authenticated', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });

        probe.once('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });

        probe.once('disconnected', (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(reason || '连接已断开'));
        });

        probe.connect();
      });

      return {
        ok: true,
        botName: botId,
        botOpenId: botId,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      try {
        probe.disconnect();
      } catch {
        // Ignore probe cleanup error.
      }
      if (sameAsSaved && stored.enabled && this.ctx) {
        void this.start(this.ctx);
      }
    }
  }

  private rememberSeenMessage(msgid: string): boolean {
    if (this.seenMessages.has(msgid)) return false;
    if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }
    this.seenMessages.add(msgid);
    return true;
  }

  private rememberPendingReply(msgid: string, entry: PendingWeComReply): void {
    const now = Date.now();
    for (const [key, item] of this.pendingReplies.entries()) {
      if (now - item.receivedAt > PASSIVE_REPLY_TTL_MS) {
        this.pendingReplies.delete(key);
      }
    }
    if (this.pendingReplies.size >= MAX_PENDING_REPLIES && !this.pendingReplies.has(msgid)) {
      const oldest = this.pendingReplies.keys().next().value;
      if (oldest) this.pendingReplies.delete(oldest);
    }
    this.pendingReplies.set(msgid, entry);
  }

  private async downloadMediaItems(
    messageId: string,
    specs: MediaDownloadSpec[],
  ): Promise<ChatAttachmentRef[]> {
    const client = this.client;
    const ctx = this.ctx;
    if (!client || !ctx || specs.length === 0) return [];

    const dir = ctx.getAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const attachments: ChatAttachmentRef[] = [];

    for (const spec of specs) {
      try {
        const { buffer, filename } = await client.downloadFile(spec.url, spec.aesKey);
        const safeName = sanitizeFileName(filename || spec.fallbackName);
        const idHash = createHash('sha1')
          .update(`${messageId}:${spec.url}`)
          .digest('hex')
          .slice(0, 8);
        const destPath = path.join(dir, `${idHash}-${safeName}`);
        fs.writeFileSync(destPath, buffer);
        attachments.push({
          id: `wecom-${idHash}`,
          name: safeName,
          path: destPath,
          size: buffer.length,
          ...(spec.mimeHint ? { mimeType: spec.mimeHint } : {}),
          source: 'file',
          availability: 'available',
        });
      } catch (error) {
        console.warn('[channels:wecom] 下载/解密入站媒体失败', error);
      }
    }

    return attachments;
  }

  private extractTextAndMedia(body: BaseMessage): {
    rawText: string;
    mediaSpecs: MediaDownloadSpec[];
  } {
    const textParts: string[] = [];
    const mediaSpecs: MediaDownloadSpec[] = [];

    const pushImage = (img?: ImageContent, idx = 0) => {
      if (!img?.url) return;
      mediaSpecs.push({
        url: img.url,
        ...(img.aeskey ? { aesKey: img.aeskey } : {}),
        fallbackName: `wecom-image-${idx || Date.now()}.png`,
        mimeHint: 'image/png',
      });
    };

    const pushFile = (file?: FileContent) => {
      if (!file?.url) return;
      mediaSpecs.push({
        url: file.url,
        ...(file.aeskey ? { aesKey: file.aeskey } : {}),
        fallbackName: `wecom-file-${Date.now()}`,
      });
    };

    const pushVideo = (video?: VideoContent) => {
      if (!video?.url) return;
      mediaSpecs.push({
        url: video.url,
        ...(video.aeskey ? { aesKey: video.aeskey } : {}),
        fallbackName: `wecom-video-${Date.now()}.mp4`,
        mimeHint: 'video/mp4',
      });
    };

    switch (body.msgtype) {
      case MessageType.Text: {
        const content = (body.text as { content?: string } | undefined)?.content;
        if (content) textParts.push(content);
        break;
      }
      case MessageType.Voice: {
        const content = (body.voice as { content?: string } | undefined)?.content;
        if (content) textParts.push(content);
        break;
      }
      case MessageType.Image:
        pushImage(body.image as ImageContent | undefined);
        break;
      case MessageType.File:
        pushFile(body.file as FileContent | undefined);
        break;
      case MessageType.Video:
        pushVideo(body.video as VideoContent | undefined);
        break;
      case MessageType.Mixed: {
        const items = (body.mixed as { msg_item?: MixedMsgItem[] } | undefined)?.msg_item ?? [];
        items.forEach((item, idx) => {
          if (item.msgtype === 'text' && item.text?.content) {
            textParts.push(item.text.content);
          } else if (item.msgtype === 'image') {
            pushImage(item.image, idx + 1);
          }
        });
        break;
      }
      default:
        break;
    }

    return {
      rawText: textParts.join('\n').trim(),
      mediaSpecs,
    };
  }

  private async handleInboundFrame(frame: WsFrame<BaseMessage>): Promise<void> {
    const ctx = this.ctx;
    const body = frame.body;
    if (!ctx || !body) return;

    const messageId = typeof body.msgid === 'string' ? body.msgid.trim() : '';
    if (!messageId || !this.rememberSeenMessage(messageId)) return;

    this.setStatus({ lastEventAt: Date.now() });

    const senderId = typeof body.from?.userid === 'string' ? body.from.userid.trim() : '';
    if (!senderId) return;

    const chatKind: 'p2p' | 'group' = body.chattype === 'group' ? 'group' : 'p2p';
    const chatId =
      chatKind === 'group'
        ? (typeof body.chatid === 'string' ? body.chatid.trim() : '') || senderId
        : senderId;
    if (!chatId) return;

    const { rawText, mediaSpecs } = this.extractTextAndMedia(body);
    const cleanedText = stripWeComAtMention(rawText);
    const attachments = await this.downloadMediaItems(messageId, mediaSpecs);

    if (!cleanedText && attachments.length === 0) return;

    this.rememberPendingReply(messageId, {
      frame,
      finished: false,
      receivedAt: Date.now(),
    });

    const address = formatWeComAddress(chatKind, chatId);
    const createdSec = typeof body.create_time === 'number' ? body.create_time : 0;

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      messageId,
      chatId,
      chatKind,
      chatTitle: chatKind === 'group' ? `企业微信群 ${chatId}` : senderId,
      senderId,
      senderName: senderId,
      isBotSender: false,
      // WeCom only delivers group callbacks to an AI Bot when @mentioned.
      mentionsBot: true,
      text: cleanedText || (attachments.length > 0 ? '[附件消息]' : ''),
      attachments,
      timestamp: createdSec > 0 ? createdSec * 1000 : Date.now(),
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
    const cfg = this.store.getWeComConfig();
    if (!cfg.thinkingStream || !this.client || !messageId) return undefined;

    const entry = this.pendingReplies.get(messageId);
    if (!entry || entry.finished || Date.now() - entry.receivedAt > PASSIVE_REPLY_TTL_MS) {
      return undefined;
    }

    const streamId = generateReqId('stream');
    try {
      await this.client.replyStream(entry.frame, streamId, '⏳ 正在思考…', false);
      entry.streamId = streamId;
    } catch {
      return undefined;
    }

    return async (reason?: ChannelThinkingCleanupReason) => {
      if (reason === 'replied') {
        // Leave the stream open so sendMessage() can overwrite it in-place with finish=true.
        return;
      }
      if (entry.finished) return;
      entry.finished = true;
      this.pendingReplies.delete(messageId);
      if (!this.client?.isConnected) return;
      await this.client
        .replyStream(entry.frame, streamId, '（本次响应已结束）', true)
        .catch(() => undefined);
    };
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const parsed = parseWeComAddress(payload.address);
    if (!parsed) {
      return { ok: false, error: `无效的企业微信会话地址: ${payload.address}` };
    }
    if (!this.client || !this.client.isConnected) {
      return { ok: false, error: '企业微信渠道当前未连接，请先在设置中启用并连接机器人' };
    }

    const client = this.client;
    try {
      const chunks = buildWeComOutboundMessages(payload.blocks, payload.text);
      const pending = payload.replyToMessageId
        ? this.pendingReplies.get(payload.replyToMessageId)
        : undefined;
      const canPassiveReply =
        Boolean(pending) &&
        !pending!.finished &&
        Date.now() - pending!.receivedAt < PASSIVE_REPLY_TTL_MS;

      let sentAny = false;
      let startIndex = 0;

      if (chunks.length > 0 && canPassiveReply && pending) {
        const firstChunk = chunks[0]!;
        const streamId = pending.streamId ?? generateReqId('stream');
        pending.finished = true;
        this.pendingReplies.delete(payload.replyToMessageId!);
        try {
          await client.replyStream(pending.frame, streamId, firstChunk, true);
          sentAny = true;
          startIndex = 1;
        } catch {
          // Passive frame may have expired; fall through to proactive sendMessage.
        }
      }

      for (const chunk of chunks.slice(startIndex)) {
        await client.sendMessage(parsed.targetId, {
          msgtype: 'markdown',
          markdown: { content: chunk },
        });
        sentAny = true;
      }

      if (payload.attachments?.length) {
        for (const item of payload.attachments) {
          const stat = fs.statSync(item.path, { throwIfNoEntry: false });
          if (!stat?.isFile()) continue;
          const fileName = sanitizeFileName(item.name ?? path.basename(item.path));
          const mediaType = detectWeComMediaType(fileName, stat.size);
          if (mediaType === 'too_large') {
            await client.sendMessage(parsed.targetId, {
              msgtype: 'markdown',
              markdown: { content: `📎 文件 \`${fileName}\` 超过企业微信 20MB 发送上限，请在桌面端查看。` },
            });
            continue;
          }
          const buffer = fs.readFileSync(item.path);
          const uploaded = await client.uploadMedia(buffer, {
            type: mediaType,
            filename: fileName,
          });
          await client.sendMediaMessage(parsed.targetId, uploaded.type, uploaded.media_id);
          sentAny = true;
        }
      }

      return {
        ok: sentAny || chunks.length === 0,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
