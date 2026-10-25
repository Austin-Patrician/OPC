import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChatPanel } from '@/features/chat/ui/ChatPanel';
import { useChatRuntime } from '@/features/chat/model/useChatRuntime';
import { useWorkRuntime } from '@/features/task/model/useWorkRuntime';
import { DispatchTaskDialog, type DispatchDraft } from '@/features/task/ui/DispatchTaskDialog';
import { SessionList } from '@/widgets/session-list/SessionList';

/** IM workspace route: conversation list + active chat. */
export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { conversations, agents, departments, typingByConversation, sendMessage, markRead, updateAgentBrief } =
    useChatRuntime();
  const { createTask, budgetFor } = useWorkRuntime();
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const active = conversations.find((item) => item.id === conversationId) ?? conversations[0];

  useEffect(() => {
    if (!conversationId && active) {
      navigate(`/chat/${active.id}`, { replace: true });
    }
  }, [active, conversationId, navigate]);

  useEffect(() => {
    if (active) markRead(active.id);
  }, [active, markRead]);

  // createTask reserves budget, then starts the run; the card arrives via chat snapshots.
  const dispatchTask = (draft: DispatchDraft) => createTask(draft);

  // A fresh install has no conversations at all: send the boss to the org chart,
  // which is where every chat is actually started from.
  if (!active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-panel px-6 text-center">
        <p className="text-sm-plus font-medium text-ink">还没有任何会话</p>
        <p className="max-w-[24rem] text-xs leading-relaxed text-ink-tertiary">
          去「组织架构」点开一位员工发起对话，或在部门档案里进入部门群——会话会在第一次使用时创建。
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.hash = '#/org';
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
        >
          打开组织架构
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="hidden shrink-0 md:flex">
        <SessionList
          conversations={conversations}
          activeId={active.id}
          onSelect={(id) => navigate(`/chat/${id}`)}
          onOpenOrg={() => navigate('/org')}
          onOpenMarket={() => navigate('/market')}
          onCreateGroup={() => navigate('/org')}
          onArchive={(conversationId) => void window.opc!.chat.archive(conversationId)}
          onRestore={(conversationId) => void window.opc!.chat.restore(conversationId)}
        />
      </div>

      <ChatPanel
        conversation={active}
        agents={agents}
        departments={departments}
        typingNames={typingByConversation[active.id] ?? []}
        onSend={(text, mentionIds) => sendMessage({ conversationId: active.id, text, mentionIds })}
        onUpdateBrief={updateAgentBrief}
        onOpenDispatch={() => setDispatchOpen(true)}
        budgetFor={budgetFor}
      />

      {dispatchOpen ? (
        <DispatchTaskDialog
          agents={agents}
          defaultAssigneeId={active.primaryAgentId ?? agents[0]?.id ?? ''}
          budgetFor={budgetFor}
          onSubmit={dispatchTask}
          onClose={() => setDispatchOpen(false)}
        />
      ) : null}
    </div>
  );
}
