import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelTargetView,
  ChannelView,
  ChatContentBlock,
  DingTalkChannelSettingsPatch,
  FeishuChannelSettingsPatch,
  GitHubChannelSettingsPatch,
  GitHubRepoListResult,
  MessageChannelMeta,
  RouterResponse,
  SlackChannelSettingsPatch,
  TelegramChannelSettingsPatch,
  TriggerReplyTarget,
  WeComChannelSettingsPatch,
} from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';
import { evaluateChannelAccess } from './accessGuard';
import { extractArtifactsFromBlocks } from './blockArtifacts';
import type { ChannelStore } from './store';
import type {
  ChannelInboundMessage,
  ChannelOutboundAttachment,
  ChannelPlugin,
  ChannelThinkingCleanup,
  ChannelThinkingCleanupReason,
} from './types';

export interface ChannelChatMirror {
  appendMirroredUserMessage(input: {
    text: string;
    attachments?: ChannelInboundMessage['attachments'];
    channelMeta: MessageChannelMeta;
  }): void;
  appendMirroredAssistantMessage(input: {
    text: string;
    content?: ChatContentBlock[];
    channelMeta: MessageChannelMeta;
  }): void;
}

export interface ChannelManagerDeps {
  store: ChannelStore;
  threads: Pick<ThreadRepository, 'enqueueOnce'>;
  chat?: ChannelChatMirror;
  attachmentsDir: string;
  /** Optional containment roots for proactive file sends (e.g. workspaceDir, attachmentsDir). */
  allowedFileRoots?: string[];
  onAcceptedEvent?: () => void;
  resolveTaskArtifactPath?: (taskId: string | undefined, relPath: string) => string | null;
  onPairingRequest?: (request: ChannelPairingRequest, channelName: string) => void;
}

interface PendingThinkingEntry {
  cleanup: ChannelThinkingCleanup;
  timer: ReturnType<typeof setTimeout>;
}

const THINKING_TIMEOUT_MS = 3 * 60 * 1000;

export class ChannelManager {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly listeners = new Set<() => void>();
  private readonly pendingThinking = new Map<string, PendingThinkingEntry>();
  private started = false;

  constructor(private readonly deps: ChannelManagerDeps) {}

  registerPlugin(plugin: ChannelPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private buildPluginContext() {
    return {
      onInboundMessage: (msg: ChannelInboundMessage) => this.handleInbound(msg),
      getAttachmentsDir: () => this.deps.attachmentsDir,
      onStatusChange: () => this.emitChanged(),
    };
  }

  async startEnabled(): Promise<void> {
    this.started = true;
    const ctx = this.buildPluginContext();
    await Promise.all(
      [...this.plugins.values()].map((plugin) =>
        plugin.start(ctx).catch((err) => {
          console.warn(`[channels] 启动渠道 ${plugin.id} 失败`, err);
        }),
      ),
    );
    this.emitChanged();
  }

  async stopAll(): Promise<void> {
    this.started = false;
    for (const entry of this.pendingThinking.values()) {
      clearTimeout(entry.timer);
      await entry.cleanup('cancelled').catch(() => undefined);
    }
    this.pendingThinking.clear();
    await Promise.all(
      [...this.plugins.values()].map((plugin) => plugin.stop().catch(() => undefined)),
    );
    this.emitChanged();
  }

  async onSystemResume(): Promise<void> {
    if (!this.started) return;
    for (const plugin of this.plugins.values()) {
      if (plugin.isEnabled()) {
        await plugin.reconnect().catch((err) => {
          console.warn(`[channels] 系统唤醒后重连 ${plugin.id} 失败`, err);
        });
      }
    }
    this.emitChanged();
  }

  listViews(): ChannelView[] {
    return [...this.plugins.values()].map((plugin) =>
      plugin.toChannelView({
        pendingPairings: this.deps.store.listPairings(plugin.id),
        knownTargets: this.deps.store.listTargets(plugin.id),
      }),
    );
  }

  listTargets(channelId?: string): ChannelTargetView[] {
    return this.deps.store.listTargets(channelId);
  }

  async updateFeishu(patch: FeishuChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged } = this.deps.store.updateFeishuConfig(patch);
    const feishu = this.plugins.get('feishu');
    if (feishu && connectionChanged && this.started) {
      await feishu.start(this.buildPluginContext());
    }
    this.emitChanged();
    return this.listViews();
  }

