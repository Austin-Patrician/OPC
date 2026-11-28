import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  Globe2,
  Loader2,
  MoreHorizontal,
  PlugZap,
  Power,
  RefreshCw,
  RotateCcw,
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
import { cn } from '@/shared/lib/cn';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const install = async () => {
    setMenuOpen(false);
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
    setMenuOpen(false);
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
    setMenuOpen(false);
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
    setMenuOpen(false);
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

  const runtimeReady =
    Boolean(status?.healthy) || status?.installState === 'ready' || status?.installState === 'disabled';
  const installed = runtimeReady;

  const detectedBrowsers = status?.detectedBrowsers ?? [];

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
    <>
      <PageHeader
        crumbs={[t('settings.group.computerUse'), t('settings.page.browser')]}
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
            {installed || status?.installState === 'error' ? (
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  aria-label={t('settings.browser.moreActions')}
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
                    className="absolute top-full right-0 z-20 mt-1.5 w-48 rounded-xl border border-line bg-surface p-1 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.12)]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy || status?.installState === 'installing'}
                      onClick={() => void install()}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
                    >
                      <RefreshCw className="size-3.5 text-ink-tertiary" />
                      <span>{t('settings.browser.reinstall')}</span>
                    </button>
                    {installed ? (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        onClick={() => void uninstall()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
                      >
                        <Power className="size-3.5 text-ink-tertiary" />
                        <span>{t('settings.browser.stop')}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => void resetProfile()}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
                    >
                      <RotateCcw className="size-3.5 text-ink-tertiary" />
                      <span>{t('settings.browser.resetProfile')}</span>
                    </button>
                    {installed ? (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        onClick={() => void removeRuntime()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                      >
                        <Trash2 className="size-3.5" />
                        <span>{t('settings.browser.removeRuntime')}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
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

      <div className="space-y-5">
        <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-start gap-4">
              <div className="relative grid size-12 shrink-0 place-items-center rounded-2xl border border-accent/25 bg-accent-soft text-accent-ink">
                <Globe2 className="size-6" strokeWidth={1.75} aria-hidden="true" />
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
                    {t('settings.browser.heroTitle')}
                  </h3>
                  <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
                </div>
                <p className="mt-1 text-sm text-ink-secondary">
                  {t('settings.browser.enableHint')}
                </p>
                <p className="mt-0.5 text-xs text-ink-tertiary">{statusMeta.detail}</p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
              {!installed || status?.installState === 'error' || status?.installState === 'installing' ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={busy || status?.installState === 'installing' || !bridge}
                  onClick={() => void install()}
                >
                  {status?.installState === 'installing' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  {status?.installState === 'installing'
                    ? t('settings.browser.installing')
                    : t('settings.browser.install')}
                </button>
              ) : (
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-medium text-ink-secondary">
                    {settings.enabled
                      ? t('settings.browser.switchOn')
                      : t('settings.browser.switchOff')}
                  </span>
                  <Toggle
                    checked={settings.enabled}
                    disabled={!installed || busy}
                    label={t('settings.browser.enable')}
                    onChange={(enabled) => void saveSettings({ enabled })}
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
                  style={{ width: `${Math.max(4, Math.min(100, installProgress.percent))}%` }}
                />
              </div>
              <p className="mt-1.5 text-2xs text-ink-tertiary">
                {t('settings.browser.progressNote')}
              </p>
            </div>
          ) : null}
        </section>

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

        <div className="flex items-center gap-2 text-xs-plus text-ink-tertiary">
          <Shield className="size-3.5 shrink-0" />
          <span>{t('settings.browser.footer')}</span>
        </div>
      </div>
    </>
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
