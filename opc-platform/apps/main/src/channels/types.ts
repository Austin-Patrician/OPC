import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelRuntimeStatus,
  ChannelTargetView,
  ChannelTransportKind,
  ChannelView,
  ChatAttachmentRef,
  ChatContentBlock,
  GitHubRepoListResult,
  TriggerReplyTarget,
  TriggerSource,
} from '@opc/shared/domain';

export interface ChannelInboundMessage {
  channelId: string;
  channelName: string;
  transport: ChannelTransportKind;
  /** Defaults to `'im'` for chat channels; non-IM sources (e.g. GitHub) override cleanly. */
  source?: TriggerSource;
  /** Defaults to `'im.message'`. */
  eventKind?: string;
  /** Optional external thread identity (e.g. `github:owner/repo#12`) for fast-path routing. */
  threadKey?: string;
  messageId: string;
  chatId: string;
  chatKind: 'p2p' | 'group';
  chatTitle?: string;
  senderId: string;
  senderName: string;
  isBotSender: boolean;
  mentionsBot: boolean;
  text: string;
  attachments: ChatAttachmentRef[];
  timestamp: number;
  replyTarget: TriggerReplyTarget;
}

export interface ChannelOutboundAttachment {
  path: string;
  name?: string;
  mimeType?: string;
}

export interface ChannelSendPayload {
  address: string;
  text: string;
  blocks?: ChatContentBlock[];
  replyToMessageId?: string;
  attachments?: ChannelOutboundAttachment[];
}

export interface ChannelSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export type ChannelThinkingCleanupReason = 'replied' | 'timeout' | 'cancelled';

export type ChannelThinkingCleanup = (reason?: ChannelThinkingCleanupReason) => Promise<void>;

export interface ChannelPluginContext {
  onInboundMessage: (message: ChannelInboundMessage) => Promise<void>;
  getAttachmentsDir: () => string;
  onStatusChange: () => void;
}

export interface ChannelPlugin {
  readonly id: 'feishu' | 'dingtalk' | 'slack' | 'wecom' | 'telegram' | 'github';
  readonly name: string;
  readonly transport: ChannelTransportKind;
  /** When true, pairing requests appear on desktop without sending external prompts. */
  readonly silentPairing?: boolean;
  isConfigured(): boolean;
  isEnabled(): boolean;
  shouldMirrorToDesktop(): boolean;
  getAccessConfig(): ChannelAccessConfig;
  getRuntimeStatus(): ChannelRuntimeStatus;
  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView;
  matchesAddress(address: string): boolean;
  formatTargetAddress(
    chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string;
  extractDisplayChatId(address: string): string;
  start(ctx: ChannelPluginContext): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
  testConnection(draft?: unknown): Promise<ChannelConnectionTestResult>;
  listGitHubRepos?(draft?: unknown): Promise<GitHubRepoListResult>;
  refreshWatchRepos?(): void;
  sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult>;
  markThinking?(messageId: string): Promise<ChannelThinkingCleanup | undefined>;
}
