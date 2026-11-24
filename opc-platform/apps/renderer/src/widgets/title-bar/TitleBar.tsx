import { useState } from 'react';
import { Maximize2, Minus, Search, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantActivity, AssistantActivityPhase } from '@opc/shared/ipc';

interface TitleBarProps {
  searchEnabled: boolean;
  onToggleSearch: () => void;
  showChatStatus?: boolean;
  chatActivity?: AssistantActivity;
}

/** One chrome row for the search action and Electron's native window buttons. */
export function TitleBar({
  searchEnabled,
  onToggleSearch,
  showChatStatus = false,
  chatActivity,
}: TitleBarProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const phase: AssistantActivityPhase = chatActivity?.phase ?? 'idle';
  const statusText = t(`chat.activity.${phase}`);
  const isActive = phase !== 'idle' && phase !== 'completed' && phase !== 'delivered' && phase !== 'error';
  const dotClass =
    phase === 'error'
      ? 'bg-danger'
      : phase === 'waiting_user'
        ? 'bg-warning'
        : isActive
          ? 'bg-accent animate-pulse'
          : 'bg-success';

  const toggleMaximize = async () => {
    const next = await window.opc?.window.toggleMaximize();
    if (typeof next === 'boolean') setMaximized(next);
  };

  return (
    <header className="buddy-titlebar relative z-30 flex h-[44px] shrink-0 items-center px-4">
      <div className="buddy-titlebar-drag app-drag absolute inset-0" aria-hidden />
      {showChatStatus ? (
        <div
          className={`buddy-assistant-status no-drag absolute left-1/2 z-10 flex min-w-0 max-w-[min(48vw,320px)] -translate-x-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors ${
            isActive ? 'border border-line/80 bg-surface-muted/80' : ''
          }`}
          aria-live="polite"
          aria-label={statusText}
        >
          <span className={`size-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />
          <span className={`buddy-assistant-status-label truncate text-xs ${isActive ? 'font-medium text-ink-secondary' : 'text-ink-tertiary'}`}>
            {statusText}
          </span>
          {isActive ? (
            <span className="buddy-assistant-status-dots inline-flex shrink-0 gap-0.5" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="relative z-10 flex min-w-0 flex-1 items-center justify-end gap-2">
        {searchEnabled ? (
          <div className="no-drag flex items-center gap-2">
            <button
              type="button"
              aria-label={t('common.search')}
              title={t('common.search')}
              onClick={onToggleSearch}
              className="buddy-header-action"
            >
              <Search size={15} strokeWidth={1.8} />
            </button>
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
