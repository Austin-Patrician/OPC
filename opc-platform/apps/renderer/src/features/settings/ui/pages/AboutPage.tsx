import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppInfo, DiagnosticsReport } from '@opc/shared/ipc';
import { useOnboarding } from '@/features/onboarding/model/onboardingStore';
import { cn } from '@/shared/lib/cn';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { buttonClass, PageHeader, Section } from '../kit';

function formatPlatformLabel(platform?: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform ?? '—';
  }
}

/** Settings → 关于: Buddy brand overview, clean environment details, optional collapsed check. */
export function AboutPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const reopenOnboarding = useOnboarding((state) => state.reopen);

  useEffect(() => {
    void window.opc?.app.getInfo().then(setInfo);
  }, []);

  const copyDataPath = async () => {
    const dir = info?.userDataPath;
    if (!dir || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(dir);
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      // Ignore clipboard permission errors in restricted contexts.
    }
  };

  const runEnvCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const report = await window.opc?.diagnostics.report();
      if (!report) throw new Error(t('desktopOnly.title'));
      setDiagnostics(report);
    } catch (caught) {
      setCheckError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  };

  const toggleEnvCheck = () => {
    const next = !checkOpen;
    setCheckOpen(next);
    if (next && !diagnostics && !checking) {
      void runEnvCheck();
    }
  };

  const runtimeSummary = info
    ? `Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`
    : '…';

  return (
    <>
      <PageHeader crumbs={[t('settings.group.about')]} title={t('settings.group.about')} />

      <div className="space-y-4">
        {/* Editorial Brand Hero Card */}
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-gradient-to-br from-accent/[0.06] via-surface to-surface px-6 py-5">
          <div className="shrink-0">
            <BuddyMark size="lg" phase="idle" interactive />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold tracking-tight text-ink">
                {t('settings.about.appTitle')}
              </h3>
              <span className="inline-flex h-5 items-center rounded-md border border-line bg-surface-muted px-1.5 font-mono text-xs text-ink-tertiary">
                v{info?.version ?? '…'}
              </span>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-ink-tertiary">
              {t('settings.about.tagline')}
            </p>
          </div>

          <button
            type="button"
            onClick={reopenOnboarding}
            className={cn(buttonClass.secondary, 'shrink-0 gap-1.5')}
          >
            <Sparkles className="size-3.5 text-accent-ink" />
            {t('settings.about.replayGuide')}
          </button>
        </section>

        {/* Runtime Environment + Optional Collapsed Env Check */}
        <Section title={t('settings.about.versions')}>
          <dl>
            <div className="flex min-h-[2.75rem] items-center gap-4 border-t border-line px-4 py-2 first:border-t-0">
              <dt className="w-[6.5rem] shrink-0 text-sm text-ink-tertiary">
                {t('settings.about.appVersion')}
              </dt>
              <dd className="min-w-0 flex-1 font-mono text-sm text-ink select-text">
                v{info?.version ?? '…'}
              </dd>
            </div>
            <div className="flex min-h-[2.75rem] items-center gap-4 border-t border-line px-4 py-2">
              <dt className="w-[6.5rem] shrink-0 text-sm text-ink-tertiary">
                {t('settings.about.platform')}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-sm text-ink">{formatPlatformLabel(info?.platform)}</span>
                {info?.platform ? (
                  <span className="font-mono text-2xs text-ink-quaternary">({info.platform})</span>
                ) : null}
              </dd>
            </div>
            <div className="flex min-h-[2.75rem] items-center gap-4 border-t border-line px-4 py-2">
              <dt className="w-[6.5rem] shrink-0 text-sm text-ink-tertiary">
                {t('settings.about.runtime')}
              </dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-xs text-ink-secondary select-text">
                {runtimeSummary}
              </dd>
            </div>
            <div className="flex min-h-[2.75rem] items-center gap-4 border-t border-line px-4 py-2">
              <dt className="w-[6.5rem] shrink-0 text-sm text-ink-tertiary">
                {t('settings.about.dataDir')}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-ink-secondary select-text"
                  title={info?.userDataPath}
                >
                  {info?.userDataPath ?? '…'}
                </span>
                {info?.userDataPath ? (
                  <button
                    type="button"
                    onClick={() => void copyDataPath()}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-muted/60 px-2 text-2xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                  >
                    {copiedPath ? (
                      <>
                        <Check className="size-3 text-success" />
                        {t('settings.about.copied')}
                      </>
                    ) : (
                      <>
                        <Copy className="size-3" />
                        {t('settings.about.copyPath')}
                      </>
                    )}
                  </button>
                ) : null}
              </dd>
            </div>
          </dl>

          <div className="border-t border-line">
            <button
              type="button"
              onClick={toggleEnvCheck}
              aria-expanded={checkOpen}
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-muted/35"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{t('settings.about.envCheck')}</div>
                <div className="mt-0.5 text-xs text-ink-tertiary">
                  {t('settings.about.envCheckHint')}
                </div>
              </div>
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 text-ink-quaternary transition-transform duration-200',
                  checkOpen && 'rotate-180',
                )}
              />
            </button>

            {checkOpen ? (
              <div className="space-y-3 border-t border-line/70 bg-surface-muted/25 px-4 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-ink-tertiary">
                    {diagnostics
                      ? t('settings.about.envCheckCount', { count: diagnostics.probes.length })
                      : t('settings.about.envCheckRunning')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runEnvCheck()}
                    disabled={checking}
                    className={cn(buttonClass.secondary, 'h-7 px-2.5 text-xs')}
                  >
                    <RefreshCw className={cn('size-3', checking && 'animate-spin')} />
                    {checking
                      ? t('settings.about.envCheckRunning')
                      : t('settings.about.envCheckRun')}
                  </button>
                </div>

                {checkError ? (
                  <p className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {checkError}
                  </p>
                ) : null}

                {diagnostics ? (
                  <ul className="divide-y divide-line/70 rounded-xl border border-line bg-surface">
                    {diagnostics.probes.map((probe) => (
                      <li key={probe.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <span
                          aria-hidden
                          className={cn(
                            'mt-1.5 size-2 shrink-0 rounded-full',
                            probe.status === 'ok'
                              ? 'bg-success'
                              : probe.status === 'failed'
                                ? 'bg-danger'
                                : 'bg-warning',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs-plus font-medium text-ink">{probe.title}</span>
                            {typeof probe.durationMs === 'number' ? (
                              <span className="font-mono text-2xs text-ink-quaternary">
                                {probe.durationMs}ms
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 font-mono text-2xs break-all text-ink-tertiary">
                            {probe.detail}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>

        <p className="px-1 text-2xs text-ink-quaternary">{t('settings.about.privacyFootnote')}</p>
      </div>
    </>
  );
}
