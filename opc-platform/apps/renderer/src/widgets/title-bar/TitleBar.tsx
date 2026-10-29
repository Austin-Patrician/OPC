import { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { bossName } from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { getPlatform, isDesktopShell, isMacLike } from '@/shared/lib/platform';
import { useShellStore } from '@/shared/prefs/useShellStore';
import { IdentityPopover } from './IdentityPopover';
import { StartMenu } from './StartMenu';

interface TitleBarProps {
  onOpenSettings: () => void;
}

/**
 * 24px macOS-style title bar. Window controls follow the host platform, so the
 * same bundle looks native on Windows and Linux instead of faking traffic lights.
 *
 * The only identity in the chrome is the boss's avatar: clicking it opens the
 * name/company/role card. It always hangs over the chrome's bottom edge, aligned
 * with the navigation rail below it. On macOS the real traffic lights sit in that
 * same corner, so the avatar drops just under them instead of being pushed right.
 */
export function TitleBar({ onOpenSettings }: TitleBarProps) {
  const { t } = useTranslation();
  const toggleDossier = useShellStore((state) => state.toggleDossier);
  const dossierOpen = useShellStore((state) => state.dossierOpen);
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);

  const [identityOpen, setIdentityOpen] = useState(false);
  const identityRef = useRef<HTMLDivElement>(null);

  const boss = bossName(profile, t('company.bossFallback'));
  // Both read per render: `bootstrap()` sets the `<html>` dataset just before
  // React mounts, so a module-scope read would be stale on the very first paint.
  const platform = getPlatform();
  const mac = isMacLike(platform);
  const nativeMacChrome = mac && isDesktopShell();

  // Dismiss the card on any click outside it, or on Escape. `pointerdown` (not
  // `click`) so a click on the bar itself does not leave it hanging.
  useEffect(() => {
    if (!identityOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (identityRef.current?.contains(event.target as Node)) return;
      // Commit an in-progress rename before the card unmounts with its input.
      const active = document.activeElement;
      if (active instanceof HTMLElement && identityRef.current?.contains(active)) active.blur();
      setIdentityOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIdentityOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [identityOpen]);

  return (
    <header
      className={cn(
        'app-drag relative z-40 flex h-chrome shrink-0 items-center justify-between pr-3 select-none',
        nativeMacChrome ? 'pl-0' : 'pl-2.5',
      )}
    >
      <div
        className={cn('titlebar-leading flex items-center gap-3', nativeMacChrome && 'pl-[0.875rem]')}
      >
        <div
          className="titlebar-traffic no-drag flex items-center gap-2"
          aria-hidden={mac ? true : undefined}
        >
          {mac ? (
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

        {/* 28px avatar in a 24px bar: centring puts its top at -2px. Translate it
            down so it hangs over the chrome/workspace edge, aligned with the rail
            below. On macOS it clears the native traffic lights above it. The `+`
            sits on the same baseline so the two read as one cluster. */}
        <div
          className={cn(
            'no-drag flex items-center gap-2',
            nativeMacChrome ? 'translate-y-8' : 'translate-y-3',
          )}
        >
          <div ref={identityRef} className="relative">
            <button
              type="button"
              data-testid="identity-trigger"
              aria-haspopup="dialog"
              aria-expanded={identityOpen}
              aria-label={t('titleBar.profile')}
              title={t('titleBar.profile')}
              onClick={() => setIdentityOpen((open) => !open)}
              className="flex rounded-full outline-none transition hover:ring-2 hover:ring-accent/40 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Avatar name={boss} src={profile.bossAvatar} size="xs" className="size-7" />
            </button>

            {identityOpen ? (
              <IdentityPopover
                profile={profile}
                onRename={(name) => void update({ bossName: name })}
              />
            ) : null}
          </div>

          <StartMenu />
        </div>
      </div>

      <div className="titlebar-trailing flex items-center gap-3">
        <button
          type="button"
          onClick={toggleDossier}
          aria-pressed={dossierOpen}
          title={t('chat.dossier')}
          className={`no-drag rounded p-0.5 transition-colors hover:bg-ink/5 ${dossierOpen ? 'text-accent' : 'text-ink-secondary'}`}
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
