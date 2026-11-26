import * as Lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelRuntimeStatus,
  ChannelTargetView,
  ChannelView,
  ChatAttachmentRef,
  FeishuDomain,
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
  buildFeishuOutboundMessages,
  extractFeishuInboundContent,
  formatFeishuAddress,
  mapFeishuFileType,
  parseFeishuAddress,
} from './feishuFormat';

const IMAGE_UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FILE_UPLOAD_BYTES = 30 * 1024 * 1024;

function toSdkDomain(domain: FeishuDomain): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function guessMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.txt':
    case '.md':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeFileName(raw: string): string {
  const withoutControls = [...path.basename(raw)]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('');
  const base = withoutControls.replace(/[<>:"/\\|?*]/g, '_').trim();
  return base || `file-${Date.now()}`;
}

function isErrorLikeCode(code: unknown): boolean {
  return typeof code === 'number' && code !== 0;
}

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: {
    app_name?: string;
    open_id?: string;
  };
}

export class FeishuPlugin implements ChannelPlugin {
  readonly id = 'feishu';
  readonly name = '飞书 / Lark';
  readonly transport = 'socket' as const;

  private ctx: ChannelPluginContext | null = null;
  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private botOpenId: string | undefined;
  private botName: string | undefined;
  private senderNameCache = new Map<string, string>();
  private chatTitleCache = new Map<string, string>();
  private status: ChannelRuntimeStatus = {
    channelId: 'feishu',
    transport: 'socket',
    state: 'disabled',
  };

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

  private setStatus(patch: Partial<ChannelRuntimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      channelId: this.id,
      transport: this.transport,
    };
    this.ctx?.onStatusChange();
  }

  private createSdkLogger() {
    return {
      fatal: (...args: unknown[]) => console.error('[channels:feishu:sdk]', ...args),
      error: (...args: unknown[]) => console.error('[channels:feishu:sdk]', ...args),
      warn: (...args: unknown[]) => console.warn('[channels:feishu:sdk]', ...args),
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    };
  }

  private async fetchBotInfo(client: Lark.Client): Promise<{ appName?: string; openId?: string }> {
    const res = await client.request<BotInfoResponse>({
      method: 'GET',
      url: '/open-apis/bot/v3/info/',
    });
    if (isErrorLikeCode(res?.code)) {
      throw new Error(res.msg ? `飞书认证失败 (${res.code}): ${res.msg}` : `飞书认证失败 (${res.code})`);
    }
    if (!res?.bot) {
      throw new Error('未能获取到飞书机器人信息，请确认应用已开启「机器人」能力');
    }
    return {
      ...(res.bot.app_name ? { appName: res.bot.app_name } : {}),
      ...(res.bot.open_id ? { openId: res.bot.open_id } : {}),
    };
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    await this.stopClientOnly();

    const cfg = this.store.getFeishuConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.appId || !cfg.appSecret) {
      this.setStatus({
        state: 'disconnected',
        lastError: '请填写飞书 App ID 和 App Secret',
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.setStatus({
      state: 'connecting',
      lastError: undefined,
      lastErrorAt: undefined,
    });

    const sdkDomain = toSdkDomain(cfg.domain);
    const client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: sdkDomain,
      loggerLevel: Lark.LoggerLevel.warn,
      logger: this.createSdkLogger(),
    });
    this.client = client;

    try {
      const info = await this.fetchBotInfo(client);
      this.botName = info.appName;
      this.botOpenId = info.openId;
      this.setStatus({
        ...(info.appName ? { botName: info.appName } : {}),
        ...(info.openId ? { botOpenId: info.openId } : {}),
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

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        // Feishu WebSocket requires fast ACK (< 3s) or retries occur.
        void this.handleReceiveEvent(data).catch((err) => {
          console.warn('[channels:feishu] 处理入站消息失败', err);
        });
      },
    });

    const wsClient = new Lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: sdkDomain,
      autoReconnect: true,
      loggerLevel: Lark.LoggerLevel.warn,
      logger: this.createSdkLogger(),
      onReady: () => {
        if (this.wsClient !== wsClient) return;
        this.setStatus({
          state: 'connected',
          connectedAt: Date.now(),
          lastError: undefined,
          lastErrorAt: undefined,
        });
      },
      onReconnecting: () => {
        if (this.wsClient !== wsClient) return;
        this.setStatus({ state: 'reconnecting' });
      },
      onReconnected: () => {
        if (this.wsClient !== wsClient) return;
        this.setStatus({
          state: 'connected',
          connectedAt: Date.now(),
          lastError: undefined,
          lastErrorAt: undefined,
        });
      },
      onError: (err) => {
        if (this.wsClient !== wsClient) return;
        this.setStatus({
          state: 'error',
          lastError: err instanceof Error ? err.message : String(err),
          lastErrorAt: Date.now(),
        });
      },
    });
    this.wsClient = wsClient;

    try {
      await wsClient.start({ eventDispatcher });
      // Fallback if onReady fired synchronously or prior to status update.
      if (this.wsClient === wsClient && this.status.state === 'connecting') {
        const wsStatus = wsClient.getConnectionStatus();
        if (wsStatus.state === 'connected') {
          this.setStatus({
            state: 'connected',
            connectedAt: Date.now(),
            lastError: undefined,
            lastErrorAt: undefined,
          });
        }
      }
    } catch (error) {
      if (this.wsClient === wsClient) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus({
          state: 'error',
          lastError: message,
          lastErrorAt: Date.now(),
        });
      }
    }
  }

  private async stopClientOnly(): Promise<void> {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // Ignore teardown noise on socket close.
      }
      this.wsClient = null;
    }
    this.client = null;
  }

  async stop(): Promise<void> {
    await this.stopClientOnly();
    const cfg = this.store.getFeishuConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const startedAt = Date.now();
    const stored = this.store.getFeishuConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as {
      appId?: string;
      appSecret?: string;
      domain?: FeishuDomain;
    };

    const appId = (typeof patch.appId === 'string' ? patch.appId : stored.appId).trim();
    const appSecret =
      typeof patch.appSecret === 'string' && patch.appSecret.trim()
        ? patch.appSecret.trim()
        : stored.appSecret;
    const domain = patch.domain === 'lark' || patch.domain === 'feishu' ? patch.domain : stored.domain;

    if (!appId || !appSecret) {
      return {
        ok: false,
        error: '请先填写 App ID 和 App Secret',
        latencyMs: Date.now() - startedAt,
      };
    }

    const tempClient = new Lark.Client({
      appId,
      appSecret,
      domain: toSdkDomain(domain),
      loggerLevel: Lark.LoggerLevel.error,
      logger: this.createSdkLogger(),
    });

    try {
      const info = await this.fetchBotInfo(tempClient);
      return {
        ok: true,
        ...(info.appName ? { botName: info.appName } : {}),
        ...(info.openId ? { botOpenId: info.openId } : {}),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private async resolveSenderName(openId: string): Promise<string> {
    if (!openId) return '飞书用户';
    const cached = this.senderNameCache.get(openId);
    if (cached) return cached;

    const client = this.client;
    if (client) {
      try {
        const res = await client.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        const name = res?.data?.user?.name?.trim();
        if (name) {
          this.senderNameCache.set(openId, name);
          return name;
        }
      } catch {
        // Optional contact scope may not be granted; gracefully fall back.
      }
    }
    return `飞书用户 ${openId.slice(-6)}`;
  }

  private async resolveChatTitle(chatId: string, chatKind: 'p2p' | 'group', senderName: string): Promise<string> {
    if (chatKind === 'p2p') {
      return senderName;
    }
    const cached = this.chatTitleCache.get(chatId);
    if (cached) return cached;

    const client = this.client;
    if (client) {
      try {
        const res = await client.im.v1.chat.get({
          path: { chat_id: chatId },
        });
        const name = res?.data?.name?.trim();
        if (name) {
          this.chatTitleCache.set(chatId, name);
          return name;
        }
      } catch {
        // Graceful fallback if chat info fails.
      }
    }
    return `飞书群 ${chatId.slice(-6)}`;
  }

  private async downloadResources(
    messageId: string,
    resources: ReturnType<typeof extractFeishuInboundContent>['resources'],
  ): Promise<ChatAttachmentRef[]> {
    const client = this.client;
    const ctx = this.ctx;
    if (!client || !ctx || resources.length === 0) return [];

    const dir = ctx.getAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const attachments: ChatAttachmentRef[] = [];

    for (const resource of resources) {
      try {
        const resp = await client.im.v1.messageResource.get({
          path: {
            message_id: messageId,
            file_key: resource.fileKey,
          },
          params: {
            type: resource.kind === 'image' ? 'image' : 'file',
          },
        });
        const rawName =
          resource.fileName ??
          (resource.kind === 'image'
            ? `feishu-${resource.fileKey.slice(-10)}.png`
            : `feishu-${resource.fileKey.slice(-10)}.bin`);
        const safeName = sanitizeFileName(rawName);
        const idHash = createHash('sha1')
          .update(`${messageId}:${resource.fileKey}`)
          .digest('hex')
          .slice(0, 8);
        const destPath = path.join(dir, `${idHash}-${safeName}`);
        await resp.writeFile(destPath);
        const stat = fs.statSync(destPath, { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        attachments.push({
          id: `feishu-${idHash}`,
          name: safeName,
          path: destPath,
          size: stat.size,
          mimeType: guessMimeType(path.extname(safeName)),
          source: 'file',
          availability: 'available',
        });
      } catch (error) {
        console.warn('[channels:feishu] 下载入站附件失败', resource.fileKey, error);
      }
    }

    return attachments;
  }

  private async handleReceiveEvent(data: {
    sender: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type: string;
    };
    message: {
      message_id: string;
      create_time: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
        name: string;
      }>;
    };
  }): Promise<void> {
    if (!this.ctx) return;

    this.setStatus({ lastEventAt: Date.now() });

    const senderId =
      data.sender.sender_id?.open_id ??
      data.sender.sender_id?.user_id ??
      data.sender.sender_id?.union_id ??
      '';
    const isBotSender =
      data.sender.sender_type === 'app' ||
      Boolean(this.botOpenId && senderId && senderId === this.botOpenId);

    const chatKind: 'p2p' | 'group' = data.message.chat_type === 'p2p' ? 'p2p' : 'group';
    const mentions = data.message.mentions ?? [];
    const mentionsBot =
      chatKind === 'p2p' ||
      mentions.some((m) => {
        if (this.botOpenId && m.id?.open_id) {
          return m.id.open_id === this.botOpenId;
        }
        if (this.botName && m.name) {
          return m.name.trim().toLowerCase() === this.botName.trim().toLowerCase();
        }
        return false;
      });

    const parsed = extractFeishuInboundContent(
      data.message.message_type,
      data.message.content,
      mentions,
    );

    const attachments = await this.downloadResources(data.message.message_id, parsed.resources);
    if (!parsed.text && attachments.length === 0) return;

    const senderName = await this.resolveSenderName(senderId);
    const chatTitle = await this.resolveChatTitle(data.message.chat_id, chatKind, senderName);
    const address = formatFeishuAddress(data.message.chat_id);
    const createdMs = Number(data.message.create_time);

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      messageId: data.message.message_id,
      chatId: data.message.chat_id,
      chatKind,
      chatTitle,
      senderId,
      senderName,
      isBotSender,
      mentionsBot,
      text: parsed.text || (attachments.length > 0 ? '[附件消息]' : ''),
      attachments,
      timestamp: Number.isFinite(createdMs) && createdMs > 0 ? createdMs : Date.now(),
      replyTarget: {
        adapterId: this.id,
        source: 'im',
        address,
        messageId: data.message.message_id,
      },
    };

    await this.ctx.onInboundMessage(inbound);
  }

  async markThinking(messageId: string): Promise<ChannelThinkingCleanup | undefined> {
    const cfg = this.store.getFeishuConfig();
    if (!cfg.thinkingReaction || !this.client || !messageId) return undefined;

    const client = this.client;
    try {
      const res = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'THINKING' } },
      });
      const reactionId = res?.data?.reaction_id;
      if (!reactionId) return undefined;
      let cleared = false;
      return async () => {
        if (cleared) return;
        cleared = true;
        await client.im.v1.messageReaction
          .delete({
            path: {
              message_id: messageId,
              reaction_id: reactionId,
            },
          })
          .catch(() => undefined);
      };
    } catch {
      return undefined;
    }
  }

  private async dispatchMessage(
    chatId: string,
    msgType: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<string | undefined> {
    const client = this.client;
    if (!client) {
      throw new Error('飞书连接未就绪');
    }

    if (replyToMessageId) {
      try {
        const res = await client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: msgType,
            content,
          },
        });
        if (!isErrorLikeCode(res?.code)) {
          return res?.data?.message_id;
        }
      } catch {
        // Fallback to direct chat message if quoted reply fails (e.g. deleted message).
      }
    }

    const res = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
    });
    if (isErrorLikeCode(res?.code)) {
      throw new Error(res.msg ? `飞书发送失败 (${res.code}): ${res.msg}` : `飞书发送失败 (${res.code})`);
    }
    return res?.data?.message_id;
  }

  private async uploadAndSendAttachment(
    chatId: string,
    filePath: string,
    displayName?: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;

    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size <= 0) return;

    const fileName = sanitizeFileName(displayName ?? path.basename(filePath));
    const ext = path.extname(fileName).toLowerCase();

    if (IMAGE_UPLOAD_EXTS.has(ext) && stat.size <= MAX_IMAGE_UPLOAD_BYTES) {
      const uploaded = await client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      if (uploaded?.image_key) {
        await this.dispatchMessage(
          chatId,
          'image',
          JSON.stringify({ image_key: uploaded.image_key }),
          replyToMessageId,
        );
        return;
      }
    }

    if (stat.size <= MAX_FILE_UPLOAD_BYTES) {
      const uploaded = await client.im.v1.file.create({
        data: {
          file_type: mapFeishuFileType(fileName),
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      if (uploaded?.file_key) {
        await this.dispatchMessage(
          chatId,
          'file',
          JSON.stringify({ file_key: uploaded.file_key }),
          replyToMessageId,
        );
      }
    }
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const chatId = parseFeishuAddress(payload.address);
    if (!chatId) {
      return { ok: false, error: `无效的飞书会话地址: ${payload.address}` };
    }
    if (!this.client) {
      return { ok: false, error: '飞书渠道当前未连接，请先在设置中启用并连接飞书机器人' };
    }

    try {
      let lastMessageId: string | undefined;
      const specs = buildFeishuOutboundMessages(payload.blocks, payload.text);
      for (let i = 0; i < specs.length; i += 1) {
        const spec = specs[i];
        if (!spec) continue;
        const msgId = await this.dispatchMessage(
          chatId,
          spec.msgType,
          spec.content,
          i === 0 ? payload.replyToMessageId : undefined,
        );
        if (msgId) lastMessageId = msgId;
      }

      if (payload.attachments?.length) {
        for (const item of payload.attachments) {
          await this.uploadAndSendAttachment(
            chatId,
            item.path,
            item.name,
            specs.length === 0 ? payload.replyToMessageId : undefined,
          );
        }
      }

      return {
        ok: true,
        ...(lastMessageId ? { messageId: lastMessageId } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
