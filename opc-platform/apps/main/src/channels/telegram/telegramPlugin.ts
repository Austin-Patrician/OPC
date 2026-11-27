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
import {
  normalizeTelegramApiBaseUrl,
  TelegramApi,
  TelegramApiError,
  type TelegramMessage,
  type TelegramUser,
} from './telegramApi';
import {
  buildTelegramOutboundMessages,
  detectTelegramMediaMethod,
  formatTelegramAddress,
  hasTelegramBotMention,
  parseTelegramAddress,
  stripTelegramBotMention,
} from './telegramFormat';

const MAX_SEEN_MESSAGES = 500;
const MAX_MESSAGE_META = 500;
const POLL_TIMEOUT_SEC = 25;
const POLL_SAFETY_MS = 35_000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const TYPING_INTERVAL_MS = 4000;
const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;

interface MessageMeta {
  chatId: string;
  topicId?: number;
  messageId: number;
}

interface MediaSpec {
  fileId: string;
  fallbackName: string;
  mimeType?: string;
  fileSize?: number;
}

function sanitizeFileName(raw: string): string {
  const withoutControls = [...path.basename(raw)]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('');
  const base = withoutControls.replace(/[<>:"/\\|?*]/g, '_').trim();
  return base || `file-${Date.now()}`;
}

function formatDisplayName(user?: TelegramUser): string {
  if (!user) return 'Telegram User';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (user.username) return `@${user.username}`;
  return String(user.id);
}

export class TelegramPlugin implements ChannelPlugin {
  readonly id = 'telegram' as const;
  readonly name = 'Telegram';
  readonly transport = 'polling' as const;

  private ctx: ChannelPluginContext | null = null;
  private api: TelegramApi | null = null;
  private botId: number | undefined;
  private botUsername: string | undefined;
  private activeRunId = 0;
  private pollAbort: AbortController | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffResolve: (() => void) | null = null;
  private nextOffset: number | undefined;
  private seenMessages = new Set<string>();
  private messageMeta = new Map<string, MessageMeta>();
  private status: ChannelRuntimeStatus = {
    channelId: 'telegram',
    transport: 'polling',
    state: 'disabled',
  };

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

  private setStatus(patch: Partial<ChannelRuntimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      channelId: this.id,
      transport: this.transport,
    };
    this.ctx?.onStatusChange();
  }

  private stopPollingOnly(): void {
    this.activeRunId += 1;
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.backoffResolve) {
      const resolve = this.backoffResolve;
      this.backoffResolve = null;
      resolve();
    }
    this.api = null;
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    this.stopPollingOnly();

    const cfg = this.store.getTelegramConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.botToken) {
      this.setStatus({
        state: 'disconnected',
        lastError: '请填写从 @BotFather 获取的 Telegram Bot Token',
        lastErrorAt: Date.now(),
      });
      return;
    }

    let api: TelegramApi;
    try {
      api = new TelegramApi({
        botToken: cfg.botToken,
        apiBaseUrl: cfg.apiBaseUrl,
      });
    } catch (error) {
      this.setStatus({
        state: 'error',
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.api = api;
    const runId = this.activeRunId;
    this.setStatus({
      state: 'connecting',
      lastError: undefined,
      lastErrorAt: undefined,
    });

    try {
      const me = await api.getMe();
      if (this.activeRunId !== runId) return;
      this.botId = me.id;
      this.botUsername = me.username;
      const botLabel = me.username
        ? `@${me.username}${me.first_name ? ` (${me.first_name})` : ''}`
        : me.first_name;

      // Remove any stale Webhook before switching to Long Polling to prevent 409 Conflict.
      await api.deleteWebhook(false).catch(() => undefined);
      if (this.activeRunId !== runId) return;

      this.setStatus({
        state: 'connected',
        botName: botLabel,
        botOpenId: String(me.id),
        connectedAt: Date.now(),
        lastError: undefined,
        lastErrorAt: undefined,
      });
    } catch (error) {
      if (this.activeRunId !== runId) return;
      this.setStatus({
        state: 'error',
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorAt: Date.now(),
      });
      return;
    }

    void this.pollLoop(runId, api);
  }

  async stop(): Promise<void> {
    this.stopPollingOnly();
    const cfg = this.store.getTelegramConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const stored = this.store.getTelegramConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const botToken =
      typeof patch.botToken === 'string' && patch.botToken.trim()
        ? patch.botToken.trim()
        : stored.botToken;
    const apiBaseUrl =
      typeof patch.apiBaseUrl === 'string' ? patch.apiBaseUrl.trim() : stored.apiBaseUrl;

    if (!botToken) {
      return {
        ok: false,
        error: '请先填写从 @BotFather 获取的 Bot Token',
        latencyMs: 0,
      };
    }

    try {
      normalizeTelegramApiBaseUrl(apiBaseUrl);
      const tempApi = new TelegramApi({ botToken, apiBaseUrl });
      return tempApi.verifyConnection();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: 0,
      };
    }
  }

  private waitBackoff(runId: number, delayMs: number): Promise<void> {
    if (this.activeRunId !== runId) return Promise.resolve();
    return new Promise((resolve) => {
      this.backoffResolve = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.backoffResolve = null;
        resolve();
      }, delayMs);
      this.backoffTimer.unref?.();
    });
  }

  private async pollLoop(runId: number, api: TelegramApi): Promise<void> {
    let attempts = 0;

    while (this.activeRunId === runId) {
      const controller = new AbortController();
      this.pollAbort = controller;
      const safetyTimer = setTimeout(() => controller.abort(), POLL_SAFETY_MS);
      safetyTimer.unref?.();

      try {
        const updates = await api.getUpdates({
          ...(typeof this.nextOffset === 'number' ? { offset: this.nextOffset } : {}),
          timeoutSec: POLL_TIMEOUT_SEC,
          allowedUpdates: ['message'],
          signal: controller.signal,
        });

        clearTimeout(safetyTimer);
        if (this.activeRunId !== runId) return;

        attempts = 0;
        if (this.status.state !== 'connected') {
          this.setStatus({
            state: 'connected',
            connectedAt: Date.now(),
            lastError: undefined,
            lastErrorAt: undefined,
          });
        }

        for (const update of updates) {
          this.nextOffset = Math.max(this.nextOffset ?? 0, update.update_id + 1);
          if (update.message) {
            await this.handleTelegramMessage(update.message).catch((err) => {
              console.warn('[channels:telegram] 处理入站消息失败', err);
            });
          }
        }
      } catch (error) {
        clearTimeout(safetyTimer);
        if (this.activeRunId !== runId) return;

        // Ignore self-triggered abort from stopPollingOnly; only treat unexpected timeouts as retryable.
        const isConflict =
          error instanceof TelegramApiError && (error.errorCode === 409 || error.status === 409);
        const errorMsg = isConflict
          ? '检测到同一 Bot Token 正在别处轮询（409 Conflict），请确认未在其他设备或服务端重复运行。'
          : error instanceof Error && error.name === 'AbortError'
            ? 'Telegram 长轮询响应超时，正在重连…'
            : error instanceof Error
              ? error.message
              : String(error);

        this.setStatus({
          state: isConflict ? 'error' : 'reconnecting',
          lastError: errorMsg,
          lastErrorAt: Date.now(),
        });

        const delay = Math.min(
          BASE_BACKOFF_MS * 2 ** attempts + Math.floor(Math.random() * 400),
          MAX_BACKOFF_MS,
        );
        attempts += 1;
        await this.waitBackoff(runId, delay);
      } finally {
        if (this.pollAbort === controller) {
          this.pollAbort = null;
        }
      }
    }
  }

  private rememberSeenMessage(key: string): boolean {
    if (this.seenMessages.has(key)) return false;
    if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }
    this.seenMessages.add(key);
    return true;
  }

  private rememberMessageMeta(key: string, meta: MessageMeta): void {
    if (this.messageMeta.size >= MAX_MESSAGE_META && !this.messageMeta.has(key)) {
      const oldest = this.messageMeta.keys().next().value;
      if (oldest) this.messageMeta.delete(oldest);
    }
    this.messageMeta.set(key, meta);
  }

  private collectInboundMedia(msg: TelegramMessage): MediaSpec[] {
    const specs: MediaSpec[] = [];
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      if (largest) {
        specs.push({
          fileId: largest.file_id,
          fallbackName: `tg-photo-${msg.message_id}.jpg`,
          mimeType: 'image/jpeg',
          ...(largest.file_size ? { fileSize: largest.file_size } : {}),
        });
      }
    }
    if (msg.document) {
      specs.push({
        fileId: msg.document.file_id,
        fallbackName: msg.document.file_name || `tg-doc-${msg.message_id}`,
        ...(msg.document.mime_type ? { mimeType: msg.document.mime_type } : {}),
        ...(msg.document.file_size ? { fileSize: msg.document.file_size } : {}),
      });
    }
    if (msg.audio) {
      specs.push({
        fileId: msg.audio.file_id,
        fallbackName: msg.audio.file_name || `tg-audio-${msg.message_id}.mp3`,
        mimeType: msg.audio.mime_type || 'audio/mpeg',
        ...(msg.audio.file_size ? { fileSize: msg.audio.file_size } : {}),
      });
    }
    if (msg.voice) {
      specs.push({
        fileId: msg.voice.file_id,
        fallbackName: `tg-voice-${msg.message_id}.ogg`,
        mimeType: msg.voice.mime_type || 'audio/ogg',
        ...(msg.voice.file_size ? { fileSize: msg.voice.file_size } : {}),
      });
    }
    if (msg.video) {
      specs.push({
        fileId: msg.video.file_id,
        fallbackName: msg.video.file_name || `tg-video-${msg.message_id}.mp4`,
        mimeType: msg.video.mime_type || 'video/mp4',
        ...(msg.video.file_size ? { fileSize: msg.video.file_size } : {}),
      });
    }
    if (msg.animation) {
      specs.push({
        fileId: msg.animation.file_id,
        fallbackName: msg.animation.file_name || `tg-anim-${msg.message_id}.mp4`,
        mimeType: msg.animation.mime_type || 'video/mp4',
        ...(msg.animation.file_size ? { fileSize: msg.animation.file_size } : {}),
      });
    }
    return specs;
  }

  private async downloadMediaItems(
    messageKey: string,
    specs: MediaSpec[],
  ): Promise<ChatAttachmentRef[]> {
    const api = this.api;
    const ctx = this.ctx;
    if (!api || !ctx || specs.length === 0) return [];

    const dir = ctx.getAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const attachments: ChatAttachmentRef[] = [];

    for (const spec of specs) {
      if (spec.fileSize && spec.fileSize > MAX_INBOUND_FILE_BYTES) {
        console.warn(`[channels:telegram] 跳过超过 20MB 的入站文件: ${spec.fallbackName}`);
        continue;
      }
      try {
        const safeName = sanitizeFileName(spec.fallbackName);
        const idHash = createHash('sha1')
          .update(`${messageKey}:${spec.fileId}`)
          .digest('hex')
          .slice(0, 8);
        const destPath = path.join(dir, `${idHash}-${safeName}`);
        const { size } = await api.downloadFile(spec.fileId, destPath);
        attachments.push({
          id: `tg-${idHash}`,
          name: safeName,
          path: destPath,
          size,
          ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
          source: 'file',
          availability: 'available',
        });
      } catch (error) {
        console.warn('[channels:telegram] 下载入站附件失败', error);
      }
    }

    return attachments;
  }

  private async handleTelegramMessage(msg: TelegramMessage): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    if (!msg.from || msg.from.is_bot) return;
    if (this.botId && msg.from.id === this.botId) return;

    const chatId = String(msg.chat.id);
    const messageKey = `${chatId}:${msg.message_id}`;
    if (!this.rememberSeenMessage(messageKey)) return;

    this.setStatus({ lastEventAt: Date.now() });

    const chatKind: 'p2p' | 'group' = msg.chat.type === 'private' ? 'p2p' : 'group';
    const topicId =
      msg.is_topic_message && typeof msg.message_thread_id === 'number' && msg.message_thread_id > 0
        ? msg.message_thread_id
        : undefined;

    const rawText = (msg.text ?? msg.caption ?? '').trim();
    const entities = msg.entities ?? msg.caption_entities;
    const repliedToBot = Boolean(this.botId && msg.reply_to_message?.from?.id === this.botId);
    const mentionsBot =
      chatKind === 'p2p' ||
      repliedToBot ||
      hasTelegramBotMention(rawText, entities, this.botUsername);

    const cleanedText = stripTelegramBotMention(rawText, this.botUsername);
    const mediaSpecs = this.collectInboundMedia(msg);
    const attachments = await this.downloadMediaItems(messageKey, mediaSpecs);
    if (!cleanedText && attachments.length === 0) return;

    this.rememberMessageMeta(messageKey, {
      chatId,
      ...(topicId ? { topicId } : {}),
      messageId: msg.message_id,
    });

    const senderName = formatDisplayName(msg.from);
    const chatTitle =
      chatKind === 'p2p' ? senderName : msg.chat.title?.trim() || chatId;
    const address = formatTelegramAddress(chatId, topicId);

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      messageId: messageKey,
      chatId,
      chatKind,
      chatTitle,
      senderId: String(msg.from.id),
      senderName,
      isBotSender: false,
      mentionsBot,
      text: cleanedText || (attachments.length > 0 ? '[附件消息]' : ''),
      attachments,
      timestamp: msg.date > 0 ? msg.date * 1000 : Date.now(),
      replyTarget: {
        adapterId: this.id,
        source: 'im',
        address,
        messageId: messageKey,
      },
    };

    await ctx.onInboundMessage(inbound);
  }

  async markThinking(messageId: string): Promise<ChannelThinkingCleanup | undefined> {
    const cfg = this.store.getTelegramConfig();
    if (!cfg.typingAction || !this.api || !messageId) return undefined;

    const meta = this.messageMeta.get(messageId);
    if (!meta) return undefined;

    const api = this.api;
    const sendTyping = () => {
      void api
        .sendChatAction({
          chatId: meta.chatId,
          action: 'typing',
          ...(meta.topicId ? { topicId: meta.topicId } : {}),
        })
        .catch(() => undefined);
    };

    sendTyping();
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);
    timer.unref?.();

    let cleared = false;
    return async () => {
      if (cleared) return;
      cleared = true;
      clearInterval(timer);
    };
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const parsed = parseTelegramAddress(payload.address);
    if (!parsed) {
      return { ok: false, error: `无效的 Telegram 会话地址: ${payload.address}` };
    }
    if (!this.api) {
      return { ok: false, error: 'Telegram 渠道当前未连接，请先在设置中启用并连接 Bot' };
    }

    const api = this.api;
    try {
      const meta = payload.replyToMessageId
        ? this.messageMeta.get(payload.replyToMessageId)
        : undefined;
      const replyToId = meta && meta.chatId === parsed.chatId ? meta.messageId : undefined;

      const chunks = buildTelegramOutboundMessages(payload.blocks, payload.text);
      let lastMessageId: number | undefined;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
        const msgId = await api.sendMessage({
          chatId: parsed.chatId,
          html: chunk.html,
          plain: chunk.plain,
          ...(parsed.topicId ? { topicId: parsed.topicId } : {}),
          ...(i === 0 && replyToId ? { replyToMessageId: replyToId } : {}),
        });
        lastMessageId = msgId;
      }

      if (payload.attachments?.length) {
        for (const item of payload.attachments) {
          const stat = fs.statSync(item.path, { throwIfNoEntry: false });
          if (!stat?.isFile()) continue;
          const fileName = sanitizeFileName(item.name ?? path.basename(item.path));
          const method = detectTelegramMediaMethod(fileName, stat.size);
          if (method === 'too_large') {
            const plain = `📎 文件 ${fileName} 超过 Telegram 50MB 发送上限，请在桌面端查看。`;
            await api.sendMessage({
              chatId: parsed.chatId,
              html: plain,
              plain,
              ...(parsed.topicId ? { topicId: parsed.topicId } : {}),
            });
            continue;
          }
          const msgId = await api.uploadMedia({
            chatId: parsed.chatId,
            method,
            filePath: item.path,
            fileName,
            ...(parsed.topicId ? { topicId: parsed.topicId } : {}),
          });
          lastMessageId = msgId;
        }
      }

      return {
        ok: true,
        ...(lastMessageId ? { messageId: `${parsed.chatId}:${lastMessageId}` } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
