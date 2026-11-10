import type { ChatMessagePage, ChatSearchInput, ChatSearchPage, ChatSnapshot, SendMessageInput } from '@opc/shared/ipc';

/**
 * The single seam between the UI and the Electron main process.
 *
 * The renderer never imports Node, SQLite or the runtime: it reads immutable
 * snapshots and calls intents. Swapping the implementation (mock → real
 * services) must not touch a single component.
 */
export interface ChatTransport {
  getSnapshot(): ChatSnapshot;
  subscribe(listener: () => void): () => void;
  loadOlderMessages(conversationId: string, beforeMessageId: string): Promise<ChatMessagePage>;
  searchMessages(input: ChatSearchInput): Promise<ChatSearchPage>;
  sendMessage(input: SendMessageInput): void;
  markRead(conversationId: string): void;
  dispose(): void;
}

export const EMPTY_SNAPSHOT: ChatSnapshot = {
  agents: [],
  conversations: [],
  hasOlderMessagesByConversation: {},
  typingByConversation: {},
  activityByConversation: {},
};

let current: ChatTransport | null = null;

export function setChatTransport(transport: ChatTransport): void {
  current?.dispose();
  current = transport;
}

export function getChatTransport(): ChatTransport {
  if (!current) {
    throw new Error('ChatTransport 未初始化：应用必须由 Electron 主进程启动。');
  }
  return current;
}
