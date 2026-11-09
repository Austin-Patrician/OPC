import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AboutPage } from './pages/AboutPage';
import { AppearancePage } from './pages/AppearancePage';
import { CompanyPage } from './pages/CompanyPage';
import { BillingPage } from './pages/BillingPage';
import { CompactionPage } from './pages/CompactionPage';
import { ImagePage } from './pages/ImagePage';
import { DecisionPage } from './pages/DecisionPage';
import { LlmPage } from './pages/LlmPage';
import { NetworkPage } from './pages/NetworkPage';
import { VoicePage } from './pages/VoicePage';
import { RuntimePage } from './pages/RuntimePage';
import { SelfCheckPage } from './pages/SelfCheckPage';
import { MemoryPage } from './pages/MemoryPage';
import { TriagePage } from './pages/TriagePage';
import { WatchdogPage } from './pages/WatchdogPage';
import { McpPage } from './pages/McpPage';
import { BrowserPage } from './pages/BrowserPage';
import { DesktopPage } from './pages/DesktopPage';
import { useTranslation } from 'react-i18next';
import { AppWindow, Boxes, Brain, Cpu, Globe, Info, Plug, Settings2, ShieldCheck } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

const PAGE_IDS = [
  'appearance',
  'company',
  'billing',
  'compaction',
  'triage',
  'watchdog',
  'memory',
  'runtime',
  'llm',
  'image',
  'voice',
  'decision',
  'mcp',
  'browser',
  'desktop',
  'network',
  'selfcheck',
  'about',
] as const;

type PageId = (typeof PAGE_IDS)[number];

const isPageId = (value: string | null): value is PageId =>
  PAGE_IDS.some((id) => id === value);

interface Group {
  id: string;
  label: string;
  icon: typeof Settings2;
  color: string;
  pages: { id: PageId; label: string }[];
}

/**
 * Settings shell, 1:1 with the design: 220px grouped navigation with an
 * expandable submenu, 880px content column, auto-save footer.
 */
