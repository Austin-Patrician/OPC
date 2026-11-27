import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  Globe2,
  HardDrive,
  PanelsTopLeft,
  PlugZap,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  BrowserAttachMethod,
  BrowserConnectionTestResult,
  BrowserInputMode,
  BrowserInstallPhase,
  BrowserInstallProgress,
  BrowserMode,
  BrowserSettings,
  BrowserStatus,
} from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, Section, SelectField, StatusBadge, Toggle } from '../kit';

const REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';
const CDP_LAUNCH_FLAG = '--remote-debugging-port=9222';

const DEFAULT: BrowserSettings = {
  enabled: false,
  mode: 'managed',
  attachMethod: 'auto-connect',
  cdpEndpoint: '9222',
  pinTab: true,
  headed: true,
  inputMode: 'human',
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

const MODE_TABS = [
  { key: 'managed', icon: Globe2, recommended: true },
  { key: 'attach', icon: PlugZap, recommended: false },
  { key: 'headless', icon: EyeOff, recommended: false },
] as const satisfies readonly {
  key: BrowserMode;
  icon: typeof Globe2;
  recommended: boolean;
}[];

const CONNECTION_SETTING_KEYS: readonly (keyof BrowserSettings)[] = [
  'mode',
  'attachMethod',
  'cdpEndpoint',
  'executablePath',
  'headed',
  'pinTab',
];

function parseDomainLines(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isConnectionPatch(patch: Partial<BrowserSettings>): boolean {
  return CONNECTION_SETTING_KEYS.some((key) => key in patch);
}

export function BrowserPage() {
  const { t } = useTranslation();
  const modeTabPrefix = useId();
  const customExecId = useId();
  const allowedDomainsId = useId();
  const blockedDomainsId = useId();
  const modeTabRefs = useRef<Partial<Record<BrowserMode, HTMLButtonElement | null>>>({});
  const settingsRef = useRef<BrowserSettings>(DEFAULT);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const savedIndicatorTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT);
  const [cdpEndpoint, setCdpEndpoint] = useState('9222');
  const [customExecutable, setCustomExecutable] = useState('');
  const [domains, setDomains] = useState('');
  const [blockedDomains, setBlockedDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingWindow, setOpeningWindow] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<BrowserConnectionTestResult | null>(null);
  const [installProgress, setInstallProgress] = useState<BrowserInstallProgress | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.opc?.browser;

  const showSavedIndicator = useCallback(() => {
    if (savedIndicatorTimerRef.current !== null) window.clearTimeout(savedIndicatorTimerRef.current);
    setSavedIndicator(true);
    savedIndicatorTimerRef.current = window.setTimeout(() => {
      setSavedIndicator(false);
      savedIndicatorTimerRef.current = null;
    }, 2000);
  }, []);

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [nextStatus, nextSettings] = await Promise.all([bridge.status(), bridge.getSettings()]);
      setStatus(nextStatus);
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      setCdpEndpoint(nextSettings.cdpEndpoint || '9222');
      setCustomExecutable(nextSettings.executablePath ?? '');
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

  useEffect(
    () => () => {
      if (savedIndicatorTimerRef.current !== null) window.clearTimeout(savedIndicatorTimerRef.current);
    },
    [],
  );

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

  const saveSettings = async (patch: Partial<BrowserSettings>) => {
    if (!bridge) return;
    const previous = settingsRef.current;
    const optimistic = { ...previous, ...patch };
    settingsRef.current = optimistic;
    setSettings(optimistic);
    if (isConnectionPatch(patch)) {
      setConnectionResult(null);
    }
    setError(null);

    const run = saveQueueRef.current.then(async () => {
      const next = await bridge.setSettings(patch);
      settingsRef.current = next;
      setSettings(next);
      showSavedIndicator();
    });
    saveQueueRef.current = run.catch(() => undefined);

    try {
      await run;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      try {
        const fresh = await bridge.getSettings();
        settingsRef.current = fresh;
        setSettings(fresh);
      } catch {
        settingsRef.current = previous;
        setSettings(previous);
      }
    }
  };

  const openWindow = async () => {
    if (!bridge || openingWindow) return;
    setOpeningWindow(true);
    setError(null);
    setNotice(null);
    try {
      const res = await bridge.openWindow();
      if (!res.ok) {
        setError(res.error ?? t('settings.browser.openWindowFailed'));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpeningWindow(false);
    }
  };

  const testConnection = async () => {
    if (!bridge || testingConnection) return;
    setTestingConnection(true);
    setError(null);
    try {
      const res = await bridge.testConnection();
      setConnectionResult(res);
    } catch (caught) {
      setConnectionResult({
        ok: false,
        mode: settings.mode,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const toggleApprovalPolicy = (category: string, enabled: boolean) => {
    const current = settingsRef.current.requireApprovalFor;
    const requireApprovalFor = enabled
      ? [...new Set([...current, category])]
      : current.filter((item) => item !== category);
    void saveSettings({ requireApprovalFor });
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
    if (!status) {
      return {
        tone: 'gray' as const,
        label: t('settings.browser.status.connecting'),
        detail: t('settings.browser.status.connectingDetail'),
      };
    }
    if (status.installState === 'installing') {
      return {
        tone: 'amber' as const,
        label: t('settings.browser.status.installing'),
        detail: t('settings.browser.status.installingDetail'),
      };
    }
    if (status.installState === 'error') {
      return {
        tone: 'red' as const,
        label: t('settings.browser.status.error'),
        detail: status.error ?? t('settings.browser.status.errorDetail'),
      };
    }
    if (status.installState === 'uninstalled') {
      return {
        tone: 'gray' as const,
        label: t('settings.browser.status.uninstalled'),
        detail: t('settings.browser.status.uninstalledDetail'),
      };
    }
    if (status.enabled && status.healthy) {
      return {
        tone: 'green' as const,
        label: t('settings.browser.status.enabled'),
        detail: t('settings.browser.status.enabledDetail'),
      };
    }
    return {
      tone: 'gray' as const,
      label: t('settings.browser.status.installed'),
      detail: t('settings.browser.status.installedDetail'),
    };
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

  const runtimeReady =
    Boolean(status?.healthy) || status?.installState === 'ready' || status?.installState === 'disabled';
  const installed = runtimeReady;
  const installLabel =
    status?.installState === 'installing'
      ? t('settings.browser.installing')
      : runtimeReady || status?.installState === 'error'
        ? t('settings.browser.reinstall')
        : t('settings.browser.install');

  const detectedBrowsers = status?.detectedBrowsers ?? [];
  const runModeDisplay =
    settings.mode === 'attach'
      ? t('settings.browser.modeLabel.attach')
      : settings.mode === 'headless'
        ? t('settings.browser.modeLabel.headless')
        : settings.headed
          ? t('settings.browser.modeLabel.managed')
          : t('settings.browser.modeLabel.managedHidden');

  const handleModeTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % MODE_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + MODE_TABS.length) % MODE_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = MODE_TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = MODE_TABS[nextIndex];
    if (!nextTab) return;
    const nextButton = modeTabRefs.current[nextTab.key];
    nextButton?.focus();
    nextButton?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.page.browser')]}
        title={t('settings.browser.title')}
        description={t('settings.browser.description')}
        actions={
          <div className="relative flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute -top-6 right-0 inline-flex items-center gap-1 whitespace-nowrap text-xs text-success transition-opacity duration-150 ${
                savedIndicator ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <Check className="size-3.5 shrink-0" />
              <span>{t('settings.browser.savedNotice')}</span>
            </span>
            <span role="status" className="sr-only">
              {savedIndicator ? t('settings.browser.savedNotice') : ''}
            </span>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!installed || !settings.enabled || openingWindow || busy}
              onClick={() => void openWindow()}
            >
              <ExternalLink className="size-3.5" />
              {openingWindow ? t('settings.browser.openingWindow') : t('settings.browser.openWindow')}
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
              {t('settings.browser.refresh')}
            </button>
          </div>
        }
      />
      {error ? (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary">
          {notice}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6">
          <div className="pointer-events-none absolute -top-24 -right-20 size-64 rounded-full bg-accent/[0.045] blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <div className="relative flex size-[4.25rem] shrink-0 items-center justify-center rounded-[1.25rem] bg-ink text-surface shadow-[0_10px_24px_-14px_rgba(0,0,0,0.5)]">
              <PanelsTopLeft className="size-8 stroke-[1.35]" aria-hidden="true" />
              <span className="absolute right-2.5 bottom-2.5 flex size-5 items-center justify-center rounded-md bg-surface/15 text-surface/80">
                <Globe2 className="size-3.5" strokeWidth={1.7} aria-hidden="true" />
              </span>
              <span
                className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface ${
                  statusMeta.tone === 'green'
                    ? 'bg-success'
                    : statusMeta.tone === 'red'
                      ? 'bg-danger'
                      : statusMeta.tone === 'amber'
                        ? 'bg-warning'
                        : 'bg-ink-quaternary'
                }`}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs font-medium tracking-[0.14em] text-ink-tertiary uppercase">
                  {t('settings.browser.nativeCapability')}
                </span>
                <span className="size-1 rounded-full bg-ink-quaternary" />
                <span className="font-mono text-2xs text-ink-quaternary">opc.browser</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="text-xl font-semibold tracking-tight text-ink">
                  {status?.activeBrowserName || 'Google Chrome'}
                </h3>
                <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
              </div>
              <p className="mt-2 max-w-[38rem] text-sm leading-relaxed text-ink-secondary">
                {t('settings.browser.subtitle')}
              </p>
              <p className="mt-1.5 text-xs-plus text-ink-tertiary">{statusMeta.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-surface/80 px-2.5 py-2 sm:flex-col sm:items-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
              <span className="text-2xs font-medium tracking-wide text-ink-quaternary uppercase">
                {t('settings.browser.runtime')}
              </span>
              <span className="font-mono text-xs-plus text-ink-secondary">
                {status?.version ? `v${status.version}` : t('settings.browser.versionPending')}
              </span>
            </div>
          </div>
        </div>

        <div className="grid border-t border-line bg-surface-muted/35 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Globe2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.runtimeEnvironment')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">
                {status?.activeBrowserName ?? 'Chrome / Edge'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Shield className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.sessionProfile')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary" title={status?.profilePath}>
                {settings.mode === 'attach'
                  ? t('settings.browser.attachProfileLabel')
                  : t('settings.browser.persistentLogin')}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 xl:border-r xl:border-b-0 sm:px-6">
            <CheckCircle2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{t('settings.browser.runMode')}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">{runModeDisplay}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 px-5 py-3.5 sm:px-6">
            <HardDrive className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">
                {runtimeReady ? t('settings.browser.diskUsage') : t('settings.browser.estimatedDownload')}
              </div>
              <div
                className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary"
                title={runtimeReady ? t('settings.browser.diskUsageHint') : t('settings.browser.downloadEstimateHint')}
              >
                {runtimeReady
                  ? formatBytes(status?.diskUsageBytes)
                  : t('settings.browser.approx', { size: formatBytes(status?.downloadEstimateBytes) })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Toggle
              checked={settings.enabled}
              disabled={!installed || busy}
              label={t('settings.browser.enable')}
              onChange={(enabled) => void saveSettings({ enabled })}
            />
            <div>
              <div className="text-sm font-medium text-ink">{t('settings.browser.enable')}</div>
              <div className="text-xs-plus text-ink-tertiary">{t('settings.browser.enableHint')}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy || status?.installState === 'installing' || !bridge}
              onClick={() => void install()}
            >
              <Download className="size-3.5" />
              {installLabel}
            </button>
            <button type="button" className={buttonClass.secondary} disabled={busy || !installed} onClick={uninstall}>
              <Trash2 className="size-3.5" />
              {t('settings.browser.stop')}
            </button>
            <button
              type="button"
              className={buttonClass.danger}
              disabled={busy || !installed}
              onClick={() => void removeRuntime()}
            >
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
        <Section title={t('settings.browser.modeSectionTitle')} description={t('settings.browser.modeSectionDesc')}>
          <div
            role="tablist"
            aria-label={t('settings.browser.modeSectionTitle')}
            className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-line bg-surface-muted/30 px-3"
          >
            {MODE_TABS.map(({ key: modeKey, icon: Icon, recommended }, index) => {
              const selected = settings.mode === modeKey;
              return (
                <button
                  key={modeKey}
                  ref={(el) => {
                    modeTabRefs.current[modeKey] = el;
                  }}
                  id={`${modeTabPrefix}-tab-${modeKey}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-disabled={busy || undefined}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={(event) => handleModeTabKeyDown(event, index)}
                  onClick={() => {
                    if (busy || selected) return;
                    void saveSettings({ mode: modeKey });
                  }}
                  className="relative inline-flex min-h-[42px] shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-selected:text-accent after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:border-b-2 after:border-transparent aria-selected:after:border-accent"
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span>{t(`settings.browser.modes.${modeKey}Title`)}</span>
                  {recommended ? (
                    <span className="rounded-full bg-accent/10 px-1.5 py-px text-2xs font-medium text-accent-ink">
                      {t('settings.browser.recommendedBadge')}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            aria-labelledby={`${modeTabPrefix}-tab-${settings.mode}`}
            tabIndex={settings.mode === 'headless' ? 0 : undefined}
            className="focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            <div className="bg-surface-muted/20 px-4 py-3 text-xs-plus leading-relaxed text-ink-secondary">
              {t(`settings.browser.modes.${settings.mode}Desc`)}
            </div>

            {settings.mode === 'managed' ? (
              <>
                <Row
                  label={t('settings.browser.preferredBrowser')}
                  hint={
                    detectedBrowsers.length === 0
                      ? t('settings.browser.noDetectedBrowser')
                      : detectedBrowsers.map((b) => b.name).join(' / ')
                  }
                >
                  <SelectField
                    ariaLabel={t('settings.browser.preferredBrowser')}
                    value={settings.executablePath ?? ''}
                    disabled={busy}
                    onChange={(value) => {
                      setCustomExecutable(value);
                      void saveSettings({ executablePath: value });
                    }}
                    className="w-[16rem] max-w-full"
                  >
                    <option value="">{t('settings.browser.autoDetected')}</option>
                    {detectedBrowsers.map((browser) => (
                      <option key={browser.executablePath} value={browser.executablePath}>
                        {browser.name}
                      </option>
                    ))}
                  </SelectField>
                </Row>
                <div className="border-t border-line px-4 py-3">
                  <label htmlFor={customExecId} className="block text-sm font-medium text-ink">
                    {t('settings.browser.customExecutable')}
                  </label>
                  <input
                    id={customExecId}
                    type="text"
                    value={customExecutable}
                    onChange={(event) => setCustomExecutable(event.target.value)}
                    onBlur={() => {
                      const trimmed = customExecutable.trim();
                      if (trimmed !== (settingsRef.current.executablePath ?? '')) {
                        void saveSettings({ executablePath: trimmed });
                      }
                    }}
                    placeholder={t('settings.browser.customExecutablePlaceholder')}
                    className="mt-1.5 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
                  />
                </div>
                <Row label={t('settings.browser.headedToggle')} hint={t('settings.browser.headedHint')}>
                  <Toggle
                    checked={settings.headed}
                    disabled={busy}
                    label={t('settings.browser.headedToggle')}
                    onChange={(headed) => void saveSettings({ headed })}
                  />
                </Row>
              </>
            ) : null}

            {settings.mode === 'attach' ? (
              <>
                <Row label={t('settings.browser.attachMethodLabel')}>
                  <SelectField
                    ariaLabel={t('settings.browser.attachMethodLabel')}
                    value={settings.attachMethod}
                    disabled={busy}
                    onChange={(value) => void saveSettings({ attachMethod: value as BrowserAttachMethod })}
                    className="w-[18.5rem] max-w-full"
                  >
                    <option value="auto-connect">{t('settings.browser.attachAutoConnect')}</option>
                    <option value="cdp">{t('settings.browser.attachCdp')}</option>
                  </SelectField>
                </Row>
                {settings.attachMethod === 'cdp' ? (
                  <Row label={t('settings.browser.cdpEndpointLabel')}>
                    <input
                      type="text"
                      value={cdpEndpoint}
                      disabled={busy}
                      onChange={(event) => setCdpEndpoint(event.target.value)}
                      onBlur={() => {
                        const trimmed = cdpEndpoint.trim() || '9222';
                        setCdpEndpoint(trimmed);
                        if (trimmed !== settingsRef.current.cdpEndpoint) {
                          void saveSettings({ cdpEndpoint: trimmed });
                        }
                      }}
                      className="w-40 rounded-lg border border-line bg-surface-muted px-3 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
                    />
                  </Row>
                ) : null}
                <Row label={t('settings.browser.pinTabLabel')} hint={t('settings.browser.pinTabHint')}>
                  <Toggle
                    checked={settings.pinTab}
                    disabled={busy}
                    label={t('settings.browser.pinTabLabel')}
                    onChange={(pinTab) => void saveSettings({ pinTab })}
                  />
                </Row>
                <div className="border-t border-line bg-surface-muted/35 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
                  <div className="font-medium text-ink">{t('settings.browser.attachGuideTitle')}</div>
                  <p className="mt-1">
                    {settings.attachMethod === 'auto-connect'
                      ? t('settings.browser.attachGuideAuto')
                      : t('settings.browser.attachGuideCdp')}
                  </p>
                  <CopyableSnippet
                    key={settings.attachMethod}
                    value={settings.attachMethod === 'auto-connect' ? REMOTE_DEBUGGING_URL : CDP_LAUNCH_FLAG}
                    copyLabel={t('settings.browser.copyAction')}
                    copiedLabel={t('settings.browser.copiedNotice')}
                    copyFailedLabel={t('settings.browser.copyFailedNotice')}
                  />
                  <p className="mt-2 text-ink-tertiary">{t('settings.browser.attachSecurityNote')}</p>
                </div>
              </>
            ) : null}

            {settings.mode !== 'headless' ? (
              <Row label={t('settings.browser.inputModeLabel')}>
                <SelectField
                  ariaLabel={t('settings.browser.inputModeLabel')}
                  value={settings.inputMode}
                  disabled={busy}
                  onChange={(value) => void saveSettings({ inputMode: value as BrowserInputMode })}
                  className="w-[17rem] max-w-full"
                >
                  <option value="human">{t('settings.browser.inputModes.human')}</option>
                  <option value="smooth">{t('settings.browser.inputModes.smooth')}</option>
                  <option value="instant">{t('settings.browser.inputModes.instant')}</option>
                </SelectField>
              </Row>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
            <div className="min-w-0 flex-1 text-xs">
              {connectionResult ? (
                <span className={connectionResult.ok ? 'text-success' : 'text-danger'}>
                  {connectionResult.message}
                </span>
              ) : (
                <span className="text-ink-tertiary">{statusMeta.detail}</span>
              )}
            </div>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={testingConnection || busy}
              onClick={() => void testConnection()}
            >
              <PlugZap className="size-3.5" />
              {testingConnection ? t('settings.browser.testingConnection') : t('settings.browser.testConnection')}
            </button>
          </div>
        </Section>
      </div>

      <div className="mt-4">
        <Section title={t('settings.browser.domainTitle')} description={t('settings.browser.domainDesc')}>
          <Row label={t('settings.browser.allowAll')} hint={t('settings.browser.allowAllHint')}>
            <Toggle
              checked={settings.allowAllDomains}
              disabled={busy}
              label={t('settings.browser.allowAll')}
              onChange={(allowAllDomains) => void saveSettings({ allowAllDomains })}
            />
          </Row>
          <div className="border-t border-line px-4 py-3">
            <label htmlFor={allowedDomainsId} className="block text-sm font-medium text-ink">
              {t('settings.browser.allowedDomains')}
            </label>
            <textarea
              id={allowedDomainsId}
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              onBlur={() => {
                const nextAllowed = parseDomainLines(domains);
                if (!sameStringList(nextAllowed, settingsRef.current.allowedDomains)) {
                  void saveSettings({ allowedDomains: nextAllowed });
                }
              }}
              className="mt-2 min-h-24 w-full resize-y rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              placeholder={t('settings.browser.allowedPlaceholder')}
            />
          </div>
          <div className="border-t border-line px-4 py-3">
            <label htmlFor={blockedDomainsId} className="block text-sm font-medium text-ink">
              {t('settings.browser.blockedDomains')}
            </label>
            <textarea
              id={blockedDomainsId}
              value={blockedDomains}
              onChange={(event) => setBlockedDomains(event.target.value)}
              onBlur={() => {
                const nextBlocked = parseDomainLines(blockedDomains);
                if (!sameStringList(nextBlocked, settingsRef.current.blockedDomains)) {
                  void saveSettings({ blockedDomains: nextBlocked });
                }
              }}
              className="mt-2 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              placeholder={t('settings.browser.blockedPlaceholder')}
            />
          </div>
        </Section>
      </div>

      <div className="mt-4">
        <Section title={t('settings.browser.approvalTitle')} description={t('settings.browser.approvalDesc')}>
          {APPROVAL_OPTIONS.map(([key, labelKey]) => (
            <Row
              key={key}
              label={t(labelKey)}
              hint={
                key === 'navigation'
                  ? t('settings.browser.approvalHintNavigation')
                  : t('settings.browser.approvalHint')
              }
            >
              <Toggle
                checked={settings.requireApprovalFor.includes(key)}
                disabled={busy}
                label={t(labelKey)}
                onChange={(enabled) => toggleApprovalPolicy(key, enabled)}
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

function legacyCopyText(text: string): boolean {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

function CopyableSnippet({
  value,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [announcement, setAnnouncement] = useState('');
  const timerRef = useRef<number | null>(null);
  const lastAnnouncementRef = useRef('');

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      ok = legacyCopyText(value);
    }

    const nextState = ok ? 'copied' : 'failed';
    let message = ok ? copiedLabel : copyFailedLabel;
    if (message === lastAnnouncementRef.current) message += '\u00A0';
    lastAnnouncementRef.current = message;

    setCopyState(nextState);
    setAnnouncement(message);
    timerRef.current = window.setTimeout(() => {
      setCopyState('idle');
      setAnnouncement('');
      timerRef.current = null;
    }, 2000);
  };

  const buttonText = copyState === 'copied' ? copiedLabel : copyState === 'failed' ? copyFailedLabel : copyLabel;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink select-all">{value}</code>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex min-h-[26px] min-w-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line bg-surface-muted px-2 py-1 text-2xs font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {copyState === 'copied' ? (
          <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3 shrink-0 text-ink-tertiary" aria-hidden="true" />
        )}
        <span>{buttonText}</span>
      </button>
      <span role="status" className="sr-only">
        {announcement}
      </span>
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
