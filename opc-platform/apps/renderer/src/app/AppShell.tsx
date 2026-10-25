import { Outlet, useNavigate } from 'react-router-dom';
import { useChatRuntime } from '@/features/chat/model/useChatRuntime';
import { BackgroundLayer } from '@/shared/ui/BackgroundLayer';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { NavRail } from '@/widgets/nav-rail/NavRail';
import { TitleBar } from '@/widgets/title-bar/TitleBar';

/**
 * Application chrome: wallpaper → title bar → rail → routed view.
 * Everything inside is a flex row/column with `min-h-0`, which is what keeps the
 * chat scroller from pushing the composer off-screen at any interface scale.
 */
export function AppShell() {
  const navigate = useNavigate();
  const { conversations, agents, departments } = useChatRuntime();
  const background = useUiPrefs((state) => state.background);

  const unreadTotal = conversations.reduce((total, item) => total + (item.unreadCount ?? 0), 0);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app">
      <BackgroundLayer kind={background.kind} url={background.url} />

      <TitleBar
        departmentCount={departments.length}
        agentCount={agents.length}
        onOpenOrg={() => navigate('/org')}
        onOpenMarket={() => navigate('/market')}
        onOpenSettings={() => navigate('/settings')}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <NavRail unreadTotal={unreadTotal} />
        <Outlet />
      </div>
    </div>
  );
}
