import { Outlet, useNavigate } from 'react-router-dom';
import { useCompanySync } from '@/entities/company/model/useCompany';
import { useChatRuntime } from '@/features/chat/model/useChatRuntime';
import { BackgroundLayer } from '@/shared/ui/BackgroundLayer';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { NavRail } from '@/widgets/nav-rail/NavRail';
import { TitleBar } from '@/widgets/title-bar/TitleBar';

/**
 * Application chrome: wallpaper → title bar → rail → routed view.
 *
 * The title bar and the navigation rail share one chrome plane; the routed view is
 * an inset rounded card on top of it. That is what lets the header lose its
 * divider — the card's own edge is the only line between the rail and the body.
 * Everything inside is a flex row/column with `min-h-0`, which keeps the chat
 * scroller from pushing the composer off-screen at any interface scale.
 */
export function AppShell() {
  const navigate = useNavigate();
  useCompanySync();
  const { conversations } = useChatRuntime();
  const background = useUiPrefs((state) => state.background);

  const unreadTotal = conversations.reduce((total, item) => total + (item.unreadCount ?? 0), 0);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-chrome">
      <BackgroundLayer kind={background.kind} url={background.url} />

      <TitleBar onOpenSettings={() => navigate('/settings')} />

      {/* No top padding: the body card starts on the title bar's bottom edge, so
          the native Windows caption buttons sit directly on it. The rail keeps its
          own top inset to clear the avatar that hangs over the chrome edge. */}
      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2">
        <NavRail conversations={conversations} unreadTotal={unreadTotal} />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-panel shadow-card">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
