import { DWClient, EventAck, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
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
} from '../types';
import { DingTalkApi } from './dingtalkApi';
import {
  buildDingTalkOutboundMessages,
  extractDingTalkInboundContent,
  formatDingTalkAddress,
  parseDingTalkAddress,
  type DingTalkInboundResource,
  type DingTalkRobotPayload,
} from './dingtalkFormat';

const IMAGE_UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
const MAX_SESSION_WEBHOOKS = 200;
const WEBHOOK_EXPIRY_BUFFER_MS = 30 * 1000;
const STATUS_POLL_INTERVAL_MS = 3000;

interface CachedWebhook {
  url: string;
  expiresAt: number;
}

interface RawDingTalkRobotEvent extends DingTalkRobotPayload {
  conversationId?: string;
  conversationType?: string;
  conversationTitle?: string;
  chatbotCorpId?: string;
  chatbotUserId?: string;
  msgId?: string;
  senderNick?: string;
  senderStaffId?: string;
  senderId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  createAt?: number;
  robotCode?: string;
  isInAtList?: boolean;
}

function guessMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.amr':
      return 'audio/amr';
    case '.mp4':
      return 'video/mp4';
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

export class DingTalkPlugin implements ChannelPlugin {
  readonly id = 'dingtalk' as const;
  readonly name = '钉钉 / DingTalk';
  readonly transport = 'socket' as const;

