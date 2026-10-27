import {
  Archive,
  Grid3x3,
  Hash,
  Mail,
  Menu,
  MessageSquare,
  Smartphone,
  Star,
  UsersRound,
  FolderKanban,
  SquareKanban,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { cn } from '@/shared/lib/cn';

const PRIMARY_NAV = [
  { to: '/chat', icon: MessageSquare, labelKey: 'nav.im' },
  { to: '/issues', icon: SquareKanban, labelKey: 'nav.issues' },
  { to: '/org', icon: UsersRound, labelKey: 'nav.org' },
  { to: '/projects', icon: FolderKanban, labelKey: 'nav.projects' },
  { to: '/market', icon: Star, labelKey: 'nav.market', dot: true },
  { to: '/channels', icon: Hash, labelKey: 'nav.channels' },
  { to: '/deliverables', icon: Archive, labelKey: 'nav.deliverables' },
  { to: '/skills', icon: Grid3x3, labelKey: 'nav.skills' },
] as const;

const SECONDARY_NAV = [
  { to: '/notifications', icon: Mail, labelKey: 'nav.mail', dot: true },
  { to: '/device', icon: Smartphone, labelKey: 'nav.device' },
  { to: '/settings', icon: Menu, labelKey: 'nav.menu' },
] as const;

/** 58px persistent navigation rail. */
export function NavRail({ unreadTotal }: { unreadTotal: number }) {
  const { t } = useTranslation();

  return (
    <nav className="flex w-rail shrink-0 flex-col items-center justify-between border-r border-line bg-rail py-3.5 select-none surface-blur">
      <div className="flex flex-col items-center gap-4">
        {PRIMARY_NAV.map(({ to, icon: Icon, labelKey, ...rest }) => (
          <NavLink
            key={to}
            to={to}
            title={t(labelKey)}
            aria-label={t(labelKey)}
            className={({ isActive }) =>
              cn(
                'relative flex size-10 items-center justify-center rounded-xl transition-colors',
                isActive ? 'bg-accent-soft text-accent' : 'text-ink-secondary hover:bg-ink/5',
              )
            }
          >
            <Icon className="size-[1.375rem]" strokeWidth={1.7} />
            {'dot' in rest && rest.dot ? (
              <span className="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-danger" />
            ) : null}
            {to === '/chat' && unreadTotal > 0 ? (
              <span className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-danger px-1 text-[0.5625rem] leading-4 font-medium text-white">
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>

      <div className="flex flex-col items-center gap-3.5">
        {SECONDARY_NAV.map(({ to, icon: Icon, labelKey, ...rest }) => (
          <NavLink
            key={to}
            to={to}
            title={t(labelKey)}
            aria-label={t(labelKey)}
            className={({ isActive }) =>
              cn(
                'relative flex size-9 items-center justify-center rounded-lg transition-colors',
                isActive ? 'bg-accent-soft text-accent' : 'text-ink-secondary hover:bg-ink/5',
              )
            }
          >
            <Icon className="size-[1.25rem]" strokeWidth={1.6} />
            {'dot' in rest && rest.dot ? (
              <span className="absolute top-1 right-1 size-[7px] rounded-full bg-danger" />
            ) : null}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
