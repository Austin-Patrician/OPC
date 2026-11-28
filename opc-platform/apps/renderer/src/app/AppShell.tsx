import { useLocation, useNavigate, useOutlet } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssistantActivity, BuddyOverlayState } from '@opc/shared/ipc';
import { useCompanySync } from '@/entities/company/model/useCompany';
import { useBillingSync } from '@/entities/billing/model/useBilling';
import { BackgroundLayer } from '@/shared/ui/BackgroundLayer';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { subscribeBuddySignal } from '@/shared/ui/buddyEvents';
import { NavRail } from '@/widgets/nav-rail/NavRail';
import { TitleBar } from '@/widgets/title-bar/TitleBar';
import { BuddyCompanion } from '@/widgets/buddy-companion/BuddyCompanion';
import { ChatSearchModal } from '@/features/chat/ui/ChatSearchModal';
import { NewChatConfirmModal } from '@/features/chat/ui/NewChatConfirmModal';
import { useObservatory } from '@/features/observatory/model/useObservatory';
import { ExecutionObservatoryDrawer } from '@/features/observatory/ui/ExecutionObservatoryDrawer';
import { OfficePreviewModal } from '@/features/doc-preview/ui/OfficePreviewModal';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * One rounded desktop window contains the navigation rail and routed content.
 * The title bar belongs to the content column so it doesn't split the rail away
 * from the page. `min-h-0` keeps chat scrolling independent from the composer.
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
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
  const themeMode = useUiPrefs((state) => state.themeMode);
  const locale = useUiPrefs((state) => state.locale);
  const buddyCompanion = useUiPrefs((state) => state.buddyCompanion);
  const updateBuddyCompanion = useUiPrefs((state) => state.updateBuddyCompanion);
  const [prefersDark, setPrefersDark] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(DARK_MEDIA_QUERY).matches),
  );
  const observatory = useObservatory(observatoryOpen);
  const isChatRef = useRef(isChat);
  isChatRef.current = isChat;
  const focusTargetRef = useRef(observatory.focusTarget);
  focusTargetRef.current = observatory.focusTarget;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    themeMode === 'dark' || (themeMode === 'system' && prefersDark) ? 'dark' : 'light';
  const useDesktopBuddyOverlay = Boolean(window.opc?.buddy) && buddyCompanion.desktopFloat;

  useEffect(() => {
    const bridge = window.opc?.buddy;
    if (!bridge) return;
    const payload: BuddyOverlayState = {
      enabled: buddyCompanion.enabled,
      desktopFloat: buddyCompanion.desktopFloat,
      alwaysOnTop: buddyCompanion.alwaysOnTop,
      size: buddyCompanion.size,
      dock: buddyCompanion.dock,
      bubbles: buddyCompanion.bubbles,
      screenPosition: buddyCompanion.screenPosition,
      hidden: isChat && welcomeVisible,
      isOnChatPage: isChat,
      ...(chatActivity ? { activity: chatActivity } : {}),
      theme: resolvedTheme,
      locale,
    };
    void bridge.syncState(payload);
  }, [buddyCompanion, chatActivity, isChat, locale, resolvedTheme, welcomeVisible]);

  useEffect(() => {
    if (!useDesktopBuddyOverlay) return undefined;
    const bridge = window.opc?.buddy;
    if (!bridge) return undefined;
    return subscribeBuddySignal((signal) => {
      if (
        signal.kind === 'typing' ||
        signal.kind === 'file-drag' ||
        signal.kind === 'file-drop' ||
        signal.kind === 'sent' ||
        signal.kind === 'brand-summon'
      ) {
        void bridge.emitSignal(signal);
      }
    });
  }, [useDesktopBuddyOverlay]);

  useEffect(() => {
    const bridge = window.opc?.buddy;
    if (!bridge) return undefined;
    const unsubPrefs = bridge.onPrefsPatch((patch) => {
      updateBuddyCompanion(patch);
    });
    const unsubNav = bridge.onNavigate((route) => {
      if (route && route !== location.pathname) {
        navigate(route);
      }
    });
    return () => {
      unsubPrefs();
      unsubNav();
    };
  }, [location.pathname, navigate, updateBuddyCompanion]);

  useEffect(() => {
    void window.opc?.notifications?.setContext({
      route: isChat ? 'chat' : 'other',
      locale,
    });
  }, [isChat, locale]);

  useEffect(() => {
    const onAction = window.opc?.notifications?.onAction;
    if (!onAction) return undefined;
    return onAction((event) => {
      if (!isChatRef.current) {
        navigate('/chat');
      }
      if (event.target.kind === 'observatory') {
        focusTargetRef.current(event.target.threadId, event.target.taskId);
        setObservatoryOpen(true);
      }
    });
  }, [navigate]);

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
      <BackgroundLayer
        background={background}
        isOpaqueRoute={!isChat && !location.pathname.startsWith('/settings')}
      />
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
        {!useDesktopBuddyOverlay ? (
          <BuddyCompanion
            activity={chatActivity}
            hidden={isChat && welcomeVisible}
            isOnChatPage={isChat}
          />
        ) : null}
      </div>
      {searchOpen ? <ChatSearchModal onClose={() => setSearchOpen(false)} /> : null}
      {newChatOpen ? <NewChatConfirmModal onClose={() => setNewChatOpen(false)} /> : null}
      <OfficePreviewModal />
    </div>
  );
}
