import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Globe2, HardDrive, PanelsTopLeft, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BrowserInstallPhase, BrowserInstallProgress, BrowserSettings, BrowserStatus } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, Section, StatusBadge, Toggle } from '../kit';

const DEFAULT: BrowserSettings = {
  enabled: false,
  allowedDomains: [],
  blockedDomains: [],
  allowAllDomains: false,
  requireApprovalFor: ['external-submit', 'download', 'upload', 'authentication', 'destructive'],
  maxOutputBytes: 32_000,
};

const APPROVAL_OPTIONS = [
  ['external-submit', 'settings.browser.approval.externalSubmit'],
  ['download', 'settings.browser.approval.download'],
  ['upload', 'settings.browser.approval.upload'],
  ['authentication', 'settings.browser.approval.authentication'],
  ['destructive', 'settings.browser.approval.destructive'],
  ['navigation', 'settings.browser.approval.navigation'],
] as const;

export function BrowserPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT);
  const [domains, setDomains] = useState('');
  const [blockedDomains, setBlockedDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingApproval, setSavingApproval] = useState<Set<string>>(() => new Set());
  const [installProgress, setInstallProgress] = useState<BrowserInstallProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.opc?.browser;

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [nextStatus, nextSettings] = await Promise.all([bridge.status(), bridge.getSettings()]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setDomains(nextSettings.allowedDomains.join('\n'));
      setBlockedDomains(nextSettings.blockedDomains.join('\n'));
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

  const install = async () => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await bridge.install();
      setStatus(next);
      if (next.installState === 'error') setError(next.error ?? t('settings.browser.installFailed'));
      else setNotice(t('settings.browser.installedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstallProgress(null);
      setBusy(false);
    }
  };

  const save = async (patch: Partial<BrowserSettings>) => {
    if (!bridge) return;
    setBusy(true);
    try {
      const next = await bridge.setSettings(patch);
      setSettings(next);
      setNotice(t('settings.browser.savedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveApprovalPolicy = async (category: string, enabled: boolean) => {
    if (!bridge || savingApproval.has(category)) return;
    const requireApprovalFor = enabled
      ? [...new Set([...settings.requireApprovalFor, category])]
      : settings.requireApprovalFor.filter((item) => item !== category);
    setSettings((current) => ({ ...current, requireApprovalFor }));
    setSavingApproval((current) => new Set(current).add(category));
    try {
      await bridge.setSettings({ requireApprovalFor });
      setNotice(t('settings.browser.savedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      try {
        setSettings(await bridge.getSettings());
      } catch {
        // Keep the optimistic value visible if the settings read also fails.
      }
    } finally {
      setSavingApproval((current) => {
        const next = new Set(current);
        next.delete(category);
        return next;
      });
    }
  };

  const uninstall = async () => {
    if (!bridge || !window.confirm(t('settings.browser.confirmStop'))) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.uninstall(false));
      setNotice(t('settings.browser.stoppedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const removeRuntime = async () => {
    if (!bridge || !window.confirm(t('settings.browser.confirmRemove'))) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.uninstall(false, true));
      setNotice(t('settings.browser.removedNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const resetProfile = async () => {
    if (!bridge || !window.confirm(t('settings.browser.confirmReset'))) return;
    setBusy(true);
    try {
      await bridge.resetProfile();
      setNotice(t('settings.browser.resetNotice'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const statusMeta = (() => {
    if (!status) return { tone: 'gray' as const, label: t('settings.browser.status.connecting'), detail: t('settings.browser.status.connectingDetail') };
    if (status.installState === 'installing') return { tone: 'amber' as const, label: t('settings.browser.status.installing'), detail: t('settings.browser.status.installingDetail') };
    if (status.installState === 'error') return { tone: 'red' as const, label: t('settings.browser.status.error'), detail: status.error ?? t('settings.browser.status.errorDetail') };
    if (status.installState === 'uninstalled') return { tone: 'gray' as const, label: t('settings.browser.status.uninstalled'), detail: t('settings.browser.status.uninstalledDetail') };
    if (status.enabled && status.healthy) return { tone: 'green' as const, label: t('settings.browser.status.enabled'), detail: t('settings.browser.status.enabledDetail') };
    return { tone: 'gray' as const, label: t('settings.browser.status.installed'), detail: t('settings.browser.status.installedDetail') };
  })();

  const installPhaseLabel = (phase: BrowserInstallPhase): string => {
    if (phase === 'dependencies') return t('settings.browser.installPhase.dependencies');
    if (phase === 'browser') return t('settings.browser.installPhase.browser');
    return t('settings.browser.installPhase.verify');
  };

  const formatBytes = (bytes: number | undefined): string => {
    if (bytes === undefined) return t('settings.browser.calculating');
    if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  };

  const runtimeReady = Boolean(status?.healthy) || status?.installState === 'ready' || status?.installState === 'disabled';
  const installed = runtimeReady;
  const installLabel =
    status?.installState === 'installing'
      ? t('settings.browser.installing')
      : runtimeReady || status?.installState === 'error'
        ? t('settings.browser.reinstall')
        : t('settings.browser.install');

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.page.browser')]}
        title={t('settings.browser.title')}
        description={t('settings.browser.description')}
        actions={
          <button type="button" className={buttonClass.secondary} onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            {t('settings.browser.refresh')}
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
              <PanelsTopLeft className="size-8 stroke-[1.35]" aria-hidden="true" />
              <span className="absolute right-2.5 bottom-2.5 flex size-5 items-center justify-center rounded-md bg-surface/15 text-surface/80">
                <Globe2 className="size-3.5" strokeWidth={1.7} aria-hidden="true" />
              </span>
              <span className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface ${statusMeta.tone === 'green' ? 'bg-success' : statusMeta.tone === 'red' ? 'bg-danger' : statusMeta.tone === 'amber' ? 'bg-warning' : 'bg-ink-quaternary'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs font-medium tracking-[0.14em] text-ink-tertiary uppercase">{t('settings.browser.nativeCapability')}</span>
                <span className="size-1 rounded-full bg-ink-quaternary" />
                <span className="font-mono text-2xs text-ink-quaternary">opc.browser</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="text-xl font-semibold tracking-tight text-ink">agent-browser</h3>
                <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
              </div>
              <p className="mt-2 max-w-[38rem] text-sm leading-relaxed text-ink-secondary">{t('settings.browser.subtitle')}</p>
              <p className="mt-1.5 text-xs-plus text-ink-tertiary">{statusMeta.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-surface/80 px-2.5 py-2 sm:flex-col sm:items-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
              <span className="text-2xs font-medium tracking-wide text-ink-quaternary uppercase">{t('settings.browser.runtime')}</span>
              <span className="font-mono text-xs-plus text-ink-secondary">{status?.version ? `v${status.version}` : t('settings.browser.versionPending')}</span>
            </div>
          </div>
        </div>
        <div className="grid border-t border-line bg-surface-muted/35 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Globe2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.runtimeEnvironment')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">Chrome for Testing</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Shield className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.sessionProfile')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary" title={status?.profilePath}>{t('settings.browser.persistentLogin')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 xl:border-r xl:border-b-0 sm:px-6">
            <CheckCircle2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.runMode')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">{t('settings.browser.background')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 px-5 py-3.5 sm:px-6">
            <HardDrive className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{runtimeReady ? t('settings.browser.diskUsage') : t('settings.browser.estimatedDownload')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary" title={runtimeReady ? t('settings.browser.diskUsageHint') : t('settings.browser.downloadEstimateHint')}>
                {runtimeReady ? formatBytes(status?.diskUsageBytes) : t('settings.browser.approx', { size: formatBytes(status?.downloadEstimateBytes) })}
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Toggle checked={settings.enabled} disabled={!installed || busy} label={t('settings.browser.enable')} onChange={(enabled) => void save({ enabled })} />
            <div>
              <div className="text-sm font-medium text-ink">{t('settings.browser.enable')}</div>
              <div className="text-xs-plus text-ink-tertiary">{t('settings.browser.enableHint')}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.primary} disabled={busy || status?.installState === 'installing' || !bridge} onClick={() => void install()}>
              <Download className="size-3.5" />
              {installLabel}
            </button>
            <button type="button" className={buttonClass.secondary} disabled={busy || !installed} onClick={uninstall}>
              <Trash2 className="size-3.5" />
              {t('settings.browser.stop')}
            </button>
            <button type="button" className={buttonClass.danger} disabled={busy || !installed} onClick={() => void removeRuntime()}>
              <Trash2 className="size-3.5" />
              {t('settings.browser.removeRuntime')}
            </button>
          </div>
        </div>
        {installProgress ? (
          <div className="flex items-center gap-3.5 border-t border-line bg-surface-muted/35 px-5 py-3.5 sm:px-6">
            <InstallProgressRing percent={installProgress.percent} label={t('settings.browser.progressAria')} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{installPhaseLabel(installProgress.phase)}</div>
              <div className="mt-0.5 text-xs-plus text-ink-tertiary">{t('settings.browser.progressNote')}</div>
            </div>
          </div>
        ) : null}
      </section>
      <div className="mt-4">
        <Section title={t('settings.browser.domainTitle')} description={t('settings.browser.domainDesc')}>
          <Row label={t('settings.browser.allowAll')} hint={t('settings.browser.allowAllHint')}>
            <Toggle checked={settings.allowAllDomains} disabled={busy} label={t('settings.browser.allowAll')} onChange={(allowAllDomains) => void save({ allowAllDomains })} />
          </Row>
          <div className="border-t border-line px-4 py-3">
            <label className="block text-sm font-medium text-ink">{t('settings.browser.allowedDomains')}</label>
            <textarea
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              onBlur={() => void save({ allowedDomains: domains.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean) })}
              className="mt-2 min-h-24 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              placeholder={t('settings.browser.allowedPlaceholder')}
            />
          </div>
          <div className="border-t border-line px-4 py-3">
            <label className="block text-sm font-medium text-ink">{t('settings.browser.blockedDomains')}</label>
            <textarea
              value={blockedDomains}
              onChange={(event) => setBlockedDomains(event.target.value)}
              onBlur={() => void save({ blockedDomains: blockedDomains.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean) })}
              className="mt-2 min-h-20 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              placeholder={t('settings.browser.blockedPlaceholder')}
            />
          </div>
        </Section>
      </div>
      <div className="mt-4">
        <Section title={t('settings.browser.approvalTitle')} description={t('settings.browser.approvalDesc')}>
          {APPROVAL_OPTIONS.map(([key, labelKey]) => (
            <Row key={key} label={t(labelKey)} hint={key === 'navigation' ? t('settings.browser.approvalHintNavigation') : t('settings.browser.approvalHint')}>
              <Toggle
                checked={settings.requireApprovalFor.includes(key)}
                disabled={busy || savingApproval.has(key)}
                label={t(labelKey)}
                onChange={(enabled) => void saveApprovalPolicy(key, enabled)}
              />
            </Row>
          ))}
        </Section>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xs-plus text-ink-tertiary">
          <Shield className="size-3.5" />
          {t('settings.browser.footer')}
        </div>
        <button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void resetProfile()}>
          <Trash2 className="size-3.5" />
          {t('settings.browser.resetProfile')}
        </button>
      </div>
    </div>
  );
}

function InstallProgressRing({ percent, label }: { percent: number; label: string }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const safePercent = Math.max(0, Math.min(100, percent));

  return (
    <div
      className="relative flex size-12 shrink-0 items-center justify-center"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safePercent}
    >
      <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="24" cy="24" r={radius} fill="none" stroke="currentColor" strokeWidth="3.5" className="text-line" />
        <circle
          cx="24"
          cy="24"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - safePercent / 100)}
          className="text-accent transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      <span className="font-mono text-[10px] font-semibold tabular-nums text-ink">{safePercent}%</span>
    </div>
  );
}
