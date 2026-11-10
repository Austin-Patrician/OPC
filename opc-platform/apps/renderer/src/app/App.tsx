import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from './AppShell';
import { ThemeSync } from './ThemeSync';
import { OnboardingGuide } from '@/features/onboarding/ui/OnboardingGuide';
import { CapabilitiesPage } from '@/pages/capabilities/CapabilitiesPage';
import { ChatPage } from '@/pages/chat/ChatPage';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { SchedulesPage } from '@/pages/schedules/SchedulesPage';

const SystemRuntimeView = lazy(() =>
  import('@/pages/runtime/SystemRuntimeView').then(({ SystemRuntimeView: view }) => ({
    default: view,
  })),
);

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
          {/* 对话是唯一的人机入口；旧的注意力深链接统一回到 Router。 */}
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="attention" element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="chat/:conversationId" element={<ChatPage />} />
          <Route path="skills" element={<CapabilitiesPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="runtime" element={<RuntimeRoute />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {/* First-run guide: overlays the shell until the install has completed it. */}
      <OnboardingGuide />
    </HashRouter>
  );
}

function RuntimeRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[#F2EEE7] font-mono text-[11px] uppercase tracking-[0.18em] text-[#9A9389]">
          Loading runtime…
        </div>
      }
    >
      <SystemRuntimeView />
    </Suspense>
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
