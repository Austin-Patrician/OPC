import { useEffect, useState, type CSSProperties } from 'react';
import { Maximize2, Minus, Search, Square, SquarePen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantActivity, AssistantActivityPhase } from '@opc/shared/ipc';
import { assistantName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { subscribeBuddySignal } from '@/shared/ui/buddyEvents';
import { VoiceOrb } from '@/shared/ui/VoiceOrb';
import { resolveStatusActivityKey, resolveVoiceOrbMode } from '@/shared/ui/voiceOrbState';

interface TitleBarProps {
  searchEnabled: boolean;
  onToggleSearch: () => void;
  newChatEnabled?: boolean;
  newChatDisabled?: boolean;
  onNewChat?: () => void;
  showChatStatus?: boolean;
  chatActivity?: AssistantActivity;
}

const TYPING_DECAY_MS = 1_500;

/** One chrome row for the VoiceOrb status capsule, search action, and window controls. */
export function TitleBar({
  searchEnabled,
  onToggleSearch,
  newChatEnabled = false,
  newChatDisabled = false,
  onNewChat,
  showChatStatus = false,
  chatActivity,
}: TitleBarProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const currentAssistantName = assistantName(profile, t('company.assistantFallback'));
  const [maximized, setMaximized] = useState(false);

  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [userTyping, setUserTyping] = useState(false);
  const [runningThreads, setRunningThreads] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!showChatStatus) {
      setVoiceState('idle');
      setVoiceLevel(0);
      setTtsSpeaking(false);
      setUserTyping(false);
      return undefined;
    }

    let typingTimer: number | null = null;
    const clearTypingTimer = () => {
      if (typingTimer !== null) {
        window.clearTimeout(typingTimer);
        typingTimer = null;
      }
    };

    const unsubscribe = subscribeBuddySignal((signal) => {
      switch (signal.kind) {
        case 'voice': {
          setVoiceState(signal.state);
          const nextLevel = signal.state === 'recording' ? (signal.level ?? 0) : 0;
          setVoiceLevel((prev) =>
            nextLevel === 0 || Math.abs(nextLevel - prev) >= 0.02 ? nextLevel : prev,
          );
          break;
        }
        case 'tts': {
          setTtsSpeaking(signal.speaking);
          break;
        }
        case 'typing': {
          setUserTyping(true);
          clearTypingTimer();
          typingTimer = window.setTimeout(() => {
            typingTimer = null;
            setUserTyping(false);
          }, TYPING_DECAY_MS);
          break;
        }
        case 'sent': {
          clearTypingTimer();
          setUserTyping(false);
          break;
        }
        default:
          break;
      }
    });

    return () => {
      clearTypingTimer();
      unsubscribe();
    };
  }, [showChatStatus]);

  useEffect(() => {
    if (!showChatStatus) {
      setRunningThreads({});
      return undefined;
    }
    const onProgress = window.opc?.work?.onProgress;
    if (!onProgress) return undefined;
    try {
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
    } catch {
      return undefined;
    }
  }, [showChatStatus]);

  const phase: AssistantActivityPhase = chatActivity?.phase ?? 'idle';
  const hasRunningWorker = Object.keys(runningThreads).length > 0;
  const orbMode = resolveVoiceOrbMode({
    activityPhase: phase,
    voiceState,
    ttsSpeaking,
    userTyping,
    hasRunningWorker,
  });
  const statusKey = resolveStatusActivityKey({
    activityPhase: phase,
    voiceState,
    ttsSpeaking,
    hasRunningWorker,
  });
  const statusText = `${currentAssistantName} · ${t(statusKey)}`;
  const showAcousticBars = orbMode === 'speaking' || orbMode === 'listening';

  const toggleMaximize = async () => {
    const next = await window.opc?.window.toggleMaximize();
    if (typeof next === 'boolean') setMaximized(next);
  };

  return (
    <header className="buddy-titlebar relative z-30 flex h-[44px] shrink-0 items-center px-4">
      <div className="buddy-titlebar-drag app-drag absolute inset-0" aria-hidden />
      {showChatStatus ? (
        <div
          role="status"
          aria-live="polite"
          aria-label={statusText}
          data-orb-mode={orbMode}
          style={{ '--orb-level': voiceLevel.toFixed(3) } as CSSProperties}
          className="buddy-assistant-status buddy-orb-capsule no-drag absolute left-1/2 z-10 flex min-w-0 max-w-[min(48vw,320px)] -translate-x-1/2 items-center gap-2 rounded-full px-2 py-1"
        >
          <VoiceOrb mode={orbMode} level={voiceLevel} size={22} />
          <span className="buddy-assistant-status-label buddy-orb-capsule-label truncate text-xs font-medium">
            {statusText}
          </span>
          {showAcousticBars ? (
            <span className="voice-orb-bars inline-flex shrink-0 items-center gap-[2px]" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="relative z-10 flex min-w-0 flex-1 items-center justify-end gap-2">
        {searchEnabled || newChatEnabled ? (
          <div className="no-drag flex items-center gap-1">
            {newChatEnabled && onNewChat ? (
              <button
                type="button"
                disabled={newChatDisabled}
                aria-label={t('chat.newChat.action')}
                title={t('chat.newChat.actionHint')}
                onClick={onNewChat}
                className="buddy-header-action disabled:pointer-events-none disabled:opacity-35"
              >
                <SquarePen size={15} strokeWidth={1.8} />
              </button>
            ) : null}
            {searchEnabled ? (
              <button
                type="button"
                aria-label={t('common.search')}
                title={t('common.search')}
                onClick={onToggleSearch}
                className="buddy-header-action"
              >
                <Search size={15} strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="buddy-window-controls no-drag relative z-10 ml-3 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => void window.opc?.window.minimize()}
          aria-label={t('window.minimize')}
          className="buddy-window-control"
        >
          <Minus size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          onClick={toggleMaximize}
          aria-label={t(maximized ? 'window.restore' : 'window.maximize')}
          className="buddy-window-control"
        >
          {maximized ? (
            <Square size={12} strokeWidth={1.6} />
          ) : (
            <Maximize2 size={13} strokeWidth={1.6} />
          )}
        </button>
        <button
          type="button"
          onClick={() => void window.opc?.window.close()}
          aria-label={t('common.close')}
          className="buddy-window-control buddy-window-close"
        >
          <X size={15} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  );
}