  async updateDingTalk(patch: DingTalkChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged } = this.deps.store.updateDingTalkConfig(patch);
    const dingtalk = this.plugins.get('dingtalk');
    if (dingtalk && connectionChanged && this.started) {
      await dingtalk.start(this.buildPluginContext());
    }
    this.emitChanged();
    return this.listViews();
  }

  async updateSlack(patch: SlackChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged } = this.deps.store.updateSlackConfig(patch);
    const slack = this.plugins.get('slack');
    if (slack && connectionChanged && this.started) {
      await slack.start(this.buildPluginContext());
    }
    this.emitChanged();
    return this.listViews();
  }

  async updateWeCom(patch: WeComChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged } = this.deps.store.updateWeComConfig(patch);
    const wecom = this.plugins.get('wecom');
    if (wecom && connectionChanged && this.started) {
      await wecom.start(this.buildPluginContext());
    }
    this.emitChanged();
    return this.listViews();
  }

  async updateTelegram(patch: TelegramChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged } = this.deps.store.updateTelegramConfig(patch);
    const telegram = this.plugins.get('telegram');
    if (telegram && connectionChanged && this.started) {
      await telegram.start(this.buildPluginContext());
    }
    this.emitChanged();
    return this.listViews();
  }

  async updateGitHub(patch: GitHubChannelSettingsPatch): Promise<ChannelView[]> {
    const { connectionChanged, watchReposChanged } = this.deps.store.updateGitHubConfig(patch);
    const github = this.plugins.get('github');
    if (github && this.started) {
      if (connectionChanged) {
        await github.start(this.buildPluginContext());
      } else if (watchReposChanged) {
        github.refreshWatchRepos?.();
      }
    }
    this.emitChanged();
    return this.listViews();
  }

  async testConnection(
    channelId: string,
    draft?: unknown,
  ): Promise<ChannelConnectionTestResult> {
    const plugin = this.plugins.get(channelId);
    if (!plugin) {
      return { ok: false, error: `未知渠道: ${channelId}`, latencyMs: 0 };
    }
    return plugin.testConnection(draft);
  }

  async listGitHubRepos(draft?: unknown): Promise<GitHubRepoListResult> {
    const github = this.plugins.get('github');
    if (!github?.listGitHubRepos) {
      return { ok: false, repos: [], error: 'GitHub 渠道未初始化' };
    }
    return github.listGitHubRepos(draft);
  }

  async reconnect(channelId: string): Promise<ChannelView[]> {
    const plugin = this.plugins.get(channelId);
    if (plugin && this.started) {
      await plugin.start(this.buildPluginContext());
      this.emitChanged();
    }
    return this.listViews();
  }

  approvePairing(requestId: string): ChannelView[] {
    const approved = this.deps.store.approvePairing(requestId);
    if (approved) {
      const plugin = this.plugins.get(approved.channelId);
      if (plugin && !plugin.silentPairing) {
        const address = plugin.formatTargetAddress(approved.chatKind, {
          chatId: approved.chatId,
          senderId: approved.senderId,
        });
        void plugin
          .sendMessage({
            address,
            text: '✅ 你的设备已通过配对审批，现在可以直接在这里向我发消息了！',
          })
          .catch(() => undefined);
      }
      this.emitChanged();
    }
    return this.listViews();
  }

  rejectPairing(requestId: string): ChannelView[] {
    if (this.deps.store.rejectPairing(requestId)) {
      this.emitChanged();
    }
    return this.listViews();
  }

  removeAllowlistEntry(
    channelId: string,
    kind: 'dm' | 'group',
    entryId: string,
  ): ChannelView[] {
    this.deps.store.removeAllowlistEntry(channelId, kind, entryId);
    this.emitChanged();
    return this.listViews();
  }

  forgetTarget(channelId: string, address: string): ChannelView[] {
    this.deps.store.forgetTarget(channelId, address);
    this.emitChanged();
    return this.listViews();
  }

  private resolveTargetTitle(address: string, fallbackChannelId: string): ChannelTargetView | undefined {
    return this.deps.store
      .listTargets(fallbackChannelId)
      .find((t) => t.address === address);
  }

  private async clearThinking(
    address: string,
    reason: ChannelThinkingCleanupReason = 'cancelled',
  ): Promise<void> {
    const entry = this.pendingThinking.get(address);
    if (!entry) return;
    this.pendingThinking.delete(address);
    clearTimeout(entry.timer);
    await entry.cleanup(reason).catch(() => undefined);
  }

  private async trackThinking(plugin: ChannelPlugin, address: string, messageId: string): Promise<void> {
    if (!plugin.markThinking) return;
    await this.clearThinking(address, 'cancelled');
    const cleanup = await plugin.markThinking(messageId).catch(() => undefined);
    if (!cleanup) return;
    const timer = setTimeout(() => {
      const current = this.pendingThinking.get(address);
      if (current?.cleanup === cleanup) {
        this.pendingThinking.delete(address);
        void cleanup('timeout').catch(() => undefined);
      }
    }, THINKING_TIMEOUT_MS);
    timer.unref?.();
    this.pendingThinking.set(address, { cleanup, timer });
  }

  private async handleInbound(message: ChannelInboundMessage): Promise<void> {
    const plugin = this.plugins.get(message.channelId);
    if (!plugin) return;

    this.deps.store.recordTarget({
      channelId: message.channelId,
      address: message.replyTarget.address,
      chatKind: message.chatKind,
      title: message.chatTitle || message.senderName,
      lastActiveAt: message.timestamp,
    });

    const decision = evaluateChannelAccess(message, plugin.getAccessConfig());

    if (decision.action === 'ignore') {
      return;
    }

    if (decision.action === 'pair') {
      const pairing = this.deps.store.upsertPairing({
        id: `pair-${crypto.randomUUID().slice(0, 12)}`,
        channelId: message.channelId,
        senderId: message.senderId,
        senderName: message.senderName,
        chatId: message.chatId,
        chatKind: message.chatKind,
        firstMessagePreview: message.text.slice(0, 120),
        createdAt: Date.now(),
      });
      if (pairing.isNew) {
        if (!plugin.silentPairing) {
          await plugin
            .sendMessage({
              address: message.replyTarget.address,
              replyToMessageId: message.messageId,
              text: '👋 你好！这是我第一次收到你的消息。我已在桌面端「设置 → 应用渠道」提交了配对请求，请管理员点击「允许」后再试。',
            })
            .catch(() => undefined);
        }
        this.deps.onPairingRequest?.(pairing.request, plugin.name);
      }
      this.emitChanged();
      return;
    }

    const summaryPrefix =
      message.chatKind === 'group'
        ? `[${message.chatTitle ?? '群聊'}] ${message.senderName}`
        : message.senderName;
    const enqueued = this.deps.threads.enqueueOnce({
      source: message.source ?? 'im',
      kind: message.eventKind ?? 'im.message',
      dedupeKey: `${message.channelId}:${message.messageId}`,
      payload: {
        channelId: message.channelId,
        channelName: message.channelName,
        chatKind: message.chatKind,
        chatId: message.chatId,
        senderId: message.senderId,
        senderName: message.senderName,
        author: message.senderName,
        text: message.text,
        summary: `${summaryPrefix}: ${message.text}`.slice(0, 200),
        attachments: message.attachments,
        replyTarget: message.replyTarget,
        ...(message.threadKey ? { threadKey: message.threadKey } : {}),
      },
    });

    if (!enqueued.inserted) {
      return;
    }

    if (plugin.shouldMirrorToDesktop() && this.deps.chat) {
      this.deps.chat.appendMirroredUserMessage({
        text: message.text,
        attachments: message.attachments,
        channelMeta: {
          channelId: message.channelId,
          channelName: message.channelName,
          chatKind: message.chatKind,
          chatId: message.chatId,
          senderName: message.senderName,
          direction: 'inbound',
        },
      });
    }

    void this.trackThinking(plugin, message.replyTarget.address, message.messageId);
    this.deps.onAcceptedEvent?.();
    this.emitChanged();
  }

  private resolveOutboundAttachments(
    blocks?: readonly ChatContentBlock[],
    explicitFilePaths?: readonly string[],
  ): ChannelOutboundAttachment[] {
    const resolved: ChannelOutboundAttachment[] = [];
    const seen = new Set<string>();

    if (blocks && this.deps.resolveTaskArtifactPath) {
      for (const ref of extractArtifactsFromBlocks(blocks)) {
        const absPath = this.deps.resolveTaskArtifactPath(ref.taskId, ref.relPath);
        if (absPath && !seen.has(absPath) && fs.existsSync(absPath)) {
          seen.add(absPath);
          resolved.push({ path: absPath, name: ref.title ?? path.basename(absPath) });
        }
      }
    }

    if (explicitFilePaths) {
      const roots = (this.deps.allowedFileRoots ?? []).map((root) => path.resolve(root));
      const baseDir = roots[0];
      for (const filePath of explicitFilePaths) {
        const trimmed = filePath.trim();
        if (!trimmed) continue;
        const resolvedPath =
          path.isAbsolute(trimmed) || !baseDir
            ? path.resolve(trimmed)
            : path.resolve(baseDir, trimmed);
        if (roots.length > 0) {
          const allowed = roots.some(
            (root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`),
          );
          if (!allowed) continue;
        }
        if (seen.has(resolvedPath)) continue;
        const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
        if (stat?.isFile()) {
          seen.add(resolvedPath);
          resolved.push({ path: resolvedPath, name: path.basename(resolvedPath) });
        }
      }
    }

    return resolved;
  }

  private findPluginByAddress(address: string, adapterId?: string): ChannelPlugin | undefined {
    if (adapterId) {
      const explicit = this.plugins.get(adapterId);
      if (explicit) return explicit;
    }
    for (const plugin of this.plugins.values()) {
      if (plugin.matchesAddress(address)) {
        return plugin;
      }
    }
    return undefined;
  }

  async sendExternalReply(
    target: TriggerReplyTarget,
    response: RouterResponse,
    fallbackText = '',
  ): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.findPluginByAddress(target.address, target.adapterId);
    if (!plugin) {
      return { ok: false, error: `未找到渠道插件: ${target.adapterId}` };
    }

    await this.clearThinking(target.address, 'replied');

    const attachments = this.resolveOutboundAttachments(response.blocks);
    const result = await plugin.sendMessage({
      address: target.address,
      text: fallbackText,
      blocks: response.blocks,
      ...(target.messageId ? { replyToMessageId: target.messageId } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    if (result.ok) {
      const known = this.resolveTargetTitle(target.address, plugin.id);
      if (plugin.shouldMirrorToDesktop() && this.deps.chat) {
        const textPreview =
          fallbackText ||
          response.blocks
            .map((b) => (b.type === 'markdown' ? b.text : 'title' in b ? (b.title ?? '') : ''))
            .filter(Boolean)
            .join('\n\n');
        this.deps.chat.appendMirroredAssistantMessage({
          text: textPreview,
          content: response.blocks,
          channelMeta: {
            channelId: plugin.id,
            channelName: plugin.name,
            chatKind: known?.chatKind ?? 'p2p',
            chatId: plugin.extractDisplayChatId(target.address),
            direction: 'outbound',
          },
        });
      }
    }

    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '发送失败' };
  }

  async sendProactiveMessage(input: {
    address: string;
    text: string;
    filePaths?: string[];
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const plugin = this.findPluginByAddress(input.address);
    if (!plugin) {
      return { ok: false, error: `无法识别目标渠道地址: ${input.address}` };
    }

    const attachments = this.resolveOutboundAttachments(undefined, input.filePaths);
    const result = await plugin.sendMessage({
      address: input.address,
      text: input.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    if (result.ok) {
      const known = this.resolveTargetTitle(input.address, plugin.id);
      const chatId = plugin.extractDisplayChatId(input.address);
      this.deps.store.recordTarget({
        channelId: plugin.id,
        address: input.address,
        chatKind: known?.chatKind ?? 'p2p',
        title: known?.title ?? chatId,
        lastActiveAt: Date.now(),
      });
      if (plugin.shouldMirrorToDesktop() && this.deps.chat) {
        this.deps.chat.appendMirroredAssistantMessage({
          text: input.text,
          content: [{ type: 'markdown', text: input.text }],
          channelMeta: {
            channelId: plugin.id,
            channelName: plugin.name,
            chatKind: known?.chatKind ?? 'p2p',
            chatId,
            direction: 'outbound',
          },
        });
      }
      this.emitChanged();
    }

    return result;
  }

  async sendApprovalNotice(
    target: TriggerReplyTarget,
    approval: { title: string; body: string; tool?: string },
  ): Promise<void> {
    const plugin = this.findPluginByAddress(target.address, target.adapterId);
    if (!plugin) return;

    await plugin
      .sendMessage({
        address: target.address,
        text: `${approval.title}\n${approval.body}`,
        blocks: [
          {
            type: 'approval',
            reportId: 'external-notice',
            threadId: 'external-notice',
            taskId: 'external-notice',
            tool: approval.tool ?? 'external',
            title: approval.title,
            body: approval.body,
            state: 'pending',
          },
        ],
        ...(target.messageId ? { replyToMessageId: target.messageId } : {}),
      })
      .catch(() => undefined);
  }
}
