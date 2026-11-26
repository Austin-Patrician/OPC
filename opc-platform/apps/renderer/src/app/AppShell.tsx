import { useLocation, useOutlet } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssistantActivity } from '@opc/shared/ipc';
import { useCompanySync } from '@/entities/company/model/useCompany';
import { useBillingSync } from '@/entities/billing/model/useBilling';
import { BackgroundLayer } from '@/shared/ui/BackgroundLayer';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { NavRail } from '@/widgets/nav-rail/NavRail';
import { TitleBar } from '@/widgets/title-bar/TitleBar';
import { BuddyCompanion } from '@/widgets/buddy-companion/BuddyCompanion';
import { ChatSearchModal } from '@/features/chat/ui/ChatSearchModal';
import { NewChatConfirmModal } from '@/features/chat/ui/NewChatConfirmModal';
import { useObservatory } from '@/features/observatory/model/useObservatory';
import { ExecutionObservatoryDrawer } from '@/features/observatory/ui/ExecutionObservatoryDrawer';
import { OfficePreviewModal } from '@/features/doc-preview/ui/OfficePreviewModal';

/**
 * One rounded desktop window contains the navigation rail and routed content.
 * The title bar belongs to the content column so it doesn't split the rail away
 * from the page. `min-h-0` keeps chat scrolling independent from the composer.
 */
export function AppShell() {
  const location = useLocation();
  const isChat = location.pathname.startsWith('/chat') || location.pathname === '/';
  const [searchOpen, setSearchOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [observatoryOpen, setObservatoryOpen] = useState(false);
  const [chatActivity, setChatActivity] = useState<AssistantActivity>();
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const outlet = useOutlet({ setChatActivity, setWelcomeVisible });
  // Keep the chat subtree mounted so Virtuoso retains its measured rows and scroll position.
  const cachedChatOutlet = useRef<ReactNode>(null);
  if (isChat && outlet) cachedChatOutlet.current = outlet;
  useCompanySync();
  useBillingSync();
  const background = useUiPrefs((state) => state.background);
  const observatory = useObservatory(observatoryOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isChat || welcomeVisible || searchOpen) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'n') {
        event.preventDefault();
        setNewChatOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'i') {
        event.preventDefault();
        setObservatoryOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isChat, welcomeVisible, searchOpen]);

  return (
    <div className="buddy-viewport relative isolate flex h-full w-full overflow-hidden">
      <BackgroundLayer kind={background.kind} url={background.url} />
      <div className="buddy-desktop relative z-10 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="buddy-layout relative flex min-h-0 flex-1 overflow-hidden">
          <NavRail />
          <div className="buddy-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <TitleBar
              floating={!isChat && !observatoryOpen}
              searchEnabled={isChat}
              onToggleSearch={() => setSearchOpen((open) => !open)}
              newChatEnabled={isChat}
              newChatDisabled={welcomeVisible}
              onNewChat={() => setNewChatOpen(true)}
              showChatStatus={isChat}
              chatActivity={isChat ? chatActivity : undefined}
              observatoryEnabled={isChat || observatoryOpen}
              observatoryOpen={observatoryOpen}
              observatoryStatus={observatory.badge.status}
              onToggleObservatory={() => setObservatoryOpen((open) => !open)}
            />
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <div
                  aria-hidden={!isChat}
                  inert={!isChat}
                  className={`absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden ${isChat ? 'visible' : 'invisible pointer-events-none'}`}
                >
                  {isChat ? outlet : cachedChatOutlet.current}
                </div>
                {!isChat ? (
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {outlet}
                  </div>
                ) : null}
              </div>
              <ExecutionObservatoryDrawer
                open={observatoryOpen}
                onClose={() => setObservatoryOpen(false)}
                observatory={observatory}
              />
            </div>
          </div>
        </div>
        <BuddyCompanion
          activity={chatActivity}
          hidden={isChat && welcomeVisible}
          isOnChatPage={isChat}
        />
      </div>
      {searchOpen ? <ChatSearchModal onClose={() => setSearchOpen(false)} /> : null}
      {newChatOpen ? <NewChatConfirmModal onClose={() => setNewChatOpen(false)} /> : null}
      <OfficePreviewModal />
    </div>
  );
}
