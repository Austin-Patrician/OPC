import { useState } from 'react';
import { Network, Settings, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { getPlatform, isMacLike } from '@/shared/lib/platform';
import { useShellStore } from '@/shared/prefs/useShellStore';

interface TitleBarProps {
  departmentCount: number;
  agentCount: number;
  onOpenOrg: () => void;
  onOpenMarket: () => void;
  onOpenSettings: () => void;
}

const platform = getPlatform();

/**
 * 42px macOS-style title bar. Window controls follow the host platform, so the
 * same bundle looks native on Windows and Linux instead of faking traffic lights.
 */
export function TitleBar({
  departmentCount,
  agentCount,
  onOpenOrg,
  onOpenMarket,
  onOpenSettings,
}: TitleBarProps) {
  const { t } = useTranslation();
  const [signature, setSignature] = useState('');
  const [editing, setEditing] = useState(false);
  const toggleDossier = useShellStore((state) => state.toggleDossier);
  const dossierOpen = useShellStore((state) => state.dossierOpen);

  return (
    <header className="app-drag flex h-chrome shrink-0 items-center justify-between border-b border-line-strong bg-chrome px-3.5 select-none">
      <div className="titlebar-leading flex items-center gap-3.5">
        <div className="titlebar-traffic no-drag mr-1 flex items-center gap-2" aria-hidden>
          {isMacLike(platform) ? (
            <>
              <span className="inline-block size-3 rounded-full border border-[#e0443e] bg-[#ff5f56]" />
              <span className="inline-block size-3 rounded-full border border-[#dea123] bg-[#ffbd2e]" />
              <span className="inline-block size-3 rounded-full border border-[#1aab29] bg-[#27c93f]" />
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1 rounded px-1 text-ink-tertiary hover:text-ink"
              aria-label={t('common.settings')}
            >
              <Settings className="size-3.5" />
            </button>
          )}
        </div>

        <div className="no-drag flex items-center gap-2">
          <Avatar name="老板" size="xs" status="online" className="size-[1.625rem]" />
          <span className="text-md font-semibold tracking-tight text-ink">老板</span>
          {editing ? (
            <input
              autoFocus
              value={signature}
              placeholder={t('titleBar.signaturePlaceholder')}
              onChange={(event) => setSignature(event.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setEditing(false);
              }}
              className="w-48 rounded border border-accent bg-surface/80 px-1.5 py-0.5 text-sm-plus text-ink outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="cursor-text text-sm-plus text-ink-tertiary transition-colors hover:text-ink-secondary"
            >
              {signature || t('titleBar.defaultSignature')}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="no-drag hidden items-center gap-1.5 rounded-md border border-ink/5 bg-ink/5 px-2 py-1 sm:flex">
          <button
            type="button"
            onClick={onOpenOrg}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs-plus text-ink-secondary transition-colors hover:bg-ink/5"
          >
            <Network className="size-3.5" />
            <span>{t('titleBar.orgPill', { departments: departmentCount, agents: agentCount })}</span>
          </button>
          <span className="text-xs text-ink-quaternary">|</span>
          <button
            type="button"
            onClick={onOpenMarket}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs-plus font-medium text-accent-ink transition-colors hover:bg-accent/10"
          >
            <UserPlus className="size-3.5" />
            <span>{t('titleBar.hire')}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={toggleDossier}
          aria-pressed={dossierOpen}
          title={t('chat.dossier')}
          className={`no-drag rounded p-1 transition-colors hover:bg-ink/5 ${dossierOpen ? 'text-accent' : 'text-ink-secondary'}`}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
            <rect x="2.2" y="3.5" width="15.6" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
            <line x1="7.2" y1="3.5" x2="7.2" y2="16.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M13.2 8.2L10.8 10L13.2 11.8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
