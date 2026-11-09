import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Check, Copy } from 'lucide-react';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { userName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import type { Agent } from '@/entities/agent/model/types';
import type { Message } from '@/entities/message/model/types';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { RichText } from '@/entities/message/ui/RichText';
import { AssistantContent } from './AssistantContent';
import { SpeakButton } from './SpeakButton';
import { TypingIndicator } from './TypingIndicator';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const currentUserName = userName(profile, t('company.userFallback'));
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.kind !== 'task' && message.kind !== 'deliverable'),
    [messages],
  );
  const latestAssistantId = useMemo(
    () => [...visibleMessages].reverse().find((message) => message.senderId !== 'user' && message.kind !== 'system')?.id,
    [visibleMessages],
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const latestUserMessageId = useMemo(
    () => [...visibleMessages].reverse().find((message) => message.senderId === 'user')?.id,
    [visibleMessages],
  );
  const previousUserMessageId = useRef(latestUserMessageId);
  const hasObservedInitialMessages = useRef(false);

  useEffect(() => {
    if (
      hasObservedInitialMessages.current &&
      latestUserMessageId &&
      latestUserMessageId !== previousUserMessageId.current
    ) {
      const index = visibleMessages.findIndex((message) => message.id === latestUserMessageId);
      if (index >= 0) {
        virtuosoRef.current?.scrollToIndex({ index, align: 'end', behavior: 'smooth' });
      }
    }
    hasObservedInitialMessages.current = true;
    previousUserMessageId.current = latestUserMessageId;
  }, [latestUserMessageId, visibleMessages]);

  return (
    <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden">
      <Virtuoso
        ref={virtuosoRef}
        data={visibleMessages as Message[]}
        className="h-full min-w-0 max-w-full overflow-x-hidden"
        followOutput="smooth"
        initialTopMostItemIndex={Math.max(0, visibleMessages.length - 1)}
        computeItemKey={(_, message) => message.id}
        increaseViewportBy={{ top: 400, bottom: 600 }}
        components={{
          Footer: () => (
            <div className="buddy-message-gutter min-w-0 max-w-full px-6 pt-4 pb-3">
              <TypingIndicator names={typingNames} />
            </div>
          ),
        }}
        itemContent={(_, message) => (
          <div className="buddy-message-gutter min-w-0 max-w-full px-6 py-2">
            <MessageRow
              message={message}
              agent={agentById.get(message.senderId)}
              userName={currentUserName}
              userAvatar={profile.userAvatar}
              isLatestAssistant={message.id === latestAssistantId}
            />
          </div>
        )}
      />
    </div>
  );
}

function MessageRow({
  message,
  agent,
  userName,
  userAvatar,
  isLatestAssistant,
}: {
  message: Message;
  agent?: Agent;
  userName: string;
  userAvatar?: string;
  isLatestAssistant: boolean;
}) {
  if (message.kind === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-ink/5 px-3 py-1 text-xs-plus text-ink-tertiary">
          {message.text}
        </span>
      </div>
    );
  }

  const displayName = message.senderId === 'user' ? userName : message.senderName;
  const avatarUrl = message.senderId === 'user' ? userAvatar : message.senderAvatarUrl ?? agent?.avatarUrl;
  const containsActionCard = message.content?.some((block) => block.type === 'approval' || block.type === 'workflow' || block.type === 'ontologyApproval') ?? false;

  if (message.kind === 'task' || message.kind === 'deliverable') return null;

  if (message.senderId === 'user') {
    return (
      <div className="min-w-0 max-w-full space-y-3">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex min-w-0 max-w-full items-start justify-end gap-2.5">
          <div className="buddy-user-bubble min-w-0 max-w-full rounded-[15px] rounded-br-[5px] px-4 py-3 text-md-plus leading-[1.58] break-words">
            {message.text?.trim() ? <RichText text={message.text} /> : null}
            <AttachmentList attachments={message.attachments} />
          </div>
          <Avatar
            name={displayName}
            src={avatarUrl}
            size="sm"
            className="mt-0.5 size-avatar-sm"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-2">
      {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
      <div className="flex min-w-0 max-w-full items-start gap-2.5">
        {message.senderId === 'router' ? (
          <BuddyMark size="md" />
        ) : (
          <Avatar
            name={message.senderName}
            src={avatarUrl}
            size="sm"
            className="mt-0.5 size-avatar-sm"
          />
        )}
        <div className="flex min-w-0 max-w-full flex-col items-start">
          <div className="mb-1 flex items-center gap-1.5 px-0.5">
            <span className="text-sm font-medium text-[#68756e]">{message.senderName}</span>
            {message.senderRole ? (
              <span className="rounded bg-ink/5 px-1.5 py-px text-2xs text-ink-tertiary">
                {message.senderRole}
              </span>
            ) : null}
            <span className="text-2xs text-ink-quaternary">{message.timestamp}</span>
          </div>
          <div className="group flex min-w-0 max-w-full w-full flex-col items-start">
            <div className={containsActionCard
              ? 'w-full min-w-0 max-w-full overflow-hidden text-md leading-[1.62] break-words text-[#2a3832]'
              : 'buddy-agent-bubble min-w-0 max-w-full overflow-hidden rounded-[16px] rounded-tl-[5px] px-4 py-3 text-md leading-[1.62] break-words text-[#2a3832]'}>
              <AssistantContent
                blocks={
                  message.content?.length
                    ? message.content
                    : [{ type: 'markdown', text: message.text ?? '' }]
                }
              />
              {message.streaming ? (
                <span
                  aria-label="正在生成"
                  className="ml-1 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-[#87947b] align-middle"
                />
              ) : null}
            </div>
            {!containsActionCard && message.text?.trim() && !message.streaming ? (
              <AssistantMessageFooter text={message.text} isLatest={isLatestAssistant} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments?: readonly ChatAttachmentRef[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="buddy-sent-attachments" aria-label={`已发送 ${attachments.length} 个附件`}>
      {attachments.map((file) => {
        const extension = file.name.includes('.') ? file.name.split('.').pop() : undefined;
        return (
          <div key={file.id} className={`buddy-sent-attachment ${file.availability === 'missing' ? 'buddy-sent-attachment-missing' : ''}`}>
            <span className="buddy-sent-attachment-icon" dangerouslySetInnerHTML={{ __html: getFileIcon(extension, file.name) }} aria-hidden="true" />
            <span className="buddy-sent-attachment-meta">
              <span className="buddy-sent-attachment-name" title={file.name}>{file.name}</span>
              <span className="buddy-sent-attachment-detail">{formatMessageAttachmentSize(file.size)}{file.availability === 'missing' ? ' · 文件不可用' : ''}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatMessageAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function AssistantMessageFooter({ text, isLatest }: { text: string; isLatest: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        textarea.remove();
        if (!success) throw new Error('copy failed');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`mt-1 flex w-full items-center justify-start gap-0.5 transition-opacity duration-150 ${isLatest ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'}`}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t(copied ? 'chat.responseCopied' : 'chat.copyResponse')}
        title={t(copied ? 'chat.responseCopied' : 'chat.copyResponse')}
        className="inline-flex size-7 items-center justify-center rounded-md text-[#8a938b] transition-colors hover:bg-[#f2f5f1] hover:text-[#43564a] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#87947b]"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
      <SpeakButton text={text} />
    </div>
  );
}

function TimeHeader({ value }: { value: string }) {
  return <div className="py-2 text-center text-sm text-ink-quaternary select-none">{value}</div>;
}
