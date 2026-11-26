import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Compass, Lightbulb, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/entities/agent/model/types';
import type { Conversation } from '@/entities/conversation/model/types';
import { Composer } from './Composer';
import { MessageStream } from './MessageStream';
import {
  INITIAL_FIRST_ITEM_INDEX,
  mergeSnapshotMessages,
  prependOlderMessages,
  type MessageStreamState,
} from '../lib/messageList';
import { assistantName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import type { AssistantActivityPhase, ChatMessagePage } from '@opc/shared/ipc';

interface ChatPanelProps {
  conversation: Conversation;
  agents: readonly Agent[];
  typingNames: readonly string[];
  activityPhase?: AssistantActivityPhase;
  hasOlderMessages: boolean;
  loadOlderMessages: (beforeMessageId: string) => Promise<ChatMessagePage>;
  targetMessageId?: string;
  onWelcomeVisibilityChange?: (visible: boolean) => void;
  onSend: (text: string, mentionIds: string[], attachments?: ChatAttachmentRef[]) => void;
}

const BUSY_PHASES: ReadonlySet<AssistantActivityPhase> = new Set([
  'thinking',
  'delegating',
  'working',
  'organizing',
  'typing',
]);

/** Center column: header, virtualized stream, composer. */
export function ChatPanel({
  conversation,
  agents,
  typingNames,
  activityPhase,
  hasOlderMessages,
  loadOlderMessages,
  targetMessageId,
  onWelcomeVisibilityChange,
  onSend,
}: ChatPanelProps) {
  const [streamState, setStreamState] = useState<MessageStreamState>(() => ({
    messages: conversation.messages,
    firstItemIndex: INITIAL_FIRST_ITEM_INDEX,
  }));
  const streamStateRef = useRef(streamState);
  streamStateRef.current = streamState;
  const [runningThreads, setRunningThreads] = useState<Record<string, true>>({});

  useEffect(() => {
    const onProgress = window.opc?.work?.onProgress;
    if (!onProgress) return undefined;
    return onProgress((event) => {
      setRunningThreads((current) => {
        const isRunning = event.state === 'running';
        const alreadyRunning = Boolean(current[event.threadId]);
        if (isRunning === alreadyRunning) return current;
        if (isRunning) return { ...current, [event.threadId]: true };
        const next = { ...current };
        delete next[event.threadId];
        return next;
      });
    });
  }, []);

  const hasRunningWorker = Object.keys(runningThreads).length > 0;
  const isBusy = Boolean(hasRunningWorker || (activityPhase && BUSY_PHASES.has(activityPhase)));
  const isWelcomeVisible = streamState.messages.length === 0;

  useEffect(() => {
    onWelcomeVisibilityChange?.(isWelcomeVisible);
    return () => onWelcomeVisibilityChange?.(false);
  }, [isWelcomeVisible, onWelcomeVisibilityChange]);

  const handleInterruptAll = useCallback(() => {
    void window.opc?.chat?.interrupt('用户点击停止');
  }, []);

  useEffect(() => {
    setStreamState((current) => {
      if (conversation.messages.length === 0) {
        if (current.messages.length === 0 && current.firstItemIndex === INITIAL_FIRST_ITEM_INDEX) {
          return current;
        }
        const emptyState: MessageStreamState = {
          messages: [],
          firstItemIndex: INITIAL_FIRST_ITEM_INDEX,
        };
        streamStateRef.current = emptyState;
        return emptyState;
      }
      const merged = mergeSnapshotMessages(current.messages, conversation.messages);
      if (merged === current.messages) return current;
      const next = { ...current, messages: merged };
      streamStateRef.current = next;
      return next;
    });
  }, [conversation.messages]);

  const handleLoadOlder = useCallback(async (beforeMessageId: string) => {
    const page = await loadOlderMessages(beforeMessageId);
    if (page.messages.length > 0) {
      setStreamState((current) => {
        const next = prependOlderMessages(current, page.messages);
        streamStateRef.current = next;
        return next;
      });
    }
    return page;
  }, [loadOlderMessages]);

  useEffect(() => {
    if (!targetMessageId || streamStateRef.current.messages.some((message) => message.id === targetMessageId)) return;
    let cancelled = false;
    void (async () => {
      let state = streamStateRef.current;
      let cursor = state.messages[0]?.id;
      while (cursor && !state.messages.some((message) => message.id === targetMessageId)) {
        const page = await loadOlderMessages(cursor);
        if (cancelled || page.messages.length === 0) break;
        const nextState = prependOlderMessages(state, page.messages);
        if (nextState === state) break;
        state = nextState;
        streamStateRef.current = nextState;
        cursor = page.messages[0]?.id;
        setStreamState(nextState);
        if (!page.hasMore) break;
      }
    })();
    return () => { cancelled = true; };
  }, [targetMessageId, loadOlderMessages]);

  // Newest first; the composer walks it backwards on ArrowUp / ArrowDown.
  const sentHistory = useMemo(
    () =>
      streamState.messages
        .flatMap((message) =>
          message.senderId === 'user' && message.kind === 'text' && message.text?.trim() ? [message.text] : [],
        )
        .reverse(),
    [streamState.messages],
  );

  return (
    <main className="buddy-chat relative flex min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        {streamState.messages.length === 0 ? (
          <WelcomeCanvas onSend={(text) => onSend(text, [])} />
        ) : (
          <MessageStream
            conversationId={conversation.id}
            messages={streamState.messages}
            firstItemIndex={streamState.firstItemIndex}
            agents={agents}
            typingNames={typingNames}
            hasOlderMessages={hasOlderMessages}
            onLoadOlder={handleLoadOlder}
            targetMessageId={targetMessageId}
          />
        )}

        <Composer
          key={conversation.id}
          onSend={onSend}
          history={sentHistory}
          busy={isBusy}
          onStop={handleInterruptAll}
        />
      </div>
    </main>
  );
}

