import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from './AppShell';
import { ThemeSync } from './ThemeSync';
import { OnboardingGuide } from '@/features/onboarding/ui/OnboardingGuide';
import { AttentionPage } from '@/pages/attention/AttentionPage';
import { CapabilitiesPage } from '@/pages/capabilities/CapabilitiesPage';
import { ChatPage } from '@/pages/chat/ChatPage';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { IssueListPage } from '@/pages/issues/IssueListPage';
import { ProjectsPage } from '@/pages/projects/ProjectsPage';
import { NotificationsPage } from '@/pages/notifications/NotificationsPage';
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
          {/* 老板打开应用先看到"有什么事需要我"，不是会话列表。 */}
          <Route index element={<Navigate to="/attention" replace />} />
          <Route path="attention" element={<AttentionPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="chat/:conversationId" element={<ChatPage />} />
          <Route path="issues" element={<IssueListPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="skills" element={<CapabilitiesPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {/* First-run guide: overlays the shell until the install has completed it. */}
      <OnboardingGuide />
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
