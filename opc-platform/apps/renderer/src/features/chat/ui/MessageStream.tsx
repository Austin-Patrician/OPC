import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, Check, ChevronDown, ChevronUp, Copy, LoaderCircle, RotateCw } from 'lucide-react';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { assistantName, userName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import type { Agent } from '@/entities/agent/model/types';
import type { Message } from '@/entities/message/model/types';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import type { ChatMessagePage } from '@opc/shared/ipc';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { RichText } from '@/entities/message/ui/RichText';
import {
  filterResolvedActionBlocks,
  isActionCardBlock,
  isLocallyResolvedEmptyActionMessage,
  isVisibleChatMessage,
} from '../lib/messageList';
import { AssistantContent } from './AssistantContent';
import { SpeakButton } from './SpeakButton';
import { TypingIndicator } from './TypingIndicator';
import { useTranslation } from 'react-i18next';

interface MessageStreamProps {
  messages: readonly Message[];
  firstItemIndex: number;
  agents: readonly Agent[];
  typingNames: readonly string[];
  hasOlderMessages: boolean;
  onLoadOlder: (beforeMessageId: string) => Promise<ChatMessagePage>;
  targetMessageId?: string;
}

interface StreamVirtuosoContext {
  loadingOlder: boolean;
  loadError: boolean;
  typingNames: readonly string[];
  onRetryLoadOlder: () => void;
  historyLoadingLabel: string;
  historyLoadFailedLabel: string;
}

const COLLAPSED_USER_MESSAGE_HEIGHT = 192;
const VIEWPORT_OVERSCAN = { top: 600, bottom: 600 };

const StreamHeader = memo(function StreamHeader({ context }: { context: StreamVirtuosoContext }) {
  return (
    <div className="flex h-9 items-center justify-center" role="status" aria-live="polite">
      {context.loadingOlder ? (
        <LoaderCircle size={15} className="animate-spin text-ink-tertiary" aria-label={context.historyLoadingLabel} />
      ) : null}
      {context.loadError ? (
        <button
          type="button"
          onClick={context.onRetryLoadOlder}
          className="rounded p-1 text-ink-tertiary hover:bg-surface-hover hover:text-ink"
          title={context.historyLoadFailedLabel}
          aria-label={context.historyLoadFailedLabel}
        >
          <RotateCw size={15} />
        </button>
      ) : null}
    </div>
  );
});

const StreamFooter = memo(function StreamFooter({ context }: { context: StreamVirtuosoContext }) {
  return (
    <div className="buddy-message-gutter min-w-0 max-w-full px-6 pt-3 pb-6">
      <TypingIndicator names={context.typingNames} />
    </div>
  );
});

const VIRTUOSO_COMPONENTS: Components<Message, StreamVirtuosoContext> = {
  Header: StreamHeader,
  Footer: StreamFooter,
};

function getMessageKey(_: number, message: Message): string {
  return message.id;
}

/**
 * Virtualized message list. Only the visible window is mounted, so a
 * conversation with thousands of turns keeps a flat memory profile.
 */
export function MessageStream({
  messages,
  firstItemIndex,
  agents,
  typingNames,
  hasOlderMessages,
  onLoadOlder,
  targetMessageId,
}: MessageStreamProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const currentUserName = userName(profile, t('company.userFallback'));
  const currentAssistantName = assistantName(profile, t('company.assistantFallback'));
  const [resolvedReportIds, setResolvedReportIds] = useState<Set<string>>(() => new Set());
  const handleActionCardResolved = useCallback((reportId: string) => {
    setResolvedReportIds((prev) => {
      if (prev.has(reportId)) return prev;
      const next = new Set(prev);
      next.add(reportId);
      return next;
    });
  }, []);
  const visibleMessages = useMemo(
    () => messages.filter(
      (message) => isVisibleChatMessage(message) && !isLocallyResolvedEmptyActionMessage(message, resolvedReportIds),
    ),
    [messages, resolvedReportIds],
  );
  const [hasMore, setHasMore] = useState(hasOlderMessages);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrolledTargetRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const lastTailIdRef = useRef<string | undefined>(visibleMessages.at(-1)?.id);

  useEffect(() => setHasMore(hasOlderMessages), [hasOlderMessages]);

  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    setScrollerEl(ref instanceof HTMLElement ? ref : null);
  }, []);

  useEffect(() => {
    if (!scrollerEl) return undefined;
    let lastTouchY: number | null = null;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        userScrolledUpRef.current = true;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      if (lastTouchY !== null && currentY !== undefined && currentY > lastTouchY) {
        userScrolledUpRef.current = true;
      }
      if (currentY !== undefined) lastTouchY = currentY;
    };
    scrollerEl.addEventListener('wheel', onWheel, { passive: true });
    scrollerEl.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollerEl.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scrollerEl.removeEventListener('wheel', onWheel);
      scrollerEl.removeEventListener('touchstart', onTouchStart);
      scrollerEl.removeEventListener('touchmove', onTouchMove);
    };
  }, [scrollerEl]);

  useEffect(() => {
    const tail = visibleMessages.at(-1);
    if (!tail) {
      lastTailIdRef.current = undefined;
      return;
    }
    if (tail.id !== lastTailIdRef.current) {
      lastTailIdRef.current = tail.id;
      if (tail.senderId === 'user') {
        userScrolledUpRef.current = false;
        virtuosoRef.current?.scrollToIndex({
          index: firstItemIndex + visibleMessages.length - 1,
          align: 'end',
          behavior: 'smooth',
        });
      }
    }
  }, [firstItemIndex, visibleMessages]);

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

    userScrolledUpRef.current = true;
    virtuosoRef.current?.scrollToIndex({ index: firstItemIndex + index, align: 'center', behavior: 'smooth' });
    scrolledTargetRef.current = targetMessageId;
    setHighlightedMessageId(targetMessageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId((current) => current === targetMessageId ? null : current);
      highlightTimerRef.current = null;
    }, 5_000);
  }, [firstItemIndex, targetMessageId, visibleMessages]);

  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  const followOutput = useCallback((isAtBottom: boolean) => {
    if (!isAtBottom || userScrolledUpRef.current) return false;
    return 'auto' as const;
  }, []);

  const handleAtBottomChange = useCallback((next: boolean) => {
    setAtBottom(next);
    if (next) {
      userScrolledUpRef.current = false;
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingRef.current) return;
    const beforeMessageId = visibleMessages[0]?.id;
    if (!beforeMessageId) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    setLoadError(false);
    try {
      const page = await onLoadOlder(beforeMessageId);
      setHasMore(page.hasMore);
    } catch {
      setLoadError(true);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasMore, onLoadOlder, visibleMessages]);

  const handleRetryLoadOlder = useCallback(() => {
    void loadOlder();
  }, [loadOlder]);

  const handleStartReached = useCallback(() => {
    void loadOlder();
  }, [loadOlder]);

  const virtuosoContext = useMemo<StreamVirtuosoContext>(() => ({
    loadingOlder,
    loadError,
    typingNames,
    onRetryLoadOlder: handleRetryLoadOlder,
    historyLoadingLabel: t('chat.historyLoading'),
    historyLoadFailedLabel: t('chat.historyLoadFailed'),
  }), [loadingOlder, loadError, typingNames, handleRetryLoadOlder, t]);

  const renderItem = useCallback((_: number, message: Message) => (
    <div className={`buddy-message-gutter min-w-0 max-w-full rounded-xl px-6 py-3 transition-colors duration-300 ${message.id === highlightedMessageId ? 'bg-amber-400/15 ring-1 ring-amber-400/30' : ''}`}>
      <MessageRow
        message={message}
        agent={agentById.get(message.senderId)}
        userName={currentUserName}
        assistantName={currentAssistantName}
        resolvedReportIds={resolvedReportIds}
        onActionCardResolved={handleActionCardResolved}
      />
    </div>
  ), [agentById, currentAssistantName, currentUserName, handleActionCardResolved, highlightedMessageId, resolvedReportIds]);

  const jumpToLatest = useCallback(() => {
    userScrolledUpRef.current = false;
    virtuosoRef.current?.scrollToIndex({
      index: firstItemIndex + visibleMessages.length - 1,
      align: 'end',
      behavior: 'smooth',
    });
  }, [firstItemIndex, visibleMessages.length]);

  return (
    <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 bg-gradient-to-b from-[var(--panel-bg-base)] to-transparent"
      />
      <Virtuoso<Message, StreamVirtuosoContext>
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        data={visibleMessages}
        context={virtuosoContext}
        firstItemIndex={firstItemIndex}
        className="h-full min-w-0 max-w-full overflow-x-hidden"
        defaultItemHeight={96}
        atBottomThreshold={48}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomChange}
        startReached={handleStartReached}
        initialTopMostItemIndex={{ index: firstItemIndex + Math.max(0, visibleMessages.length - 1), align: 'end' }}
        computeItemKey={getMessageKey}
        increaseViewportBy={VIEWPORT_OVERSCAN}
        components={VIRTUOSO_COMPONENTS}
        itemContent={renderItem}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-[var(--panel-bg-base)] to-transparent"
      />
      {!atBottom && visibleMessages.length > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="buddy-jump-to-bottom absolute bottom-4 left-1/2 z-20 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-xs font-medium text-ink-secondary shadow-popover transition hover:border-line-strong hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowDown size={14} strokeWidth={2} />
          {t('chat.jumpToLatest')}
        </button>
      ) : null}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  agent,
  userName,
  assistantName: assistantDisplayName,
  resolvedReportIds,
  onActionCardResolved,
}: {
  message: Message;
  agent?: Agent;
  userName: string;
  assistantName: string;
  resolvedReportIds: ReadonlySet<string>;
  onActionCardResolved: (reportId: string) => void;
}) {
  const filteredBlocks = useMemo(
    () => (
      message.content?.length
        ? filterResolvedActionBlocks(message.content, resolvedReportIds)
        : [{ type: 'markdown' as const, text: message.text ?? '' }]
    ),
    [message.content, message.text, resolvedReportIds],
  );

  if (message.kind === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full border border-line/80 bg-surface-muted px-3 py-1 text-xs-plus text-ink-tertiary">
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
        ? assistantDisplayName
        : message.senderName;
  const displayRole = isRouter ? undefined : message.senderRole;
  const avatarUrl = message.senderAvatarUrl ?? agent?.avatarUrl;
  const isStreaming = Boolean(message.streaming);
  const containsActionCard = filteredBlocks.some(isActionCardBlock);

  if (!isVisibleChatMessage(message)) return null;
  if (isLocallyResolvedEmptyActionMessage(message, resolvedReportIds)) return null;

  if (message.senderId === 'user') {
    return (
      <div className="min-w-0 max-w-full space-y-2.5">
        {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
        <div className="flex min-w-0 max-w-full justify-end">
          <div className="buddy-user-bubble min-w-0 max-w-[min(82%,560px)] rounded-[20px] rounded-br-[6px] px-4 py-2.5 text-[14.5px] leading-[1.62] break-words">
            {message.text?.trim() ? <UserMessageText text={message.text} /> : null}
            <AttachmentList attachments={message.attachments} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-1.5">
      {message.timeHeader ? <TimeHeader value={message.timeHeader} /> : null}
      <div className="group flex min-w-0 max-w-full flex-col items-start">
        <div className="mb-1.5 flex items-center gap-2">
          {isRouter ? (
            <span className="inline-flex origin-left scale-[0.82] items-center">
              <BuddyMark size="xs" animated={isStreaming} />
            </span>
          ) : (
            <Avatar
              name={displayName}
              src={avatarUrl}
              size="sm"
              className="size-6"
            />
          )}
          <span className="text-[12.5px] font-medium text-ink-secondary">{displayName}</span>
          {displayRole ? (
            <span className="rounded bg-surface-muted px-1.5 py-px text-2xs text-ink-tertiary">
              {displayRole}
            </span>
          ) : null}
          <span className="text-[11px] text-ink-quaternary">{message.timestamp}</span>
        </div>
        <div
          className={
            containsActionCard
              ? 'w-full min-w-0 max-w-full overflow-hidden text-[15px] leading-[1.72] break-words text-ink'
              : 'buddy-agent-bubble w-full min-w-0 max-w-full overflow-hidden text-[15px] leading-[1.72] break-words text-ink'
          }
        >
          <AssistantContent
            blocks={filteredBlocks}
            streaming={isStreaming}
            onActionCardResolved={onActionCardResolved}
          />
          {isStreaming ? (
            <span
              aria-label="正在生成"
              className="ml-1 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-accent/80 align-middle"
            />
          ) : null}
        </div>
        {!containsActionCard && message.text?.trim() && !isStreaming ? (
          <AssistantMessageFooter text={message.text} />
        ) : null}
      </div>
    </div>
  );
});

function hasLikelyLongUserText(text: string): boolean {
  return text.length > 260 || text.split('\n').length >= 8;
}

const UserMessageText = memo(function UserMessageText({ text }: { text: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(() => hasLikelyLongUserText(text));

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
      <div className="relative">
        <div
          ref={contentRef}
          className={`min-w-0 w-full max-w-[42em] whitespace-pre-wrap [overflow-wrap:anywhere] ${isLong && !expanded ? 'max-h-48 overflow-hidden' : ''}`}
        >
          <RichText text={text} />
        </div>
        {isLong && !expanded ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--bubble-user)] to-transparent"
          />
        ) : null}
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
});

const AttachmentList = memo(function AttachmentList({ attachments }: { attachments?: readonly ChatAttachmentRef[] }) {
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
});

function formatMessageAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const AssistantMessageFooter = memo(function AssistantMessageFooter({ text }: { text: string }) {
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
    <div className="pointer-events-none mt-1.5 flex h-6 w-full items-center justify-start gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t(copied ? 'chat.responseCopied' : 'chat.copyResponse')}
        title={t(copied ? 'chat.responseCopied' : 'chat.copyResponse')}
        className="inline-flex size-6 items-center justify-center rounded-md text-ink-quaternary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
      <SpeakButton text={text} />
    </div>
  );
});

const TimeHeader = memo(function TimeHeader({ value }: { value: string }) {
  return <div className="py-3 text-center text-[11.5px] font-medium text-ink-quaternary select-none">{value}</div>;
});
