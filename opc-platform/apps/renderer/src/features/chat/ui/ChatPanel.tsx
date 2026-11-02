import type { Agent } from '@/entities/agent/model/types';
import type { Budget } from '@opc/shared/domain';
import type { Conversation } from '@/entities/conversation/model/types';
import { useShellStore } from '@/shared/prefs/useShellStore';
import { AgentDossierDrawer } from '@/features/agent-dossier/ui/AgentDossierDrawer';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { MessageStream } from './MessageStream';

interface ChatPanelProps {
  conversation: Conversation;
  agents: readonly Agent[];
  typingNames: readonly string[];
  onSend: (text: string, mentionIds: string[]) => void;
  onUpdateBrief: (agentId: string, briefMd: string) => void;
  onOpenDispatch: () => void;
  budgetFor?: (employeeId: string) => Budget | undefined;
}

/** Center column: header, virtualized stream, composer, optional dossier. */
export function ChatPanel({
  conversation,
  agents,
  typingNames,
  onSend,
  onUpdateBrief,
  onOpenDispatch,
  budgetFor,
}: ChatPanelProps) {
  const dossierOpen = useShellStore((state) => state.dossierOpen);
  const toggleDossier = useShellStore((state) => state.toggleDossier);
  const closeDossier = useShellStore((state) => state.closeDossier);

  const members = conversation.memberIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => Boolean(agent));

  return (
    <main className="relative flex min-w-0 flex-1 overflow-hidden bg-panel">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={conversation.title}
          memberCount={conversation.memberIds.length + 1}
          onOpenDossier={toggleDossier}
          onOpenAddMember={toggleDossier}
        />

        <MessageStream messages={conversation.messages} agents={agents} typingNames={typingNames} />

        <Composer
          agents={members}
          onSend={onSend}
          onOpenDossier={toggleDossier}
          onOpenDispatch={onOpenDispatch}
        />
      </div>

      {dossierOpen ? (
        <AgentDossierDrawer
          conversation={conversation}
          members={members}
          onClose={closeDossier}
          onUpdateBrief={onUpdateBrief}
          budgetFor={budgetFor}
        />
      ) : null}
    </main>
  );
}
