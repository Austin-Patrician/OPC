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
  Wallet,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import type { Conversation } from '@/entities/conversation/model/types';
import { cn } from '@/shared/lib/cn';
import { RailSearch } from './RailSearch';

const PRIMARY_NAV = [
  { to: '/chat', icon: MessageSquare, labelKey: 'nav.im' },
  { to: '/issues', icon: SquareKanban, labelKey: 'nav.issues' },
  { to: '/org', icon: UsersRound, labelKey: 'nav.org' },
  { to: '/projects', icon: FolderKanban, labelKey: 'nav.projects' },
  { to: '/market', icon: Star, labelKey: 'nav.market', dot: true },
  { to: '/budget', icon: Wallet, labelKey: 'nav.budget' },
  { to: '/channels', icon: Hash, labelKey: 'nav.channels' },
  { to: '/deliverables', icon: Archive, labelKey: 'nav.deliverables' },
  { to: '/skills', icon: Grid3x3, labelKey: 'nav.skills' },
] as const;

const SECONDARY_NAV = [
  { to: '/notifications', icon: Mail, labelKey: 'nav.mail', dot: true },
  { to: '/device', icon: Smartphone, labelKey: 'nav.device' },
  { to: '/settings', icon: Menu, labelKey: 'nav.menu' },
] as const;

const rowClass = (isActive: boolean) =>
  cn(
    'group relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
    isActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-secondary hover:bg-ink/5 hover:text-ink',
  );

/**
 * 160px persistent navigation: a conversation search, then icon + name rows.
 *
 * It sits directly on the shell's chrome plane — no rail background, no border —
 * so the only edge between it and the routed view is the rounded body card. The
 * labels are what let the rail be scanned instead of hovered; badges keep their
 * place at the right edge so an unread count never pushes the label around.
 *
 * Only the primary list scrolls: the search results panel is anchored above it,
 * and an `overflow` ancestor there would clip the panel.
 */
export function NavRail({
  conversations,
  unreadTotal,
}: {
  conversations: readonly Conversation[];
  unreadTotal: number;
}) {
  const { t } = useTranslation();

  return (
    <nav className="flex w-rail shrink-0 flex-col pt-[1.375rem] select-none">
      <RailSearch conversations={conversations} />

      <div className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {PRIMARY_NAV.map(({ to, icon: Icon, labelKey, ...rest }) => (
          <NavLink key={to} to={to} title={t(labelKey)} className={({ isActive }) => rowClass(isActive)}>
            <Icon className="size-[1.125rem] shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
            {'dot' in rest && rest.dot ? (
              <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-danger" />
            ) : null}
            {to === '/chat' && unreadTotal > 0 ? (
              <span className="shrink-0 rounded-full bg-danger px-1 text-[0.5625rem] leading-4 font-medium text-white">
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>

      <div className="mt-2 shrink-0 space-y-0.5">
        {SECONDARY_NAV.map(({ to, icon: Icon, labelKey, ...rest }) => (
          <NavLink key={to} to={to} title={t(labelKey)} className={({ isActive }) => rowClass(isActive)}>
            <Icon className="size-4 shrink-0" strokeWidth={1.7} />
            <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
            {'dot' in rest && rest.dot ? (
              <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-danger" />
            ) : null}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