  private ctx: ChannelPluginContext | null = null;
  private api: DingTalkApi | null = null;
  private dwClient: DWClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionWebhooks = new Map<string, CachedWebhook>();
  private status: ChannelRuntimeStatus = {
    channelId: 'dingtalk',
    transport: 'socket',
    state: 'disabled',
  };

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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.dwClient) {
      try {
        this.dwClient.disconnect();
      } catch {
        // Ignore teardown errors when closing DingTalk Stream socket.
      }
      this.dwClient = null;
    }
    this.api = null;
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    this.stopClientOnly();

    const cfg = this.store.getDingTalkConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.clientId || !cfg.clientSecret) {
      this.setStatus({
        state: 'disconnected',
        lastError: '请填写钉钉 Client ID (AppKey) 和 Client Secret (AppSecret)',
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.setStatus({
      state: 'connecting',
      lastError: undefined,
      lastErrorAt: undefined,
    });

    const api = new DingTalkApi({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    });
    this.api = api;

    try {
      await api.getAccessToken(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        state: 'error',
        lastError: message,
        lastErrorAt: Date.now(),
      });
      return;
    }

    const client = new DWClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      keepAlive: true,
      debug: false,
    });
    this.dwClient = client;

    client.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      // Immediately acknowledge receipt so DingTalk gateway does not retry delivery.
      try {
        client.socketCallBackResponse(res.headers.messageId, { status: EventAck.SUCCESS });
      } catch {
        // Ignore ack write failures on closing socket.
      }
      void this.handleRobotEvent(res).catch((err) => {
        console.warn('[channels:dingtalk] 处理入站消息失败', err);
      });
    });

    // DWClient swallows internal connect/reconnect transitions rather than emitting events;
    // monitor its connection flags lightly so Settings reflects live Stream status.
    this.pollTimer = setInterval(() => {
      if (this.dwClient !== client) return;
      if (client.connected && this.status.state !== 'connected') {
        this.setStatus({
          state: 'connected',
          connectedAt: Date.now(),
          lastError: undefined,
          lastErrorAt: undefined,
        });
      } else if (!client.connected && client.reconnecting && this.status.state !== 'reconnecting') {
        this.setStatus({ state: 'reconnecting' });
      }
    }, STATUS_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();

    try {
      await client.connect();
      if (this.dwClient !== client) return;
      if (client.connected) {
        this.setStatus({
          state: 'connected',
          connectedAt: Date.now(),
          botName: cfg.robotCode || cfg.clientId,
          lastError: undefined,
          lastErrorAt: undefined,
        });
      } else {
        this.setStatus({
          state: client.reconnecting ? 'reconnecting' : 'error',
          lastError: '未能建立钉钉 Stream 长连接，请确认应用已开启「机器人」与「Stream 模式」并已发布',
          lastErrorAt: Date.now(),
        });
      }
    } catch (error) {
      if (this.dwClient === client) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus({
          state: 'error',
          lastError: message,
          lastErrorAt: Date.now(),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopClientOnly();
    const cfg = this.store.getDingTalkConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const stored = this.store.getDingTalkConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const clientId = (typeof patch.clientId === 'string' ? patch.clientId : stored.clientId).trim();
    const clientSecret =
      typeof patch.clientSecret === 'string' && patch.clientSecret.trim()
        ? patch.clientSecret.trim()
        : stored.clientSecret;
    const robotCode = (
      typeof patch.robotCode === 'string' ? patch.robotCode : stored.robotCode
    ).trim();

    if (!clientId || !clientSecret) {
      return {
        ok: false,
        error: '请先填写 Client ID (AppKey) 和 Client Secret (AppSecret)',
        latencyMs: 0,
      };
    }

    const tempApi = new DingTalkApi({ clientId, clientSecret });
    const verified = await tempApi.verifyConnection();
    return {
      ok: verified.ok,
      ...(verified.ok ? { botName: robotCode || clientId } : {}),
      ...(verified.error ? { error: verified.error } : {}),
      latencyMs: verified.latencyMs,
    };
  }

  private rememberSessionWebhook(address: string, webhookUrl?: string, expiresAt?: number): void {
    if (!webhookUrl) return;
    if (this.sessionWebhooks.size >= MAX_SESSION_WEBHOOKS && !this.sessionWebhooks.has(address)) {
      const oldestKey = this.sessionWebhooks.keys().next().value;
      if (oldestKey) this.sessionWebhooks.delete(oldestKey);
    }
    const validUntil =
      typeof expiresAt === 'number' && expiresAt > Date.now()
        ? expiresAt
        : Date.now() + 90 * 60 * 1000;
    this.sessionWebhooks.set(address, { url: webhookUrl, expiresAt: validUntil });
  }

  private async downloadResources(
    messageId: string,
    robotCode: string,
    resources: DingTalkInboundResource[],
  ): Promise<ChatAttachmentRef[]> {
    const api = this.api;
    const ctx = this.ctx;
    if (!api || !ctx || resources.length === 0) return [];

    const dir = ctx.getAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const attachments: ChatAttachmentRef[] = [];

    for (const res of resources) {
      try {
        const rawName =
          res.fileName ??
          (res.kind === 'image'
            ? `dingtalk-${res.downloadCode.slice(-8)}.png`
            : `dingtalk-${res.downloadCode.slice(-8)}.bin`);
        const safeName = sanitizeFileName(rawName);
        const idHash = createHash('sha1')
          .update(`${messageId}:${res.downloadCode}`)
          .digest('hex')
          .slice(0, 8);
        const destPath = path.join(dir, `${idHash}-${safeName}`);
        const { size } = await api.downloadMessageFile({
          downloadCode: res.downloadCode,
          robotCode,
          destPath,
        });
        attachments.push({
          id: `dingtalk-${idHash}`,
          name: safeName,
          path: destPath,
          size,
          mimeType: guessMimeType(path.extname(safeName)),
          source: 'file',
          availability: 'available',
        });
      } catch (error) {
        console.warn('[channels:dingtalk] 下载入站附件失败', error);
      }
    }

    return attachments;
  }

  private async handleRobotEvent(downstream: DWClientDownStream): Promise<void> {
    if (!this.ctx) return;

    this.setStatus({ lastEventAt: Date.now() });

    let payload: RawDingTalkRobotEvent;
    try {
      payload = JSON.parse(downstream.data) as RawDingTalkRobotEvent;
    } catch {
      return;
    }

    const senderId = (payload.senderStaffId ?? payload.senderId ?? '').trim();
    if (!senderId) return;

    const chatKind: 'p2p' | 'group' = payload.conversationType === '2' ? 'group' : 'p2p';
    const conversationId = (payload.conversationId ?? '').trim();
    if (chatKind === 'group' && !conversationId) return;

    const isBotSender = Boolean(payload.chatbotUserId && payload.senderId === payload.chatbotUserId);
    const mentionsBot = chatKind === 'p2p' || payload.isInAtList !== false;

    const cfg = this.store.getDingTalkConfig();
    const robotCode = (payload.robotCode ?? cfg.robotCode ?? cfg.clientId).trim();
    const messageId = payload.msgId || downstream.headers.messageId;
    const address =
      chatKind === 'p2p'
        ? formatDingTalkAddress('p2p', senderId)
        : formatDingTalkAddress('group', conversationId);

    this.rememberSessionWebhook(address, payload.sessionWebhook, payload.sessionWebhookExpiredTime);

    const parsed = extractDingTalkInboundContent(payload);
    const attachments = await this.downloadResources(messageId, robotCode, parsed.resources);
    if (!parsed.text && attachments.length === 0) return;

    const senderName = payload.senderNick?.trim() || `钉钉用户 ${senderId.slice(-6)}`;
    const chatTitle =
      chatKind === 'group'
        ? payload.conversationTitle?.trim() || `钉钉群 ${conversationId.slice(-6)}`
        : senderName;

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      messageId,
      chatId: chatKind === 'group' ? conversationId : senderId,
      chatKind,
      chatTitle,
      senderId,
      senderName,
      isBotSender,
      mentionsBot,
      text: parsed.text || (attachments.length > 0 ? '[附件消息]' : ''),
      attachments,
      timestamp:
        typeof payload.createAt === 'number' && payload.createAt > 0 ? payload.createAt : Date.now(),
      replyTarget: {
        adapterId: this.id,
        source: 'im',
        address,
        messageId,
      },
    };

    await this.ctx.onInboundMessage(inbound);
  }

  private getFreshWebhook(address: string): string | null {
    const cached = this.sessionWebhooks.get(address);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now() + WEBHOOK_EXPIRY_BUFFER_MS) {
      this.sessionWebhooks.delete(address);
      return null;
    }
    return cached.url;
  }

  private async sendOpenApiSpec(
    target: { chatKind: 'p2p'; staffId: string } | { chatKind: 'group'; openConversationId: string },
    msgKey: string,
    msgParam: Record<string, unknown>,
  ): Promise<string | undefined> {
    const api = this.api;
    if (!api) throw new Error('钉钉连接未就绪');
    const cfg = this.store.getDingTalkConfig();
    const robotCode = cfg.robotCode || cfg.clientId;
    if (!robotCode) throw new Error('缺少钉钉 RobotCode / Client ID');

    if (target.chatKind === 'p2p') {
      return api.sendDirectMessage({
        robotCode,
        staffId: target.staffId,
        msgKey,
        msgParam,
      });
    }
    return api.sendGroupMessage({
      robotCode,
      openConversationId: target.openConversationId,
      msgKey,
      msgParam,
    });
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const parsedTarget = parseDingTalkAddress(payload.address);
    if (!parsedTarget) {
      return { ok: false, error: `无效的钉钉会话地址: ${payload.address}` };
    }
    if (!this.api) {
      return { ok: false, error: '钉钉渠道当前未连接，请先在设置中启用并连接钉钉机器人' };
    }

    try {
      let lastMessageId: string | undefined;
      const specs = buildDingTalkOutboundMessages(payload.blocks, payload.text);
      const webhookUrl = this.getFreshWebhook(payload.address);

      for (const spec of specs) {
        let sentViaWebhook = false;
        if (webhookUrl) {
          try {
            await this.api.sendViaSessionWebhook(webhookUrl, spec);
            sentViaWebhook = true;
          } catch {
            this.sessionWebhooks.delete(payload.address);
          }
        }
        if (!sentViaWebhook) {
          const msgKey = spec.msgType === 'markdown' ? 'sampleMarkdown' : 'sampleText';
          const msgParam =
            spec.msgType === 'markdown'
              ? { title: spec.title, text: spec.text }
              : { content: spec.text };
          const id = await this.sendOpenApiSpec(parsedTarget, msgKey, msgParam);
          if (id) lastMessageId = id;
        }
      }

      if (payload.attachments?.length) {
        for (const item of payload.attachments) {
          const fileName = sanitizeFileName(item.name ?? path.basename(item.path));
          const ext = path.extname(fileName).toLowerCase();
          const isImage = IMAGE_UPLOAD_EXTS.has(ext);
          const mediaId = await this.api.uploadMedia({
            filePath: item.path,
            fileName,
            kind: isImage ? 'image' : 'file',
          });
          if (isImage) {
            const id = await this.sendOpenApiSpec(parsedTarget, 'sampleImageMsg', {
              photoURL: mediaId,
            });
            if (id) lastMessageId = id;
          } else {
            const fileType = ext.startsWith('.') ? ext.slice(1) : 'bin';
            const id = await this.sendOpenApiSpec(parsedTarget, 'sampleFile', {
              mediaId,
              fileName,
              fileType: fileType || 'bin',
            });
            if (id) lastMessageId = id;
          }
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
