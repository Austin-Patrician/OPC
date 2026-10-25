import { useSyncExternalStore } from 'react';
import { getChatTransport } from '@/shared/api/chatTransport';

/**
 * Subscribes the tree to the active transport. Kept deliberately thin: swapping
 * to a daemon-backed client must not change a single component.
 */
export function useChatRuntime() {
  const transport = getChatTransport();
  const snapshot = useSyncExternalStore(
    transport.subscribe,
    transport.getSnapshot,
    transport.getSnapshot,
  );

  return {
    ...snapshot,
    sendMessage: transport.sendMessage,
    markRead: transport.markRead,
    updateAgentBrief: transport.updateAgentBrief,
  };
}
