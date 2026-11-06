import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Grid3X3,
  Inbox,
  Menu,
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

const MORE = [
  { to: '/attention', icon: Inbox, key: 'nav.attention' },
  { to: '/skills', icon: Grid3X3, key: 'nav.skills' },
] as const;

export function NavRail({ unreadTotal }: { unreadTotal: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const identityRef = useRef<HTMLDivElement>(null);
  const profile = useCompanyProfile();
  const updateProfile = useCompany((state) => state.update);
  const name = userName(profile, t('company.userFallback'));
  const chatActive = location.pathname.startsWith('/chat') || location.pathname === '/';

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
    <aside className="buddy-rail flex w-[90px] shrink-0 flex-col items-center justify-between py-4 select-none">
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
            {unreadTotal > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-[#e75555] px-1 text-[9px] leading-4 text-white">
                {unreadTotal > 9 ? '9+' : unreadTotal}
              </span>
            ) : null}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-label={t('nav.menu')}
              title={t('nav.menu')}
              className={cn('buddy-rail-button', menuOpen && 'buddy-rail-button-active')}
            >
              <Menu size={19} strokeWidth={1.8} />
            </button>
            {menuOpen ? (
              <div className="buddy-more-menu absolute top-0 left-[54px] z-50 w-48 rounded-xl border border-white/80 bg-white/95 p-1.5 shadow-[0_14px_40px_rgba(28,57,42,.14)] backdrop-blur-xl">
                {MORE.map(({ to, icon: Icon, key }) => (
                  <button
                    key={to}
                    type="button"
                    onClick={() => {
                      navigate(to);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[#435149] transition hover:bg-[#edf7f0] hover:text-[#168848]"
                  >
                    <Icon size={15} strokeWidth={1.8} />
                    <span className="flex-1">{t(key)}</span>
                    {location.pathname === to ? <ChevronRight size={13} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
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
