import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from './AppShell';
import { ThemeSync } from './ThemeSync';
import { ChatPage } from '@/pages/chat/ChatPage';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import {
  ChannelsPage,
  DeliverablesPage,
  DevicePage,
  SkillsPage,
} from '@/pages/placeholder/staticPages';
import { IssueListPage } from '@/pages/issues/IssueListPage';
import { MarketPage } from '@/pages/market/MarketPage';
import { NotificationsPage } from '@/pages/notifications/NotificationsPage';
import { OrgPage } from '@/pages/org/OrgPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';

/**
 * Hash routing keeps deep links working from `file://` inside the packaged app
 * (and from the dev server) without any server-side rewrites.
 */
export function App() {
  // Electron-only by design: without the preload bridge there is no data layer.
  if (!window.opc) return <DesktopOnlyNotice />;

  return (
    <HashRouter>
      <ThemeSync />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="chat/:conversationId" element={<ChatPage />} />
          <Route path="org" element={<OrgPage />} />
          <Route path="market" element={<MarketPage />} />
          <Route path="issues" element={<IssueListPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="deliverables" element={<DeliverablesPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="device" element={<DevicePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

function DesktopOnlyNotice() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full items-center justify-center bg-app p-6">
      <div className="max-w-md space-y-2 rounded-xl border border-line bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold text-ink">{t('desktopOnly.title')}</h1>
        <p className="text-sm leading-relaxed text-ink-secondary">{t('desktopOnly.description')}</p>
      </div>
    </div>
  );
}
