import type { Agent } from '@/entities/agent/model/types';
import type { Conversation } from '@/entities/conversation/model/types';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { MessageStream } from './MessageStream';

interface ChatPanelProps {
  conversation: Conversation;
  agents: readonly Agent[];
  typingNames: readonly string[];
  onSend: (text: string, mentionIds: string[]) => void;
  onOpenDispatch: () => void;
}

/** Center column: header, virtualized stream, composer. */
export function ChatPanel({
  conversation,
  agents,
  typingNames,
  onSend,
  onOpenDispatch,
}: ChatPanelProps) {
  const members = conversation.memberIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => Boolean(agent));

  return (
    <main className="relative flex min-w-0 flex-1 overflow-hidden bg-panel">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={conversation.title}
          // 一对一不显示人数：和 Router 说话时「2 人」只是噪音。
          memberCount={conversation.kind === 'dm' ? 1 : conversation.memberIds.length + 1}
        />

        <MessageStream messages={conversation.messages} agents={agents} typingNames={typingNames} />

        <Composer agents={members} onSend={onSend} onOpenDispatch={onOpenDispatch} />
      </div>
    </main>
  );
}
