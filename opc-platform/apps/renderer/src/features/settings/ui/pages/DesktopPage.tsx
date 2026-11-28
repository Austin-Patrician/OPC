import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Check,
  Download,
  EyeOff,
  Loader2,
  MoreHorizontal,
  MousePointerClick,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  DesktopAppView,
  DesktopApprovalCategory,
  DesktopInstallPhase,
  DesktopInstallProgress,
  DesktopSettings,
  DesktopStatus,
} from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';
import { buttonClass, Note, PageHeader, Row, Section, StatusBadge, Toggle } from '../kit';

const DEFAULT_SETTINGS: DesktopSettings = {
  enabled: false,
  controlMode: 'hybrid',
  cursorOverlay: true,
  blockedApps: [],
  requireApprovalFor: ['send-message', 'destructive', 'payment', 'quit-app'],
};

const APPROVAL_CATEGORIES: readonly DesktopApprovalCategory[] = [
  'send-message',
  'destructive',
  'payment',
  'quit-app',
  'system-settings',
];

const SUGGESTED_PROTECTED_APPS = [
  '钥匙串访问',
  '1Password',
  'Bitwarden',
  '系统设置',
  '微信',
  '支付宝',
] as const;

export function DesktopPage() {
  const { t } = useTranslation();
  const bridge = window.opc?.desktop;
  const blockedInputId = useId();

  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [installProgress, setInstallProgress] = useState<DesktopInstallProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [customAppInput, setCustomAppInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [runningApps, setRunningApps] = useState<DesktopAppView[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appSearch, setAppSearch] = useState('');

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        bridge.status(),
        bridge.getSettings(),
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    if (!bridge) return undefined;
    const unsubscribeStatus = bridge.onChanged((next) => setStatus(next));
    const unsubscribeProgress = bridge.onInstallProgress(setInstallProgress);
    return () => {
      unsubscribeStatus();
      unsubscribeProgress();
    };
  }, [bridge, load]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const save = async (patch: Partial<DesktopSettings>) => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.setSettings(patch);
      setSettings(next);
      setStatus(await bridge.status());
      setNotice(t('settings.desktop.savedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!bridge) return;
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await bridge.install();
      setStatus(next);
      setSettings(await bridge.getSettings());
      if (next.installState === 'error') {
        setError(next.error ?? t('settings.desktop.installFailed'));
      } else if (next.installState === 'permission-required') {
        setNotice(t('settings.desktop.permissionRequiredNotice'));
      } else {
        setNotice(t('settings.desktop.installedNotice'));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstallProgress(null);
      setBusy(false);
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (!bridge || !window.confirm(t('settings.desktop.confirmRemove'))) return;
    setBusy(true);
    try {
      setStatus(await bridge.uninstall(true));
      setSettings(await bridge.getSettings());
      setNotice(t('settings.desktop.removedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const permission = async (guide = false) => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await (guide ? bridge.permissionsGuide() : bridge.permissions()));
      setNotice(
        guide
          ? t('settings.desktop.permissionGuideOpened')
          : t('settings.desktop.permissionRefreshed'),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleRunningAppsPicker = async () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
    if (!bridge || appsLoading) return;
    setAppsLoading(true);
    try {
      setRunningApps(await bridge.listApps());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAppsLoading(false);
    }
  };

  const addBlockedApp = (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const exists = settings.blockedApps.some(
      (entry) => entry.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setCustomAppInput('');
      return;
    }
    setCustomAppInput('');
    void save({ blockedApps: [...settings.blockedApps, trimmed] });
  };

  const removeBlockedApp = (target: string) => {
    void save({
      blockedApps: settings.blockedApps.filter(
        (entry) => entry.toLowerCase() !== target.toLowerCase(),
      ),
    });
  };

  const toggleRunningAppBlocked = (app: DesktopAppView) => {
    const matched = settings.blockedApps.find(
      (entry) =>
        entry.toLowerCase() === app.name.toLowerCase() ||
        (app.bundleId && entry.toLowerCase() === app.bundleId.toLowerCase()),
    );
    if (matched) {
      removeBlockedApp(matched);
    } else {
      addBlockedApp(app.name);
    }
  };

  const toggleApprovalCategory = (category: DesktopApprovalCategory, checked: boolean) => {
    const next = checked
      ? [...new Set([...settings.requireApprovalFor, category])]
      : settings.requireApprovalFor.filter((item) => item !== category);
    void save({ requireApprovalFor: next });
  };

  const statusMeta = (() => {
    if (!status) {
      return {
        tone: 'gray' as const,
        label: t('settings.desktop.status.connecting'),
        detail: t('settings.desktop.status.connectingDetail'),
      };
    }
    if (status.installState === 'installing') {
      return {
        tone: 'amber' as const,
        label: t('settings.desktop.status.installing'),
        detail: t('settings.desktop.status.installingDetail'),
      };
    }
    if (status.installState === 'permission-required') {
      return {
        tone: 'amber' as const,
        label: t('settings.desktop.status.permissionRequired'),
        detail: t('settings.desktop.status.permissionRequiredDetail'),
      };
    }
    if (status.installState === 'error') {
      return {
        tone: 'red' as const,
        label: t('settings.desktop.status.error'),
        detail: status.error ?? t('settings.desktop.status.errorDetail'),
      };
    }
    if (status.installState === 'uninstalled') {
      return {
        tone: 'gray' as const,
        label: t('settings.desktop.status.uninstalled'),
        detail: t('settings.desktop.status.uninstalledDetail'),
      };
    }
    if (status.enabled && status.healthy) {
      return {
        tone: 'green' as const,
        label: t('settings.desktop.status.enabled'),
        detail:
          status.permissions.screenRecording === 'denied' && settings.controlMode === 'hybrid'
            ? t('settings.desktop.status.enabledNoScreenDetail')
            : t('settings.desktop.status.enabledDetail'),
      };
    }
    return {
      tone: 'gray' as const,
      label: t('settings.desktop.status.installed'),
      detail: t('settings.desktop.status.installedDetail'),
    };
  })();

  const installPhaseLabel = (phase: DesktopInstallPhase): string => {
    if (phase === 'download') return t('settings.desktop.installPhase.download');
    if (phase === 'verify') return t('settings.desktop.installPhase.verify');
    if (phase === 'extract') return t('settings.desktop.installPhase.extract');
    if (phase === 'activate') return t('settings.desktop.installPhase.activate');
    return t('settings.desktop.installPhase.permissions');
  };

  const hasBinary = Boolean(status?.binary);
  const installed = Boolean(status?.runtimeHealthy) && status?.installState !== 'permission-required';
  const accessibilityGranted = status?.permissions.accessibility === 'granted';
  const screenDenied = status?.permissions.screenRecording === 'denied';
  const screenGranted =
    status?.permissions.screenRecording === 'granted' ||
    status?.permissions.screenRecording === 'not_required';

  const blockedSet = useMemo(
    () => new Set(settings.blockedApps.map((item) => item.toLowerCase())),
    [settings.blockedApps],
  );

  const visibleRunningApps = useMemo(() => {
    const q = appSearch.trim().toLowerCase();
    const list = q
      ? runningApps.filter(
          (app) =>
            app.name.toLowerCase().includes(q) ||
            (app.bundleId ?? '').toLowerCase().includes(q),
        )
      : runningApps;
    return list.slice(0, 40);
  }, [appSearch, runningApps]);

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.computerUse'), t('settings.page.desktop')]}
        title={t('settings.desktop.title')}
        description={t('settings.desktop.description')}
        actions={
          hasBinary ? (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-label={t('settings.desktop.moreActions')}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                disabled={busy}
                onClick={() => setMenuOpen((prev) => !prev)}
                className={buttonClass.icon}
              >
                <MoreHorizontal className="size-4 shrink-0" />
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute top-full right-0 z-20 mt-1.5 w-44 rounded-xl border border-line bg-surface p-1 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.12)]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || status?.installState === 'installing'}
                    onClick={() => void install()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
                  >
                    <RefreshCw className="size-3.5 text-ink-tertiary" />
                    <span>{t('settings.desktop.reinstall')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" />
                    <span>{t('settings.desktop.removeRuntime')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-xl border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary">
          {notice}
        </div>
      ) : null}

      <div className="space-y-5">
        {/* Status & System Permissions Hero Card */}
        <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-start gap-4">
              <div className="relative grid size-12 shrink-0 place-items-center rounded-2xl border border-accent/25 bg-accent-soft text-accent-ink">
                <AppWindow className="size-6" strokeWidth={1.75} aria-hidden="true" />
                <span
                  className={cn(
                    'absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface',
                    statusMeta.tone === 'green'
                      ? 'bg-success'
                      : statusMeta.tone === 'red'
                        ? 'bg-danger'
                        : statusMeta.tone === 'amber'
                          ? 'bg-warning'
                          : 'bg-ink-quaternary',
                  )}
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="text-base font-semibold text-ink">
                    {t('settings.desktop.heroTitle')}
                  </h3>
                  <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
                </div>
                <p className="mt-1 text-sm text-ink-secondary">{t('settings.desktop.subtitle')}</p>
                <p className="mt-0.5 text-xs text-ink-tertiary">{statusMeta.detail}</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
              {!hasBinary || status?.installState === 'error' ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={busy || !bridge || status?.installState === 'installing'}
                  onClick={() => void install()}
                >
                  {status?.installState === 'installing' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  {status?.installState === 'installing'
                    ? t('settings.desktop.installing')
                    : t('settings.desktop.install')}
                </button>
              ) : status?.installState === 'permission-required' ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={busy}
                  onClick={() => void permission(true)}
                >
                  <Shield className="size-3.5" />
                  {t('settings.desktop.openPermissionSettings')}
                </button>
              ) : (
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-medium text-ink-secondary">
                    {settings.enabled
                      ? t('settings.desktop.switchOn')
                      : t('settings.desktop.switchOff')}
                  </span>
                  <Toggle
                    checked={settings.enabled}
                    disabled={!installed || busy}
                    label={t('settings.desktop.enable')}
                    onChange={(enabled) => void save({ enabled })}
                  />
                </div>
              )}
            </div>
          </div>

          {installProgress ? (
            <div className="border-t border-line bg-surface-muted/35 px-5 py-3.5 sm:px-6">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-ink">
                  {installPhaseLabel(installProgress.phase)}
                </span>
                <span className="font-mono text-2xs text-ink-tertiary tabular-nums">
                  {installProgress.percent}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{
                    width: `${Math.max(4, Math.min(100, installProgress.percent))}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-muted/25 px-5 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <PermissionChip
                label={t('settings.desktop.permAccessibility')}
                granted={accessibilityGranted}
                grantedLabel={t('settings.desktop.permGranted')}
                pendingLabel={t('settings.desktop.permPending')}
              />
              <PermissionChip
                label={t('settings.desktop.permScreenRecording')}
                granted={screenGranted}
                grantedLabel={t('settings.desktop.permGranted')}
                pendingLabel={t('settings.desktop.permPending')}
              />
            </div>

            {hasBinary ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={() => void permission(false)}
                >
                  <RefreshCw className="size-3" />
                  {t('settings.desktop.refreshPermission')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={() => void permission(true)}
                >
                  <Shield className="size-3" />
                  {t('settings.desktop.openPermissionSettings')}
                </button>
              </div>
            ) : null}
          </div>

          {hasBinary && screenDenied ? (
            <div className="border-t border-line px-5 py-3 sm:px-6">
              <Note tone="warn">{t('settings.desktop.screenRecordingMissingHint')}</Note>
            </div>
          ) : null}
        </section>

        {/* Working Mode & Visual Feedback */}
        <Section
          title={t('settings.desktop.modeSectionTitle')}
          description={t('settings.desktop.modeSectionDesc')}
        >
          <Row
            label={
              <span className="inline-flex items-center gap-2">
                <Sparkles
                  className={cn(
                    'size-4',
                    settings.controlMode === 'hybrid' ? 'text-accent-ink' : 'text-ink-tertiary',
                  )}
                />
                <span>{t('settings.desktop.modes.hybridTitle')}</span>
                <span className="rounded-full bg-accent-soft px-1.5 py-px text-2xs font-medium text-accent-ink">
                  {t('settings.desktop.recommendedBadge')}
                </span>
              </span>
            }
            hint={t('settings.desktop.modes.hybridDesc')}
          >
            <Toggle
              checked={settings.controlMode === 'hybrid'}
              disabled={busy}
              label={t('settings.desktop.modes.hybridTitle')}
              onChange={(enabled) => void save({ controlMode: enabled ? 'hybrid' : 'background' })}
            />
          </Row>

          <Row
            label={
              <span className="inline-flex items-center gap-2">
                <EyeOff
                  className={cn(
                    'size-4',
                    settings.controlMode === 'background' ? 'text-accent-ink' : 'text-ink-tertiary',
                  )}
                />
                <span>{t('settings.desktop.modes.backgroundTitle')}</span>
              </span>
            }
            hint={t('settings.desktop.modes.backgroundDesc')}
          >
            <Toggle
              checked={settings.controlMode === 'background'}
              disabled={busy}
              label={t('settings.desktop.modes.backgroundTitle')}
              onChange={(enabled) => void save({ controlMode: enabled ? 'background' : 'hybrid' })}
            />
          </Row>

          <Row
            label={
              <span className="inline-flex items-center gap-2">
                <MousePointerClick className="size-4 text-ink-tertiary" />
                {t('settings.desktop.cursorOverlayTitle')}
              </span>
            }
            hint={t('settings.desktop.cursorOverlayHint')}
          >
            <Toggle
              checked={settings.cursorOverlay}
              disabled={busy}
              label={t('settings.desktop.cursorOverlayTitle')}
              onChange={(cursorOverlay) => void save({ cursorOverlay })}
            />
          </Row>
        </Section>

        {/* Confirm High-Impact Actions */}
        <Section
          title={t('settings.desktop.approvalTitle')}
          description={t('settings.desktop.approvalHint')}
        >
          {APPROVAL_CATEGORIES.map((category) => (
            <Row
              key={category}
              label={t(`settings.desktop.approvalCategories.${category}`)}
              hint={t(`settings.desktop.approvalCategoryHints.${category}`)}
            >
              <Toggle
                checked={settings.requireApprovalFor.includes(category)}
                disabled={busy}
                label={t(`settings.desktop.approvalCategories.${category}`)}
                onChange={(checked) => toggleApprovalCategory(category, checked)}
              />
            </Row>
          ))}
        </Section>

        {/* Protected Apps Blacklist */}
        <Section
          title={t('settings.desktop.blacklistTitle')}
          description={t('settings.desktop.blacklistHint')}
          action={
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy || !bridge}
              onClick={() => void toggleRunningAppsPicker()}
            >
              <AppWindow className="size-3.5" />
              {pickerOpen
                ? t('settings.desktop.closeAppPicker')
                : t('settings.desktop.pickRunningApp')}
            </button>
          }
        >
          <div className="space-y-3 px-4 py-4">

            {settings.blockedApps.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {settings.blockedApps.map((app) => (
                  <span
                    key={app}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2.5 py-1 text-xs font-medium text-ink"
                  >
                    <span>{app}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeBlockedApp(app)}
                      aria-label={t('settings.desktop.removeBlockedApp', { name: app })}
                      className="rounded p-0.5 text-ink-quaternary hover:bg-surface hover:text-danger"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-line bg-surface-muted/25 px-3 py-2 text-xs text-ink-tertiary">
                {t('settings.desktop.blacklistEmpty')}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={blockedInputId} className="sr-only">
                {t('settings.desktop.addAppPlaceholder')}
              </label>
              <input
                id={blockedInputId}
                type="text"
                value={customAppInput}
                disabled={busy}
                onChange={(event) => setCustomAppInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addBlockedApp(customAppInput);
                  }
                }}
                placeholder={t('settings.desktop.addAppPlaceholder')}
                className="h-[30px] min-w-[14rem] flex-1 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-ink-quaternary outline-none focus:border-accent"
              />
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={busy || !customAppInput.trim()}
                onClick={() => addBlockedApp(customAppInput)}
              >
                <Plus className="size-3.5" />
                {t('settings.desktop.addAppButton')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              <span className="text-ink-quaternary">{t('settings.desktop.quickAddLabel')}</span>
              {SUGGESTED_PROTECTED_APPS.filter(
                (name) => !blockedSet.has(name.toLowerCase()),
              ).map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={busy}
                  onClick={() => addBlockedApp(name)}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-3xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                >
                  <Plus className="size-2.5" />
                  {name}
                </button>
              ))}
            </div>

            {pickerOpen ? (
              <div className="mt-2 space-y-2.5 rounded-xl border border-line bg-surface-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="search"
                    value={appSearch}
                    onChange={(event) => setAppSearch(event.target.value)}
                    placeholder={t('settings.desktop.searchRunningApps')}
                    className="h-7 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink placeholder:text-ink-quaternary outline-none focus:border-accent"
                  />
                  {appsLoading ? <Loader2 className="size-3.5 animate-spin text-ink-tertiary" /> : null}
                </div>
                {visibleRunningApps.length > 0 ? (
                  <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                    {visibleRunningApps.map((app) => {
                      const isBlocked =
                        blockedSet.has(app.name.toLowerCase()) ||
                        (app.bundleId ? blockedSet.has(app.bundleId.toLowerCase()) : false);
                      return (
                        <button
                          key={`${app.name}:${app.bundleId ?? app.process ?? ''}`}
                          type="button"
                          disabled={busy}
                          onClick={() => toggleRunningAppBlocked(app)}
                          className={cn(
                            'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
                            isBlocked
                              ? 'border-accent/40 bg-accent-soft/45 text-ink'
                              : 'border-line bg-surface hover:border-line-strong',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {app.icon ? (
                              <img src={app.icon} alt="" className="size-4 shrink-0 rounded" />
                            ) : (
                              <AppWindow className="size-4 shrink-0 text-ink-quaternary" />
                            )}
                            <span className="truncate font-medium">{app.name}</span>
                          </span>
                          {isBlocked ? (
                            <Check className="size-3.5 shrink-0 text-accent-ink" />
                          ) : (
                            <Plus className="size-3.5 shrink-0 text-ink-quaternary" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : !appsLoading ? (
                  <p className="py-3 text-center text-xs text-ink-tertiary">
                    {t('settings.desktop.noRunningApps')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>
      </div>
    </>
  );
}

function PermissionChip({
  label,
  granted,
  grantedLabel,
  pendingLabel,
}: {
  label: string;
  granted: boolean;
  grantedLabel: string;
  pendingLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-secondary">
      <span
        aria-hidden="true"
        className={cn('size-2 rounded-full', granted ? 'bg-success' : 'bg-warning')}
      />
      <span>{label}</span>
      <span className={cn('font-medium', granted ? 'text-success' : 'text-warning')}>
        {granted ? grantedLabel : pendingLabel}
      </span>
    </span>
  );
}
