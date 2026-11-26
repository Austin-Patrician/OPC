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
  TriggerReplyTarget,
} from '@opc/shared/domain';

export interface ChannelInboundMessage {
  channelId: string;
  channelName: string;
  transport: ChannelTransportKind;
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

export type ChannelThinkingCleanup = () => Promise<void>;

export interface ChannelPluginContext {
  onInboundMessage: (message: ChannelInboundMessage) => Promise<void>;
  getAttachmentsDir: () => string;
  onStatusChange: () => void;
}

export interface ChannelPlugin {
  readonly id: 'feishu' | 'dingtalk';
  readonly name: string;
  readonly transport: ChannelTransportKind;
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
  sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult>;
  markThinking?(messageId: string): Promise<ChannelThinkingCleanup | undefined>;
}
