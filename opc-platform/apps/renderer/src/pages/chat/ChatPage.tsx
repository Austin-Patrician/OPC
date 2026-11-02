import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChatPanel } from '@/features/chat/ui/ChatPanel';
import { useChatRuntime } from '@/features/chat/model/useChatRuntime';
import { useWorkRuntime } from '@/features/task/model/useWorkRuntime';
import { DispatchTaskDialog, type DispatchDraft } from '@/features/task/ui/DispatchTaskDialog';

/**
 * 对话页。
 *
 * 这里曾经是「左边会话列表 + 右边聊天」。v2 之后没有列表了：老板始终只在和
 * 一个助手说话（Super-agent 的连续感），事情在注意力队列里，过程在这条会话里。
 */
export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { conversations, agents, typingByConversation, sendMessage, markRead } =
    useChatRuntime();
  const { createTask } = useWorkRuntime();
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const active = conversations.find((item) => item.id === conversationId) ?? conversations[0];
  const [resolving, setResolving] = useState(false);

  // 没有会话就建一条：老板不该先"选一个对象"才能说话。
  useEffect(() => {
    if (active || resolving) return;
    if (!window.opc?.chat.ensureAssistant) return;
    setResolving(true);
    void window.opc.chat
      .ensureAssistant()
      .then((id) => navigate(`/chat/${id}`, { replace: true }))
      .finally(() => setResolving(false));
  }, [active, navigate, resolving]);

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

  if (!active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-panel px-6 text-center">
        <p className="text-sm-plus font-medium text-ink">还没有可以对话的执行体</p>
        <p className="max-w-[24rem] text-xs leading-relaxed text-ink-tertiary">
          配好模型之后，这里会直接出现和助手的对话——不需要先挑一个人。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ChatPanel
        conversation={active}
        agents={agents}
        typingNames={typingByConversation[active.id] ?? []}
        onSend={(text, mentionIds) => sendMessage({ conversationId: active.id, text, mentionIds })}
        onOpenDispatch={() => setDispatchOpen(true)}
      />

      {dispatchOpen ? (
        <DispatchTaskDialog
          agents={agents}
          defaultAssigneeId={active.primaryAgentId ?? agents[0]?.id ?? ''}
          onSubmit={dispatchTask}
          onClose={() => setDispatchOpen(false)}
        />
      ) : null}
    </div>
  );
}
