import { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { bossName } from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { getPlatform, isDesktopShell, isMacLike } from '@/shared/lib/platform';
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
 * name/company/role card. It hangs over the chrome's bottom edge, above the
 * navigation rail's first row. On macOS the real traffic lights sit in that same
 * corner, so the avatar drops just under them instead of being pushed right.
 *
 * Nothing sits on the trailing edge: the chat header carries the dossier toggle,
 * so the chrome stays a single, uncluttered identity cluster on the left.
 */
export function TitleBar({ onOpenSettings }: TitleBarProps) {
  const { t } = useTranslation();
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
        'app-drag relative z-40 flex h-chrome shrink-0 items-center select-none',
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

        {/* 28px avatar in a 24px bar: centring puts its top at -2px. It is
            pushed down so it hangs over the chrome/workspace edge and reads as
            the first row of the rail below, with the same air above it as
            below. On macOS it also clears the native traffic lights. */}
        <div
          className={cn(
            'no-drag flex items-center',
            nativeMacChrome ? 'translate-y-10' : 'translate-y-5',
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
        </div>

        {/* The `+` closes the rail's top row on its right edge, one gap away from
            the body card — `rail + body inset - button` keeps it aligned with the
            search field below without hard-coding the rail's width. It is
            positioned instead of flexed so the avatar keeps the far-left corner. */}
        <div
          className={cn(
            'no-drag absolute flex',
            nativeMacChrome ? 'top-[2.375rem]' : 'top-[1.125rem]',
            'left-[calc(var(--spacing-rail)+0.5rem-1.75rem)]',
          )}
        >
          <StartMenu />
        </div>
      </div>
    </header>
  );
}
