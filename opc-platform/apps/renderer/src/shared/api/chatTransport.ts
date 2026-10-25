import type { ChatSnapshot, SendMessageInput } from '@opc/shared/ipc';

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
  sendMessage(input: SendMessageInput): void;
  markRead(conversationId: string): void;
  updateAgentBrief(agentId: string, briefMd: string): void;
  dispose(): void;
}

export const EMPTY_SNAPSHOT: ChatSnapshot = {
  agents: [],
  departments: [],
  conversations: [],
  typingByConversation: {},
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
