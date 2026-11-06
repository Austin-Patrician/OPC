import { Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useCompanySync } from '@/entities/company/model/useCompany';
import { useBillingSync } from '@/entities/billing/model/useBilling';
import { useChatRuntime } from '@/features/chat/model/useChatRuntime';
import { BackgroundLayer } from '@/shared/ui/BackgroundLayer';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { NavRail } from '@/widgets/nav-rail/NavRail';
import { TitleBar } from '@/widgets/title-bar/TitleBar';

/**
 * One rounded desktop window contains the navigation rail and routed content.
 * The title bar belongs to the content column so it doesn't split the rail away
 * from the page. `min-h-0` keeps chat scrolling independent from the composer.
 */
export function AppShell() {
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  useCompanySync();
  useBillingSync();
  const { conversations } = useChatRuntime();
  const background = useUiPrefs((state) => state.background);

  const unreadTotal = conversations.reduce((total, item) => total + (item.unreadCount ?? 0), 0);

  return (
    <div className="buddy-viewport relative isolate flex h-full w-full overflow-hidden">
      <BackgroundLayer kind={background.kind} url={background.url} />
      <div className="buddy-desktop relative z-10 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="buddy-layout relative flex min-h-0 flex-1 overflow-hidden">
          <NavRail unreadTotal={unreadTotal} />
          <div className="buddy-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <TitleBar
              searchEnabled={location.pathname.startsWith('/chat')}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              onToggleSearch={() => setSearchOpen((open) => !open)}
              onSearchQueryChange={setSearchQuery}
              onCloseSearch={() => {
                setSearchOpen(false);
                setSearchQuery('');
              }}
            />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <Outlet context={{ searchQuery }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
