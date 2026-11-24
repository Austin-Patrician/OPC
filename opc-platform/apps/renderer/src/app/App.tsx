import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from './AppShell';
import { ThemeSync } from './ThemeSync';
import { OnboardingGuide } from '@/features/onboarding/ui/OnboardingGuide';
import { ChatPage } from '@/pages/chat/ChatPage';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { SchedulesPage } from '@/pages/schedules/SchedulesPage';

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
          {/* 对话是唯一的人机入口；旧的注意力/运行态深链接统一回到 Router。 */}
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="attention" element={<Navigate to="/chat" replace />} />
          <Route path="runtime" element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="chat/:conversationId" element={<ChatPage />} />
          {/* 技能与工具已并入设置：旧深链接重定向到对应的设置子页。 */}
          <Route path="skills" element={<Navigate to="/settings?page=capabilitiesSkills" replace />} />
          <Route path="schedules" element={<SchedulesPage />} />
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