export function SettingsShell() {
  const { t } = useTranslation();
  // `?page=company` is the deep link the title-bar identity card uses. The URL is
  // the source of truth, so a link always lands on the page it names and clicking
  // the sidebar keeps the address honest (no `?page=` for the default page).
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('page');
  const page: PageId = isPageId(requested) ? requested : 'appearance';
  const setPage = (next: PageId) => {
    setSearchParams(next === 'appearance' ? {} : { page: next }, { replace: true });
  };

  const groups: Group[] = [
    {
      id: 'general',
      label: t('settings.group.general'),
      icon: Settings2,
      color: '#8E8E93',
      pages: [
        { id: 'appearance', label: t('settings.page.appearance') },
        { id: 'company', label: t('settings.page.company') },
        { id: 'billing', label: t('settings.page.billing') },
        { id: 'compaction', label: t('settings.page.compaction') },
      ],
    },
    {
      // 事件调度、进展监督、记忆都是"它怎么工作"的策略，和外观/计费这类
      // 通用偏好分开，免得在通用下面越堆越长。
      id: 'behavior',
      label: t('settings.group.behavior'),
      icon: Brain,
      color: '#FF375F',
      pages: [
        { id: 'triage', label: t('settings.page.triage') },
        { id: 'watchdog', label: t('settings.page.watchdog') },
        { id: 'memory', label: t('settings.page.memory') },
      ],
    },
    {
      id: 'models',
      label: t('settings.group.models'),
      icon: Boxes,
      color: '#7A4CE0',
      pages: [
        { id: 'llm', label: 'LLM' },
        { id: 'image', label: 'Image' },
        { id: 'voice', label: 'Voice' },
        { id: 'decision', label: 'Decision' },
      ],
    },
    {
      // 运行时是环境本身（Node/Python/OCR），不是某个模型选项：单独成组。
      id: 'runtime',
      label: t('settings.group.runtime'),
      icon: Cpu,
      color: '#5856D6',
      pages: [{ id: 'runtime', label: t('settings.page.runtime') }],
    },
    {
      // MCP 是外部能力，不是模型选型：单独成组，避免和 LLM/Image/Voice/Decision
      // 挤在同一个子菜单里。
      id: 'mcp',
      label: t('settings.group.mcp'),
      icon: Plug,
      color: '#30B0C7',
      pages: [{ id: 'mcp', label: 'MCP' }],
    },
    {
      // Outgoing traffic is infrastructure, not a model concern: its own group
      // keeps it one click away instead of buried under 通用.
      id: 'network',
      label: t('settings.group.network'),
      icon: Globe,
      color: '#FF9500',
      pages: [{ id: 'network', label: t('settings.page.network') }],
    },
    {
      id: 'browser',
      label: '浏览器',
      icon: Globe,
      color: '#1D7AFC',
      pages: [{ id: 'browser', label: 'Personal Agent 浏览器' }],
    },
    {
      id: 'desktop',
      label: '桌面能力',
      icon: AppWindow,
      color: '#5856D6',
      pages: [{ id: 'desktop', label: 'Computer Use' }],
    },
    {
      id: 'selfcheck',
      label: t('settings.group.selfcheck'),
      icon: ShieldCheck,
      color: '#34C759',
      pages: [{ id: 'selfcheck', label: t('settings.group.selfcheck') }],
    },
    {
      id: 'about',
      label: t('settings.group.about'),
      icon: Info,
      color: '#0099FF',
      pages: [{ id: 'about', label: t('settings.group.about') }],
    },
  ];

  const activeGroup =
    groups.find((group) => group.pages.some((entry) => entry.id === page)) ?? groups[0]!;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const content = (() => {
    switch (page) {
      case 'appearance':
        return <AppearancePage />;
      case 'company':
        return <CompanyPage />;
      case 'billing':
        return <BillingPage />;
      case 'compaction':
        return <CompactionPage />;
      case 'triage':
        return <TriagePage />;
      case 'watchdog':
        return <WatchdogPage />;
      case 'memory':
        return <MemoryPage />;
      case 'runtime':
        return <RuntimePage />;
      case 'llm':
        return <LlmPage />;
      case 'image':
        return <ImagePage />;
      case 'voice':
        return <VoicePage />;
      case 'decision':
        return <DecisionPage />;
      case 'mcp':
        return <McpPage />;
      case 'browser':
        return <BrowserPage />;
      case 'desktop':
        return <DesktopPage />;
      case 'selfcheck':
        return <SelfCheckPage />;
      case 'network':
        return <NetworkPage />;
      case 'about':
        return <AboutPage />;
    }
  })();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-panel select-none">
      <aside className="flex w-[13.75rem] shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="shrink-0 px-4 pt-4 pb-3">
          <h1 className="text-xl font-bold tracking-tight text-ink">{t('settings.title')}</h1>
          <p className="mt-0.5 text-xs-plus text-ink-tertiary">{t('settings.subtitleShort')}</p>
        </div>

        <nav aria-label={t('settings.title')} className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {groups.map((group) => {
            const Icon = group.icon;
            const hasSubmenu = group.pages.length > 1;
            const inGroup = group.id === activeGroup.id;
            const open = hasSubmenu && !collapsed[group.id];

            return (
              <div key={group.id}>
                <button
                  type="button"
                  data-testid={`settings-group-${group.id}`}
                  onClick={() => {
                    if (hasSubmenu && inGroup) {
                      setCollapsed((previous) => ({ ...previous, [group.id]: !previous[group.id] }));
                      return;
                    }
                    setPage(group.pages[0]!.id);
                    if (hasSubmenu) setCollapsed((previous) => ({ ...previous, [group.id]: false }));
                  }}
                  aria-expanded={hasSubmenu ? open : undefined}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-base transition-colors',
                    !hasSubmenu && inGroup
                      ? 'bg-surface-active font-medium text-ink'
                      : inGroup
                        ? 'font-medium text-ink hover:bg-ink/5'
                        : 'text-ink-secondary hover:bg-ink/5',
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-white"
                    style={{ background: group.color }}
                  >
                    <Icon className="size-3" strokeWidth={2.2} />
                  </span>
                  <span className="flex-1 text-left">{group.label}</span>
                  {hasSubmenu ? (
                    <span className={cn('text-2xs text-ink-quaternary transition-transform', open && 'rotate-90')}>
                      ›
                    </span>
                  ) : null}
                </button>

                {open ? (
                  <div className="mt-0.5 mb-1.5 ml-[1.0625rem] space-y-px border-l border-line pl-2.5">
                    {group.pages.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        data-testid={`settings-page-${entry.id}`}
                        onClick={() => setPage(entry.id)}
                        aria-current={entry.id === page ? 'page' : undefined}
                        className={cn(
                          'flex h-7 w-full items-center rounded-md px-2 text-sm-plus transition-colors',
                          entry.id === page
                            ? 'bg-surface-active font-medium text-ink'
                            : 'text-ink-tertiary hover:bg-ink/5 hover:text-ink',
                        )}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-line px-4 py-3 text-xs text-ink-tertiary">
          {t('settings.autoSave')}
        </div>
      </aside>

      <main className="page-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[55rem] px-8 pt-6 pb-10">{content}</div>
      </main>
    </div>
  );
}
