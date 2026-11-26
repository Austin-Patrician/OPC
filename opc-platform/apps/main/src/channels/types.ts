import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelRuntimeStatus,
  ChannelTransportKind,
  ChatAttachmentRef,
  ChatContentBlock,
  FeishuChannelSettingsView,
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
  readonly id: string;
  readonly name: string;
  readonly transport: ChannelTransportKind;
  isConfigured(): boolean;
  getSettingsView(): FeishuChannelSettingsView;
  getAccessConfig(): ChannelAccessConfig;
  getRuntimeStatus(): ChannelRuntimeStatus;
  start(ctx: ChannelPluginContext): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
  testConnection(draft?: unknown): Promise<ChannelConnectionTestResult>;
  sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult>;
  markThinking?(messageId: string): Promise<ChannelThinkingCleanup | undefined>;
}
