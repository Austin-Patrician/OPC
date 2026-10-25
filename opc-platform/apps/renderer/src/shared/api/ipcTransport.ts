import type { ChatSnapshot, OpcBridge, SendMessageInput } from '@opc/shared/ipc';
import { EMPTY_SNAPSHOT, type ChatTransport } from './chatTransport';

/**
 * IPC-backed transport. Snapshots are pushed from the main process; intents are
 * fire-and-forget invokes. `useSyncExternalStore` needs a stable, synchronous
 * `getSnapshot`, so the latest pushed snapshot is cached here.
 */
export class IpcChatTransport implements ChatTransport {
  private snapshot: ChatSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribeBridge: (() => void) | null = null;

  constructor(private readonly bridge: OpcBridge) {
    this.unsubscribeBridge = bridge.chat.onSnapshot((snapshot) => {
      this.snapshot = snapshot;
      this.emit();
    });

    void bridge.chat.getSnapshot().then((snapshot) => {
      this.snapshot = snapshot;
      this.emit();
    });
  }

  getSnapshot = (): ChatSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  sendMessage = (input: SendMessageInput): void => {
    void this.bridge.chat.sendMessage(input);
  };

  markRead = (conversationId: string): void => {
    void this.bridge.chat.markRead(conversationId);
  };

  updateAgentBrief = (agentId: string, briefMd: string): void => {
    void this.bridge.chat.updateAgentBrief(agentId, briefMd);
  };

  dispose = (): void => {
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    this.listeners.clear();
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
