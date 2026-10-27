import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, FolderGit2, Package, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppInfo } from '@opc/shared/ipc';
import { useOnboarding } from '@/features/onboarding/model/onboardingStore';
import { PI_AI_PACKAGE, PI_AI_VERSION, PI_CHAT_PROVIDER_TOTAL, PI_NPM_URL, PI_REPO_URL, PI_SITE_URL, IMAGE_MODELS } from '@/shared/providers/catalog';
import { KeyTag, PageHeader, Section } from '../kit';

const LINKS = [
  { href: PI_REPO_URL, label: 'GitHub', sub: 'earendil-works/pi', icon: FolderGit2 },
  { href: PI_SITE_URL, label: '官网', sub: 'pi.dev', icon: BookOpen },
  { href: PI_NPM_URL, label: 'npm', sub: PI_AI_PACKAGE, icon: Package },
];

/** Settings → 关于, 1:1 with the design: app card, version table, pi links. */
export function AboutPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const reopenOnboarding = useOnboarding((state) => state.reopen);

  useEffect(() => {
    void window.opc?.app.getInfo().then(setInfo);
  }, []);

  const rows: { label: string; value: string; note?: string }[] = [
    { label: t('settings.about.appVersion'), value: info?.version ?? '…', note: 'package.json' },
    {
      label: t('settings.about.piCatalog'),
      value: `${PI_AI_PACKAGE} ${PI_AI_VERSION}`,
      note: `${PI_CHAT_PROVIDER_TOTAL} providers · ${IMAGE_MODELS.length} image models`,
    },
    { label: 'Electron', value: info?.versions.electron ?? '…', note: 'runtime' },
    { label: 'Node', value: info?.versions.node ?? '…', note: 'runtime' },
    { label: 'Chromium', value: info?.versions.chrome ?? '…', note: 'runtime' },
    { label: t('settings.about.platform'), value: info?.platform ?? '…' },
    { label: t('settings.about.dataDir'), value: info?.userDataPath ?? '…' },
  ];

  return (
    <>
      <PageHeader crumbs={[t('settings.group.about')]} title={t('settings.group.about')} />

      <div className="space-y-4">
        <section className="flex items-center gap-4 rounded-xl border border-line bg-surface px-5 py-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#33ADFF] to-[#0077E6] text-lg font-bold tracking-tight text-white shadow-[0_4px_12px_rgba(0,119,230,0.25)]">
            OPC
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-ink">OPC 一人公司</h3>
              <span className="flex h-5 items-center rounded-md bg-surface-muted px-1.5 font-mono text-xs text-ink-tertiary">
                v{info?.version ?? '…'}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-ink-tertiary">{t('settings.about.tagline')}</p>
          </div>
          <button
            type="button"
            onClick={reopenOnboarding}
            className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm-plus text-ink-secondary transition-colors hover:border-accent hover:text-accent"
          >
            <Sparkles className="size-3.5" />
            {t('settings.about.replayGuide')}
          </button>
        </section>

        <Section title={t('settings.about.versions')}>
          <dl>
            {rows.map((row) => (
              <div key={row.label} className="flex h-10 items-center gap-4 border-t border-line px-4 first:border-t-0">
                <dt className="w-[6rem] shrink-0 text-sm text-ink-tertiary">{row.label}</dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-mono text-sm text-ink select-text">{row.value}</span>
                  {row.note ? <span className="truncate text-xs text-ink-quaternary">{row.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title={t('settings.about.piProject')} description={t('settings.about.piDesc')}>
          <div className="grid grid-cols-3 gap-2 p-3">
            {LINKS.map(({ href, label, sub, icon: Icon }) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="group rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-accent"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <Icon className="size-3.5 text-ink-tertiary" />
                    {label}
                  </span>
                  <ArrowUpRight className="size-3.5 text-ink-quaternary group-hover:text-accent" />
                </div>
                <p className="mt-1 truncate font-mono text-2xs text-ink-quaternary">{sub}</p>
              </a>
            ))}
          </div>
        </Section>

        <p className="px-1 text-2xs text-ink-quaternary">
          {t('settings.about.footnote')} <KeyTag>MIT</KeyTag>
        </p>
      </div>
    </>
  );
}