function WelcomeCanvas({ onSend }: { onSend: (text: string) => void }) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const currentAssistantName = assistantName(profile, t('company.assistantFallback'));
  return (
    <div className="buddy-welcome min-h-0 flex-1 overflow-y-auto px-6">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center py-6 text-center">
        <div className="relative mb-3">
          <div className="buddy-welcome-halo absolute -inset-5 rounded-full blur-xl" />
          <BuddyMark size="2xl" interactive />
        </div>
        <div className="buddy-online-badge inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium">
          <span className="size-1.5 rounded-full bg-success" />
          {t('chat.welcome.online')}
        </div>
        <h1 className="buddy-welcome-title mt-3 text-[22px] font-bold tracking-tight">
          {t('chat.welcome.title', { name: currentAssistantName })}
        </h1>
        <p className="buddy-welcome-copy mt-1.5 max-w-[440px] text-[13.5px] leading-relaxed">
          {t('chat.welcome.description')}
        </p>

        <div className="mt-7 w-full space-y-3 text-left">
          <p className="buddy-welcome-label flex items-center justify-between px-1 text-[12px] font-medium">
            {t('chat.welcome.tryOne')}
          </p>
          <button type="button" onClick={() => onSend(t('chat.welcome.prompts.plan.message'))} className="buddy-starter group flex w-full flex-col items-center gap-4 rounded-[16px] border p-3.5 text-left transition-all sm:flex-row">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-muted text-ink-secondary">
              <Compass size={22} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1 space-y-2">
              <span className="buddy-starter-title block text-[14px] font-medium leading-snug">“{t('chat.welcome.prompts.plan.title')}”</span>
              <span className="flex items-center justify-between gap-2">
                <span className="buddy-welcome-result inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium"><span className="flex size-4 items-center justify-center rounded-full bg-success text-white"><Check size={10} strokeWidth={3} /></span>{t('chat.welcome.prompts.plan.description')}</span>
                <span className="buddy-welcome-action inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium opacity-80 transition group-hover:translate-x-0.5 group-hover:opacity-100">{t('chat.welcome.tryIt')}<ArrowRight size={14} /></span>
              </span>
            </span>
          </button>
          <button type="button" onClick={() => onSend(t('chat.welcome.prompts.organize.message'))} className="buddy-starter group flex w-full flex-col items-center justify-between gap-4 rounded-[16px] border p-3.5 text-left transition-all sm:flex-row">
            <span className="min-w-0 flex-1 space-y-2">
              <span className="buddy-starter-title block text-[14px] font-medium leading-snug">“{t('chat.welcome.prompts.organize.title')}”</span>
              <span className="flex items-center justify-between gap-3">
                <span className="buddy-starter-description text-[12px]">{t('chat.welcome.prompts.organize.description')}</span>
                <span className="buddy-welcome-action inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium opacity-80 transition group-hover:translate-x-0.5 group-hover:opacity-100">{t('chat.welcome.tryIt')}<ArrowRight size={14} /></span>
              </span>
            </span>
            <LandscapeIllustration className="h-[74px] w-[116px]" />
          </button>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StarterPrompt icon={<Lightbulb size={19} />} title={t('chat.welcome.prompts.ideas.title')} description={t('chat.welcome.prompts.ideas.description')} onClick={() => onSend(t('chat.welcome.prompts.ideas.message'))} />
            <StarterPrompt icon={<ListChecks size={19} />} title={t('chat.welcome.prompts.task.title')} description={t('chat.welcome.prompts.task.description')} onClick={() => onSend(t('chat.welcome.prompts.task.message'))} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StarterPrompt({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="buddy-starter group flex w-full items-start gap-3 rounded-[14px] border p-3.5 text-left transition-all"
    >
      <span className="buddy-starter-icon flex size-10 shrink-0 items-center justify-center rounded-[12px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="buddy-starter-title block text-[12.5px] font-medium leading-snug">
          {title}
        </span>
        <span className="buddy-starter-description mt-1 block text-[11px] leading-relaxed">
          {description}
        </span>
      </span>
    </button>
  );
}

function LandscapeIllustration({ className }: { className: string }) {
  return <span aria-hidden className={`buddy-landscape relative block shrink-0 overflow-hidden rounded-[11px] border ${className}`}>
    <svg viewBox="0 0 160 104" className="block size-full">
      <defs><linearGradient id="buddy-landscape-sky" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#cbe2ee" /><stop offset="1" stopColor="#deeff5" /></linearGradient></defs>
      <rect width="160" height="104" fill="url(#buddy-landscape-sky)" /><circle cx="44" cy="30" r="10" fill="#eae6d3" />
      <path d="M108 36c0-6 6-10 12-8 3-6 13-6 17 0 5 0 9 4 9 9s-4 6-9 6h-24c-4 0-5-3-5-7Z" fill="white" />
      <path d="m58 104 48-62 50 62Z" fill="#78bca1" /><path d="m-8 104 50-56 56 56Z" fill="#59a889" />
      <path d="M-10 104q50-30 102-14 38 8 74-8v22Z" fill="#8ed1b5" opacity=".75" />
    </svg>
  </span>;
}
