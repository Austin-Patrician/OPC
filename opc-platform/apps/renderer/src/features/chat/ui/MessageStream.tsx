import { useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Avatar } from '@/entities/agent/ui/Avatar';
import type { Agent } from '@/entities/agent/model/types';
import type { Message } from '@/entities/message/model/types';
import { DeliverableCard } from '@/entities/message/ui/DeliverableCard';
import { TaskCard } from '@/entities/task/ui/TaskCard';
import { RichText } from '@/entities/message/ui/RichText';
import { SpeakButton } from './SpeakButton';
import { TypingIndicator } from './TypingIndicator';

interface MessageStreamProps {
  messages: readonly Message[];
  agents: readonly Agent[];
  typingNames: readonly string[];
}

/**
 * Virtualized message list. Only the visible window is mounted, so a
 * conversation with thousands of turns keeps a flat memory profile.
 */
export function MessageStream({ messages, agents, typingNames }: MessageStreamProps) {
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  return (
    <div className="min-h-0 flex-1">
      <Virtuoso
        data={messages as Message[]}
        className="h-full"
        followOutput="smooth"
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        computeItemKey={(_, message) => message.id}
        increaseViewportBy={{ top: 400, bottom: 600 }}
        components={{
          Footer: () => (
            <div className="px-6 pt-4 pb-3">
              <TypingIndicator names={typingNames} />
            </div>
          ),
        }}
        itemContent={(_, message) => (
          <div className="px-6 py-2">
            <MessageRow message={message} agent={agentById.get(message.senderId)} />
          </div>
        )}
      />
    </div>
  );
}

function MessageRow({ message, agent }: { message: Message; agent?: Agent }) {
  if (message.kind === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-ink/5 px-3 py-1 text-xs-plus text-ink-tertiary">
          {message.text}
        </span>
      </div>
    );
  }

  const avatarUrl = message.senderAvatarUrl ?? agent?.avatarUrl;

  if (message.kind === 'task' && message.task) {
    return (
      <div className="space-y-3">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex items-start justify-end gap-2.5">
          <TaskCard task={message.task} />
          <Avatar
            name={message.senderName}
            src={avatarUrl}
            size="sm"
            className="mt-0.5 size-avatar-sm"
          />
        </div>
      </div>
    );
  }

  if (message.kind === 'deliverable' && message.deliverable) {
    return (
      <div className="space-y-3">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex items-start justify-end gap-2.5">
          <DeliverableCard deliverable={message.deliverable} />
          <Avatar
            name={message.senderName}
            src={avatarUrl}
            size="sm"
            className="mt-0.5 size-avatar-sm"
          />
        </div>
      </div>
    );
  }

  if (message.senderId === 'user') {
    return (
      <div className="space-y-3">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex items-start justify-end gap-2.5">
          <div className="max-w-[41.25rem] rounded-[0.625rem] bg-bubble-user px-3.5 py-2.5 text-md-plus leading-[1.55] break-words text-bubble-user-ink shadow-card">
            <RichText text={message.text ?? ''} />
          </div>
          <Avatar name={message.senderName} size="sm" className="mt-0.5 size-avatar-sm" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
      <div className="flex items-start gap-2.5">
        <Avatar name={message.senderName} src={avatarUrl} size="sm" className="mt-0.5 size-avatar-sm" />
        <div className="flex max-w-[41.25rem] flex-col items-start">
          <div className="mb-1 flex items-center gap-1.5 px-0.5">
            <span className="text-sm font-medium text-ink-secondary">{message.senderName}</span>
            {message.senderRole ? (
              <span className="rounded bg-ink/5 px-1.5 py-px text-2xs text-ink-tertiary">
                {message.senderRole}
              </span>
            ) : null}
            <span className="text-2xs text-ink-quaternary">{message.timestamp}</span>
            {message.text?.trim() ? <SpeakButton text={message.text} /> : null}
          </div>
          <div className="rounded-[0.625rem] border border-line/60 bg-bubble-agent px-3.5 py-2.5 text-md leading-[1.58] break-words whitespace-pre-wrap text-ink shadow-card">
            <RichText text={message.text ?? ''} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TimeHeader({ value }: { value: string }) {
  return <div className="py-2 text-center text-sm text-ink-quaternary select-none">{value}</div>;
}
