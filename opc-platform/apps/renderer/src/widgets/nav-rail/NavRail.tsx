import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  MessageCircle,
  Settings,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { assistantName, userName } from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { emitBuddySignal } from '@/shared/ui/buddyEvents';
import { IdentityPopover } from '@/widgets/title-bar/IdentityPopover';

export function NavRail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [identityOpen, setIdentityOpen] = useState(false);
  const [brandPulseCount, setBrandPulseCount] = useState(0);
  const [brandBouncing, setBrandBouncing] = useState(false);
  const brandBounceTimerRef = useRef<number | null>(null);
  const identityRef = useRef<HTMLDivElement>(null);
  const profile = useCompanyProfile();
  const updateProfile = useCompany((state) => state.update);
  const name = userName(profile, t('company.userFallback'));
  const currentAssistantName = assistantName(profile, t('company.assistantFallback'));
  const chatActive = location.pathname.startsWith('/chat') || location.pathname === '/';
  const schedulesActive = location.pathname.startsWith('/schedules');

  useEffect(() => {
    return () => {
      if (brandBounceTimerRef.current !== null) {
        window.clearTimeout(brandBounceTimerRef.current);
      }
    };
  }, []);

  const handleBrandClick = () => {
    navigate('/chat');
    emitBuddySignal({ kind: 'brand-summon' });
    setBrandBouncing(false);
    setBrandPulseCount((count) => count + 1);
    window.requestAnimationFrame(() => {
      setBrandBouncing(true);
    });
    if (brandBounceTimerRef.current !== null) {
      window.clearTimeout(brandBounceTimerRef.current);
    }
    brandBounceTimerRef.current = window.setTimeout(() => {
      brandBounceTimerRef.current = null;
      setBrandBouncing(false);
    }, 540);
  };

  useEffect(() => {
    if (!identityOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!identityRef.current?.contains(event.target as Node)) setIdentityOpen(false);
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
    <aside className="buddy-rail relative z-40 flex w-[64px] shrink-0 flex-col items-center justify-between py-3.5 select-none">
      <div className="flex flex-col items-center">
        <div className="buddy-traffic mb-4 flex items-center gap-[6px]" aria-hidden>
          <span className="size-[10px] rounded-full bg-[#ff5f57]" />
          <span className="size-[10px] rounded-full bg-[#febc2e]" />
          <span className="size-[10px] rounded-full bg-[#28c840]" />
        </div>
        <button
          type="button"
          onClick={handleBrandClick}
          className={cn(
            'buddy-brand-btn relative flex size-9 items-center justify-center rounded-xl transition hover:bg-surface-hover',
            brandBouncing && 'buddy-brand-bouncing',
          )}
          title={currentAssistantName}
          aria-label={currentAssistantName}
        >
          {brandBouncing ? (
            <span
              key={brandPulseCount}
              className="buddy-brand-ring pointer-events-none absolute inset-0 rounded-xl"
              aria-hidden
            />
          ) : null}
          <span className="buddy-brand-inner inline-flex">
            <BuddyMark size="sm" animated={false} />
          </span>
        </button>
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/chat')}
            aria-label={t('nav.im')}
            aria-current={chatActive ? 'page' : undefined}
            title={t('nav.im')}
            className={cn('buddy-rail-button relative', chatActive && 'buddy-rail-button-active')}
          >
            <MessageCircle size={19} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/schedules')}
            aria-label={t('nav.schedules')}
            aria-current={schedulesActive ? 'page' : undefined}
            title={t('nav.schedules')}
            className={cn('buddy-rail-button relative', schedulesActive && 'buddy-rail-button-active')}
          >
            <CalendarClock size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="relative flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label={t('common.settings')}
          title={t('common.settings')}
          className="buddy-rail-button buddy-settings-button"
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
        <div ref={identityRef} className="relative">
          <button
            type="button"
            data-testid="identity-trigger"
            onClick={() => setIdentityOpen((open) => !open)}
            aria-label={t('titleBar.profile')}
            aria-expanded={identityOpen}
            className="flex rounded-full border border-line shadow-card transition hover:ring-2 hover:ring-accent/25"
          >
            <Avatar name={name} src={profile.userAvatar} size="sm" className="size-8" />
          </button>
          {identityOpen ? (
            <IdentityPopover
              profile={profile}
              onRename={(next) => void updateProfile({ userName: next })}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
