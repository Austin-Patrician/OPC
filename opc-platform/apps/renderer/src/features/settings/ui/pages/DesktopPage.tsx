import { useCallback, useEffect, useState } from 'react';
import { AppWindow, CheckCircle2, Download, Eye, HardDrive, RefreshCw, Search, Shield, Trash2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DesktopAppView, DesktopInstallPhase, DesktopInstallProgress, DesktopSettings, DesktopStatus } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, Section, StatusBadge, Toggle } from '../kit';

const DEFAULT: DesktopSettings = {
  enabled: false,
  allowedApps: [],
  requireApprovalFor: ['external-submit', 'destructive', 'clipboard-write', 'physical-input'],
  maxOutputBytes: 64_000,
};

export function DesktopPage() {
  const { t } = useTranslation();
  const bridge = window.opc?.desktop;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT);
  const [apps, setApps] = useState<DesktopAppView[]>([]);
  const [busy, setBusy] = useState(false);
  const [installProgress, setInstallProgress] = useState<DesktopInstallProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectTaskId, setInspectTaskId] = useState('');
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [nextStatus, nextSettings] = await Promise.all([bridge.status(), bridge.getSettings()]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      if (nextStatus.healthy) setApps(await bridge.listApps());
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

  const save = async (patch: Partial<DesktopSettings>) => {
    if (!bridge) return;
    setBusy(true);
    try {
      setSettings(await bridge.setSettings(patch));
      setNotice(t('settings.desktop.savedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await bridge.install();
      setStatus(next);
      if (next.installState === 'error') setError(next.error ?? t('settings.desktop.installFailed'));
      else if (next.installState === 'permission-required') setNotice(t('settings.desktop.permissionRequiredNotice'));
      else setNotice(t('settings.desktop.installedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstallProgress(null);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!bridge || !window.confirm(t('settings.desktop.confirmRemove'))) return;
    setBusy(true);
    try {
      setStatus(await bridge.uninstall(true));
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
    try {
      setStatus(await (guide ? bridge.permissionsGuide() : bridge.permissions()));
      setNotice(guide ? t('settings.desktop.permissionGuideOpened') : t('settings.desktop.permissionRefreshed'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    if (!bridge || !inspectTaskId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.inspect(inspectTaskId.trim());
      setSnapshot(JSON.stringify(result, null, 2));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const statusMeta = (() => {
    if (!status) return { tone: 'gray' as const, label: t('settings.desktop.status.connecting'), detail: t('settings.desktop.status.connectingDetail') };
    if (status.installState === 'installing') return { tone: 'amber' as const, label: t('settings.desktop.status.installing'), detail: t('settings.desktop.status.installingDetail') };
    if (status.installState === 'permission-required') return { tone: 'amber' as const, label: t('settings.desktop.status.permissionRequired'), detail: t('settings.desktop.status.permissionRequiredDetail') };
    if (status.installState === 'error') return { tone: 'red' as const, label: t('settings.desktop.status.error'), detail: status.error ?? t('settings.desktop.status.errorDetail') };
    if (status.installState === 'uninstalled') return { tone: 'gray' as const, label: t('settings.desktop.status.uninstalled'), detail: t('settings.desktop.status.uninstalledDetail') };
    if (status.enabled && status.healthy) return { tone: 'green' as const, label: t('settings.desktop.status.enabled'), detail: t('settings.desktop.status.enabledDetail') };
    return { tone: 'gray' as const, label: t('settings.desktop.status.installed'), detail: t('settings.desktop.status.installedDetail') };
  })();

  const formatBytes = (bytes?: number): string => {
    if (bytes === undefined) return t('settings.desktop.calculating');
    if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  };
  const formatProgressBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  const installPhaseLabel = (phase: DesktopInstallPhase): string => {
    if (phase === 'download') return t('settings.desktop.installPhase.download');
    if (phase === 'verify') return t('settings.desktop.installPhase.verify');
    if (phase === 'extract') return t('settings.desktop.installPhase.extract');
    if (phase === 'activate') return t('settings.desktop.installPhase.activate');
    return t('settings.desktop.installPhase.permissions');
  };

  const installed = Boolean(status?.healthy) && status?.installState !== 'permission-required';
  const selected = new Set(settings.allowedApps.map((entry) => entry.id));
  const toggleApp = (app: DesktopAppView) => {
    const id = app.bundleId ?? app.process ?? app.name;
    const next = selected.has(id)
      ? settings.allowedApps.filter((entry) => entry.id !== id)
      : [...settings.allowedApps, { id, label: app.name, platform: window.opc?.platform ?? 'unknown', enabled: true, source: 'user' as const }];
    void save({ allowedApps: next });
  };

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.page.desktop')]}
        title={t('settings.desktop.title')}
        description={t('settings.desktop.description')}
        actions={
          <button type="button" className={buttonClass.secondary} onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            {t('settings.desktop.refresh')}
          </button>
        }
      />
      {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div> : null}
      {notice ? <div className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary">{notice}</div> : null}
      <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6">
          <div className="pointer-events-none absolute -top-24 -right-20 size-64 rounded-full bg-accent/[0.045] blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <div className="relative flex size-[4.25rem] shrink-0 items-center justify-center rounded-[1.25rem] bg-ink text-surface shadow-[0_10px_24px_-14px_rgba(0,0,0,0.5)]">
              <AppWindow className="size-8 stroke-[1.35]" aria-hidden="true" />
              <span className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface ${statusMeta.tone === 'green' ? 'bg-success' : statusMeta.tone === 'red' ? 'bg-danger' : statusMeta.tone === 'amber' ? 'bg-warning' : 'bg-ink-quaternary'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs font-medium tracking-[0.14em] text-ink-tertiary uppercase">{t('settings.desktop.nativeCapability')}</span>
                <span className="size-1 rounded-full bg-ink-quaternary" />
                <span className="font-mono text-2xs text-ink-quaternary">opc.desktop</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="text-xl font-semibold tracking-tight text-ink">agent-desktop</h3>
                <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
              </div>
              <p className="mt-2 max-w-[38rem] text-sm leading-relaxed text-ink-secondary">{t('settings.desktop.subtitle')}</p>
              <p className="mt-1.5 text-xs-plus text-ink-tertiary">{statusMeta.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-surface/80 px-2.5 py-2 sm:flex-col sm:items-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
              <span className="text-2xs font-medium tracking-wide text-ink-quaternary uppercase">{t('settings.desktop.runtime')}</span>
              <span className="font-mono text-xs-plus text-ink-secondary">{status?.version ? `v${status.version}` : t('settings.desktop.versionPending')}</span>
            </div>
          </div>
        </div>
        <div className="grid border-t border-line bg-surface-muted/35 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Shield className="size-4 text-ink-tertiary" />
            <div>
              <div className="text-2xs text-ink-quaternary">{t('settings.desktop.permission')}</div>
              <div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{status?.permissions.accessibility === 'granted' ? t('settings.desktop.accessibilityGranted') : t('settings.desktop.needsPermission')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <AppWindow className="size-4 text-ink-tertiary" />
            <div>
              <div className="text-2xs text-ink-quaternary">{t('settings.desktop.controlMode')}</div>
              <div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{t('settings.desktop.backgroundSemantic')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 xl:border-r xl:border-b-0 sm:px-6">
            <CheckCircle2 className="size-4 text-ink-tertiary" />
            <div>
              <div className="text-2xs text-ink-quaternary">{t('settings.desktop.appPermissions')}</div>
              <div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{t('settings.desktop.whitelistCount', { count: settings.allowedApps.filter((entry) => entry.enabled).length })}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 px-5 py-3.5 sm:px-6">
            <HardDrive className="size-4 text-ink-tertiary" />
            <div>
              <div className="text-2xs text-ink-quaternary">{t('settings.desktop.packageDisk')}</div>
              <div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{formatBytes(status?.packageBytes)} · {formatBytes(status?.diskUsageBytes)}</div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Toggle checked={settings.enabled} disabled={!installed || busy} label={t('settings.desktop.enable')} onChange={(enabled) => void save({ enabled })} />
            <div>
              <div className="text-sm font-medium text-ink">{t('settings.desktop.enable')}</div>
              <div className="text-xs-plus text-ink-tertiary">{t('settings.desktop.enableHint')}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.primary} disabled={busy || !bridge || status?.installState === 'installing'} onClick={() => void install()}>
              <Download className="size-3.5" />
              {status?.installState === 'installing' ? t('settings.desktop.installing') : installed ? t('settings.desktop.reinstall') : t('settings.desktop.install')}
            </button>
            <button type="button" className={buttonClass.secondary} disabled={busy || !status?.binary} onClick={() => void permission()}>
              <Shield className="size-3.5" />
              {t('settings.desktop.refreshPermission')}
            </button>
            <button type="button" className={buttonClass.secondary} disabled={busy || !status?.binary} onClick={() => void permission(true)}>
              <Shield className="size-3.5" />
              {t('settings.desktop.openPermissionSettings')}
            </button>
            <button type="button" className={buttonClass.danger} disabled={busy || !status?.binary} onClick={() => void remove()}>
              <Trash2 className="size-3.5" />
              {t('settings.desktop.removeRuntime')}
            </button>
          </div>
        </div>
        {installProgress ? (
          <div className="flex items-center gap-3.5 border-t border-line bg-surface-muted/35 px-5 py-3.5 sm:px-6">
            <InstallProgressRing percent={installProgress.percent} label={t('settings.desktop.progressAria')} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{installPhaseLabel(installProgress.phase)}</div>
              <div className="mt-0.5 text-xs-plus text-ink-tertiary">{t('settings.desktop.progressNote')}</div>
              {installProgress.phase === 'download' && installProgress.downloadedBytes !== undefined && installProgress.totalBytes !== undefined ? (
                <div className="mt-1 font-mono text-xs-plus tabular-nums text-ink-secondary">
                  {formatProgressBytes(installProgress.downloadedBytes)} / {formatProgressBytes(installProgress.totalBytes)}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
      <div className="mt-4">
        <Section title={t('settings.desktop.whitelistTitle')} description={t('settings.desktop.whitelistDesc')}>
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-ink">{t('settings.desktop.runningApps')}</div>
                <div className="text-xs-plus text-ink-tertiary">{t('settings.desktop.selectHint')}</div>
              </div>
              <button type="button" className={buttonClass.secondary} disabled={!installed || busy} onClick={() => void load()}>
                <RefreshCw className="size-3.5" />
                {t('settings.desktop.scan')}
              </button>
            </div>
          </div>
          {apps.length ? (
            apps.map((app) => {
              const id = app.bundleId ?? app.process ?? app.name;
              const enabled = selected.has(id);
              return (
                <button key={id} type="button" onClick={() => toggleApp(app)} className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-muted/50">
                  <span className="flex min-w-0 items-center gap-3">
                    <AppWindow className="size-4 shrink-0 text-ink-tertiary" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{app.name}</span>
                      <span className="block truncate font-mono text-2xs text-ink-quaternary">{app.bundleId ?? app.process ?? id}</span>
                    </span>
                  </span>
                  {enabled ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-ink-quaternary" />}
                </button>
              );
            })
          ) : (
            <div className="px-4 py-5 text-sm text-ink-tertiary">{t('settings.desktop.emptyApps')}</div>
          )}
        </Section>
      </div>
      <div className="mt-4">
        <Section title={t('settings.desktop.actionPolicyTitle')} description={t('settings.desktop.actionPolicyDesc')}>
          <Row label={t('settings.desktop.sensitiveApproval')} hint={t('settings.desktop.sensitiveHint')}>
            <Toggle checked disabled label={t('settings.desktop.sensitiveApproval')} onChange={() => undefined} />
          </Row>
        </Section>
      </div>
      <div className="mt-4">
        <Section title={t('settings.desktop.inspectorTitle')} description={t('settings.desktop.inspectorDesc')}>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <input
              value={inspectTaskId}
              onChange={(event) => setInspectTaskId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void inspect();
              }}
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
              placeholder={t('settings.desktop.taskPlaceholder')}
            />
            <button type="button" className={buttonClass.secondary} disabled={busy || !inspectTaskId.trim()} onClick={() => void inspect()}>
              <Search className="size-3.5" />
              {t('settings.desktop.readSnapshot')}
            </button>
          </div>
          {snapshot ? (
            <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap break-words bg-[#171a18] px-4 py-4 font-mono text-[11px] leading-relaxed text-[#d9e3da]">{snapshot}</pre>
          ) : (
            <div className="px-4 py-5 text-sm text-ink-tertiary">{t('settings.desktop.emptySnapshot')}</div>
          )}
        </Section>
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs-plus text-ink-tertiary">
        <Eye className="size-3.5" />
        {t('settings.desktop.footer')}
      </div>
    </div>
  );
}

function InstallProgressRing({ percent, label }: { percent: number; label: string }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const safePercent = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative flex size-12 shrink-0 items-center justify-center" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={safePercent}>
      <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="24" cy="24" r={radius} fill="none" stroke="currentColor" strokeWidth="3.5" className="text-line" />
        <circle cx="24" cy="24" r={radius} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - safePercent / 100)} className="text-accent transition-[stroke-dashoffset] duration-500 ease-out" />
      </svg>
      <span className="font-mono text-[10px] font-semibold tabular-nums text-ink">{safePercent}%</span>
    </div>
  );
}
