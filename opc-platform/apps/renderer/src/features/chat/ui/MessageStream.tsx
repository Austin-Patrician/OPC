import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, Check, ChevronDown, ChevronUp, Copy, LoaderCircle, RotateCw } from 'lucide-react';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { userName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import type { Agent } from '@/entities/agent/model/types';
import type { Message } from '@/entities/message/model/types';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import type { ChatMessagePage } from '@opc/shared/ipc';
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
  hasOlderMessages: boolean;
  onLoadOlder: (beforeMessageId: string) => Promise<ChatMessagePage>;
  targetMessageId?: string;
}

const COLLAPSED_USER_MESSAGE_HEIGHT = 192;

/**
 * Virtualized message list. Only the visible window is mounted, so a
 * conversation with thousands of turns keeps a flat memory profile.
 */
export function MessageStream({ messages, agents, typingNames, hasOlderMessages, onLoadOlder, targetMessageId }: MessageStreamProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const currentUserName = userName(profile, t('company.userFallback'));
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.kind !== 'task' && message.kind !== 'deliverable'),
    [messages],
  );
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const [hasMore, setHasMore] = useState(hasOlderMessages);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [followingOutput, setFollowingOutput] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrolledTargetRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  useEffect(() => setHasMore(hasOlderMessages), [hasOlderMessages]);

  useEffect(() => {
    if (!targetMessageId) {
      scrolledTargetRef.current = null;
      setHighlightedMessageId(null);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
      return;
    }
    if (scrolledTargetRef.current === targetMessageId) return;
    setHighlightedMessageId(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
    const index = visibleMessages.findIndex((message) => message.id === targetMessageId);
    if (index < 0) return;

    virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
    scrolledTargetRef.current = targetMessageId;
    setHighlightedMessageId(targetMessageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId((current) => current === targetMessageId ? null : current);
      highlightTimerRef.current = null;
    }, 5_000);
  }, [targetMessageId, visibleMessages]);

  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    if (followTimerRef.current) clearTimeout(followTimerRef.current);
  }, []);

  const followOutput = (isAtBottom: boolean) => {
    if (!isAtBottom) return false;
    setFollowingOutput(true);
    if (followTimerRef.current) clearTimeout(followTimerRef.current);
    followTimerRef.current = setTimeout(() => {
      setFollowingOutput(false);
      followTimerRef.current = null;
    }, 600);
    return 'smooth' as const;
  };

  const handleAtBottomChange = (next: boolean) => {
    setAtBottom(next);
    if (next) {
      setFollowingOutput(false);
      if (followTimerRef.current) clearTimeout(followTimerRef.current);
      followTimerRef.current = null;
    }
  };

  const loadOlder = async () => {
    if (!hasMore || loadingRef.current) return;
    const beforeMessageId = visibleMessages[0]?.id;
    if (!beforeMessageId) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    setLoadError(false);
    try {
      const page = await onLoadOlder(beforeMessageId);
      setHasMore(page.hasMore);
      if (page.messages.length > 0) {
        setFirstItemIndex((current) => current - page.messages.length);
      }
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  };

  return (
    <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden">
      <Virtuoso
        ref={virtuosoRef}
        data={visibleMessages as Message[]}
        firstItemIndex={firstItemIndex}
        className="h-full min-w-0 max-w-full overflow-x-hidden"
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomChange}
        startReached={() => void loadOlder()}
        initialTopMostItemIndex={{ index: Math.max(0, visibleMessages.length - 1), align: 'end' }}
        computeItemKey={(_, message) => message.id}
        increaseViewportBy={{ top: 400, bottom: 600 }}
        components={{
          Header: () => (
            <div className="flex h-9 items-center justify-center" role="status" aria-live="polite">
              {loadingOlder ? <LoaderCircle size={15} className="animate-spin text-ink-tertiary" aria-label={t('chat.historyLoading')} /> : null}
              {loadError ? (
                <button type="button" onClick={() => void loadOlder()} className="rounded p-1 text-ink-tertiary hover:bg-ink/5 hover:text-ink" title={t('chat.historyLoadFailed')} aria-label={t('chat.historyLoadFailed')}>
                  <RotateCw size={15} />
                </button>
              ) : null}
            </div>
          ),
          Footer: () => (
            <div className="buddy-message-gutter min-w-0 max-w-full px-6 pt-4 pb-3">
              <TypingIndicator names={typingNames} />
            </div>
          ),
        }}
        itemContent={(_, message) => (
          <div className={`buddy-message-gutter min-w-0 max-w-full rounded-lg px-6 py-2 transition-colors duration-300 ${message.id === highlightedMessageId ? 'bg-amber-300/20 ring-1 ring-amber-400/25' : ''}`}>
            <MessageRow
              message={message}
              agent={agentById.get(message.senderId)}
              userName={currentUserName}
              userAvatar={profile.userAvatar}
            />
          </div>
        )}
      />
      {!atBottom && !followingOutput && visibleMessages.length > 0 ? (
        <button
          type="button"
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: visibleMessages.length - 1, align: 'end', behavior: 'smooth' })}
          className="buddy-jump-to-bottom absolute bottom-3 left-1/2 z-20 inline-flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-4 text-xs-plus font-medium text-ink-secondary shadow-popover transition hover:border-accent/30 hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowDown size={15} strokeWidth={2} />
          {t('chat.jumpToLatest')}
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  agent,
  userName,
  userAvatar,
}: {
  message: Message;
  agent?: Agent;
  userName: string;
  userAvatar?: string;
}) {
  const { t } = useTranslation();
  if (message.kind === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-ink/5 px-3 py-1 text-xs-plus text-ink-tertiary">
          {message.text}
        </span>
      </div>
    );
  }

  const isRouter = message.senderId === 'router';
  const displayName =
    message.senderId === 'user'
      ? userName
      : isRouter
        ? t('chat.sender.routerName')
        : message.senderName;
  const displayRole = isRouter ? t('chat.sender.routerRole') : message.senderRole;
  const avatarUrl = message.senderId === 'user' ? userAvatar : message.senderAvatarUrl ?? agent?.avatarUrl;
  const containsActionCard = message.content?.some((block) => block.type === 'approval' || block.type === 'workflow' || block.type === 'ontologyApproval') ?? false;

  if (message.kind === 'task' || message.kind === 'deliverable') return null;

  if (message.senderId === 'user') {
    return (
      <div className="min-w-0 max-w-full space-y-3">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex min-w-0 max-w-full items-start justify-end gap-2.5">
          <div className="buddy-user-bubble min-w-0 max-w-[min(100%,44em)] rounded-[15px] rounded-br-[5px] px-4 py-3 text-md-plus leading-[1.58] break-words">
            {message.text?.trim() ? <UserMessageText text={message.text} /> : null}
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
            name={displayName}
            src={avatarUrl}
            size="sm"
            className="mt-0.5 size-avatar-sm"
          />
        )}
        <div className="flex min-w-0 max-w-full flex-col items-start">
          <div className="mb-1 flex items-center gap-1.5 px-0.5">
            <span className="text-sm font-medium text-[#68756e]">{displayName}</span>
            {displayRole ? (
              <span className="rounded bg-ink/5 px-1.5 py-px text-2xs text-ink-tertiary">
                {displayRole}
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
              <AssistantMessageFooter text={message.text} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserMessageText({ text }: { text: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    const measure = () => {
      const next = content.scrollHeight > COLLAPSED_USER_MESSAGE_HEIGHT;
      setIsLong((current) => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <>
      <div
        ref={contentRef}
        className={`min-w-0 w-full max-w-[42em] whitespace-pre-wrap [overflow-wrap:anywhere] ${isLong && !expanded ? 'max-h-48 overflow-hidden' : ''}`}
      >
        <RichText text={text} />
      </div>
      {isLong ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-xs-plus font-medium text-accent-ink transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {expanded ? <><ChevronUp className="size-3.5" aria-hidden="true" />收起</> : <><ChevronDown className="size-3.5" aria-hidden="true" />展开全文</>}
        </button>
      ) : null}
    </>
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

function AssistantMessageFooter({ text }: { text: string }) {
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
    <div className="pointer-events-none mt-1 flex w-full items-center justify-start gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
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
