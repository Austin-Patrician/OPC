import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Grid3X3,
  MessageCircle,
  Settings,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { userName } from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { IdentityPopover } from '@/widgets/title-bar/IdentityPopover';

export function NavRail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [identityOpen, setIdentityOpen] = useState(false);
  const identityRef = useRef<HTMLDivElement>(null);
  const profile = useCompanyProfile();
  const updateProfile = useCompany((state) => state.update);
  const name = userName(profile, t('company.userFallback'));
  const chatActive = location.pathname.startsWith('/chat') || location.pathname === '/';
  const runtimeActive = location.pathname.startsWith('/runtime');
  const skillsActive = location.pathname.startsWith('/skills');

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
    <aside className="buddy-rail relative z-40 flex w-[90px] shrink-0 flex-col items-center justify-between py-4 select-none">
      <div className="flex flex-col items-center">
        <div className="buddy-traffic mb-5 flex items-center gap-[7px]" aria-hidden>
          <span className="size-[11px] rounded-full bg-[#ff5f57]" />
          <span className="size-[11px] rounded-full bg-[#febc2e]" />
          <span className="size-[11px] rounded-full bg-[#28c840]" />
        </div>
        <button
          type="button"
          onClick={() => navigate('/chat')}
          className="flex flex-col items-center"
          title="Buddy"
        >
          <BuddyMark size="lg" />
          <span className="mt-1.5 text-[15px] font-bold tracking-tight text-[#18221e]">Buddy</span>
        </button>
        <div className="mt-5 flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => navigate('/chat')}
            aria-label={t('nav.im')}
            aria-current={chatActive ? 'page' : undefined}
            title={t('nav.im')}
            className={cn('buddy-rail-button relative', chatActive && 'buddy-rail-button-active')}
          >
            <MessageCircle size={21} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/runtime')}
            aria-label={t('nav.runtime')}
            aria-current={runtimeActive ? 'page' : undefined}
            title={t('nav.runtime')}
            className={cn(
              'buddy-rail-button relative',
              runtimeActive && 'buddy-rail-button-active',
            )}
          >
            <Activity size={20} strokeWidth={1.85} />
          </button>
          <button
            type="button"
            onClick={() => navigate('/skills')}
            aria-label={t('nav.skills')}
            aria-current={skillsActive ? 'page' : undefined}
            title={t('nav.skills')}
            className={cn('buddy-rail-button relative', skillsActive && 'buddy-rail-button-active')}
          >
            <Grid3X3 size={19} strokeWidth={1.8} />
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
          <Settings size={19} strokeWidth={1.75} />
        </button>
        <div ref={identityRef} className="relative">
          <button
            type="button"
            data-testid="identity-trigger"
            onClick={() => setIdentityOpen((open) => !open)}
            aria-label={t('titleBar.profile')}
            aria-expanded={identityOpen}
            className="flex rounded-full border border-white/80 shadow-sm transition hover:ring-2 hover:ring-[#22b560]/25"
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
