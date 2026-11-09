import { Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import type { AssistantActivity } from '@opc/shared/ipc';
import { useCompanySync } from '@/entities/company/model/useCompany';
import { useBillingSync } from '@/entities/billing/model/useBilling';
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
  const [chatActivity, setChatActivity] = useState<AssistantActivity>();
  useCompanySync();
  useBillingSync();
  const background = useUiPrefs((state) => state.background);

  const isRuntime = location.pathname.startsWith('/runtime');

  return (
    <div className="buddy-viewport relative isolate flex h-full w-full overflow-hidden">
      <BackgroundLayer kind={background.kind} url={background.url} />
      <div className="buddy-desktop relative z-10 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="buddy-layout relative flex min-h-0 flex-1 overflow-hidden">
          <NavRail />
          <div
            className={`buddy-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${isRuntime ? 'buddy-runtime-main' : ''}`}
          >
            {isRuntime ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-50">
                <div className="pointer-events-auto">
                  <TitleBar
                    searchEnabled={false}
                    searchOpen={false}
                    searchQuery=""
                    onToggleSearch={() => undefined}
                    onSearchQueryChange={() => undefined}
                    onCloseSearch={() => undefined}
                    overlay
                  />
                </div>
              </div>
            ) : (
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
                showChatStatus={location.pathname.startsWith('/chat')}
                chatActivity={location.pathname.startsWith('/chat') ? chatActivity : undefined}
              />
            )}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <Outlet context={{ searchQuery, setChatActivity }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
