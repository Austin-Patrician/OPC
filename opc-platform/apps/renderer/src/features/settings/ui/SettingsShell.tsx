import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChannelView } from '@opc/shared/domain';
import { AboutPage } from './pages/AboutPage';
import { AppearancePage } from './pages/AppearancePage';
import { ChannelsPage } from './pages/ChannelsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { CompanyPage } from './pages/CompanyPage';
import { BillingPage } from './pages/BillingPage';
import { CompactionPage } from './pages/CompactionPage';
import { ImagePage } from './pages/ImagePage';
import { VideoPage } from './pages/VideoPage';
import { DecisionPage } from './pages/DecisionPage';
import { LlmPage } from './pages/LlmPage';
import { NetworkPage } from './pages/NetworkPage';
import { VoicePage } from './pages/VoicePage';
import { RuntimePage } from './pages/RuntimePage';
import { MemoryPage } from './pages/MemoryPage';
import { WorkspaceRulesPage } from './pages/WorkspaceRulesPage';
import { ConsolidationPage } from './pages/ConsolidationPage';
import { TriagePage } from './pages/TriagePage';
import { WatchdogPage } from './pages/WatchdogPage';
import { McpPage } from './pages/McpPage';
import { BrowserPage } from './pages/BrowserPage';
import { DesktopPage } from './pages/DesktopPage';
import { AssistantToolsPage } from './pages/AssistantToolsPage';
import { CapabilitiesExtensionsPage } from './pages/CapabilitiesExtensionsPage';
import { CapabilitiesSkillsPage } from './pages/CapabilitiesSkillsPage';
import { UsagePage } from './pages/UsagePage';
import { useTranslation } from 'react-i18next';
import { Boxes, Brain, Cpu, Globe, Info, Monitor, Settings2, Share2 } from 'lucide-react';
import { ChannelBrandIcon } from '@/shared/icons/ChannelBrandIcon';
import { cn } from '@/shared/lib/cn';

const PAGE_IDS = [
  'appearance',
  'notifications',
  'company',
  'billing',
  'usage',
  'compaction',
  'triage',
  'watchdog',
  'memory',
  'workspaceRules',
  'consolidation',
  'runtime',
  'capabilitiesSkills',
  'capabilitiesExtensions',
  'channelFeishu',
  'channelDingtalk',
  'channelSlack',
  'channelWecom',
  'channelTelegram',
  'channelGitHub',
  'llm',
  'image',
  'video',
  'voice',
  'decision',
  'mcp',
  'browser',
  'desktop',
  'network',
  'assistantTools',
  'about',
] as const;

type PageId = (typeof PAGE_IDS)[number];

const isPageId = (value: string | null): value is PageId => PAGE_IDS.some((id) => id === value);

interface Group {
  id: string;
  label: string;
  icon: typeof Settings2;
  color: string;
  pages: { id: PageId; label: string; channelId?: ChannelView['id'] }[];
}

function channelDotColor(state: ChannelView['status']['state']): string | null {
  switch (state) {
    case 'connected':
      return 'bg-emerald-500';
    case 'connecting':
    case 'reconnecting':
      return 'bg-amber-500';
    case 'error':
      return 'bg-rose-500';
    default:
      return null;
  }
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
  const page: PageId =
    requested === 'selfcheck'
      ? 'about'
      : requested === 'channels'
        ? 'channelFeishu'
        : isPageId(requested)
          ? requested
          : 'appearance';
  const setPage = (next: PageId) => {
    setSearchParams(next === 'appearance' ? {} : { page: next }, { replace: true });
  };

  const [channelViews, setChannelViews] = useState<ChannelView[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);

  useEffect(() => {
    const api = window.opc?.channels;
    if (!api) {
      setChannelsLoaded(true);
      return;
    }
    let active = true;
    void api
      .list()
      .then((views) => {
        if (active) setChannelViews(views);
      })
      .finally(() => {
        if (active) setChannelsLoaded(true);
      });
    const unsub = api.onChanged((views) => {
      if (active) setChannelViews(views);
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const groups: Group[] = [
    {
      id: 'general',
      label: t('settings.group.general'),
      icon: Settings2,
      color: '#8E8E93',
      pages: [
        { id: 'appearance', label: t('settings.page.appearance') },
        { id: 'notifications', label: t('settings.page.notifications') },
        { id: 'company', label: t('settings.page.company') },
        { id: 'billing', label: t('settings.page.billing') },
        { id: 'usage', label: t('settings.page.usage') },
        { id: 'compaction', label: t('settings.page.compaction') },
      ],
    },
    {
      // 事件调度与记忆体系都是"Agent 如何思考和沉淀"的策略，和通用偏好分开。
      id: 'behavior',
      label: t('settings.group.behavior'),
      icon: Brain,
      color: '#FF375F',
      pages: [
        { id: 'triage', label: t('settings.page.triage') },
        { id: 'memory', label: t('settings.page.memory') },
        { id: 'workspaceRules', label: t('settings.page.workspaceRules') },
        { id: 'consolidation', label: t('settings.page.consolidation') },
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
        { id: 'video', label: 'Video' },
        { id: 'voice', label: 'Voice' },
        { id: 'decision', label: 'Decision' },
      ],
    },
    {
      // 运行时涵盖解释器、OCR、命令权限以及独立守护进程监督，属于运行保障层。
      id: 'runtime',
      label: t('settings.group.runtime'),
      icon: Cpu,
      color: '#5856D6',
      pages: [
        { id: 'runtime', label: t('settings.page.runtime') },
        { id: 'watchdog', label: t('settings.page.watchdog') },
      ],
    },
    {
      // 技能、MCP 与扩展各司其职，收进设置，避免导航栏再多一个一级入口。
      id: 'capabilities',
      label: t('settings.group.capabilities'),
      icon: Boxes,
      color: '#22B560',
      pages: [
        { id: 'capabilitiesSkills', label: t('settings.page.capabilitiesSkills') },
        { id: 'mcp', label: 'MCP' },
        { id: 'capabilitiesExtensions', label: t('settings.page.capabilitiesExtensions') },
      ],
    },
    {
      id: 'channels',
      label: t('settings.group.channels'),
      icon: Share2,
      color: '#0A84FF',
      pages: [
        { id: 'channelFeishu', label: t('settings.page.channelFeishu'), channelId: 'feishu' },
        { id: 'channelDingtalk', label: t('settings.page.channelDingtalk'), channelId: 'dingtalk' },
        { id: 'channelSlack', label: t('settings.page.channelSlack'), channelId: 'slack' },
        { id: 'channelWecom', label: t('settings.page.channelWecom'), channelId: 'wecom' },
        { id: 'channelTelegram', label: t('settings.page.channelTelegram'), channelId: 'telegram' },
        { id: 'channelGitHub', label: t('settings.page.channelGitHub'), channelId: 'github' },
      ],
    },
    {
      // Outgoing traffic is infrastructure, not a model concern: its own group
      // keeps it one click away instead of buried under 通用.
      id: 'network',
      label: t('settings.group.network'),
      icon: Globe,
      color: '#FF9500',
      pages: [
        { id: 'network', label: t('settings.page.network') },
        { id: 'assistantTools', label: t('settings.page.assistantTools') },
      ],
    },
    {
      id: 'computerUse',
      label: t('settings.group.computerUse'),
      icon: Monitor,
      color: '#1D7AFC',
      pages: [
        { id: 'desktop', label: t('settings.page.desktop') },
        { id: 'browser', label: t('settings.page.browser') },
      ],
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
      case 'notifications':
        return <NotificationsPage />;
      case 'company':
        return <CompanyPage />;
      case 'billing':
        return <BillingPage />;
      case 'usage':
        return <UsagePage />;
      case 'compaction':
        return <CompactionPage />;
      case 'triage':
        return <TriagePage />;
      case 'watchdog':
        return <WatchdogPage />;
      case 'memory':
        return <MemoryPage />;
      case 'workspaceRules':
        return <WorkspaceRulesPage />;
      case 'consolidation':
        return <ConsolidationPage />;
      case 'runtime':
        return <RuntimePage />;
      case 'capabilitiesExtensions':
        return <CapabilitiesExtensionsPage />;
      case 'capabilitiesSkills':
        return <CapabilitiesSkillsPage />;
      case 'channelFeishu':
        return (
          <ChannelsPage
            channelId="feishu"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'channelDingtalk':
        return (
          <ChannelsPage
            channelId="dingtalk"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'channelSlack':
        return (
          <ChannelsPage
            channelId="slack"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'channelWecom':
        return (
          <ChannelsPage
            channelId="wecom"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'channelTelegram':
        return (
          <ChannelsPage
            channelId="telegram"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'channelGitHub':
        return (
          <ChannelsPage
            channelId="github"
            channels={channelViews}
            loading={!channelsLoaded}
            onChannelsUpdate={setChannelViews}
          />
        );
      case 'llm':
        return <LlmPage />;
      case 'image':
        return <ImagePage />;
      case 'video':
        return <VideoPage />;
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
      case 'network':
        return <NetworkPage />;
      case 'assistantTools':
        return <AssistantToolsPage />;
      case 'about':
        return <AboutPage />;
    }
  })();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-panel select-none">
      <aside className="flex w-[15rem] shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="shrink-0 px-4 pt-7 pb-3">
          <h1 className="text-xl font-bold tracking-tight text-ink">{t('settings.title')}</h1>
          <p className="mt-0.5 text-xs-plus text-ink-tertiary">{t('settings.subtitleShort')}</p>
        </div>

        <nav
          aria-label={t('settings.title')}
          className="no-drag flex-1 space-y-0.5 overflow-y-auto px-2 pb-3"
        >
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
                      setCollapsed((previous) => ({
                        ...previous,
                        [group.id]: !previous[group.id],
                      }));
                      return;
                    }
                    setPage(group.pages[0]!.id);
                    if (hasSubmenu)
                      setCollapsed((previous) => ({ ...previous, [group.id]: false }));
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
                  <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
                  {hasSubmenu ? (
                    <span
                      className={cn(
                        'text-2xs text-ink-quaternary transition-transform',
                        open && 'rotate-90',
                      )}
                    >
                      ›
                    </span>
                  ) : null}
                </button>

                {open ? (
                  <div className="mt-0.5 mb-1.5 ml-[1.0625rem] space-y-px border-l border-line pl-2.5">
                    {group.pages.map((entry) => {
                      const channelView = entry.channelId
                        ? channelViews.find((item) => item.id === entry.channelId)
                        : undefined;
                      const dotClass = channelView ? channelDotColor(channelView.status.state) : null;
                      const pendingCount = channelView?.pendingPairings.length ?? 0;

                      return (
                        <button
                          key={entry.id}
                          type="button"
                          data-testid={`settings-page-${entry.id}`}
                          onClick={() => setPage(entry.id)}
                          aria-current={entry.id === page ? 'page' : undefined}
                          title={entry.label}
                          className={cn(
                            'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm-plus transition-colors',
                            entry.id === page
                              ? 'bg-surface-active font-medium text-ink'
                              : 'text-ink-tertiary hover:bg-ink/5 hover:text-ink',
                          )}
                        >
                          {entry.channelId ? (
                            <ChannelBrandIcon channelId={entry.channelId} className="size-4 shrink-0" />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          {pendingCount > 0 ? (
                            <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-medium leading-none text-white">
                              {pendingCount}
                            </span>
                          ) : null}
                          {dotClass ? (
                            <span
                              className={cn('size-1.5 shrink-0 rounded-full', dotClass)}
                              title={t(`settings.channels.state.${channelView!.status.state}`)}
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        {/* <div className="shrink-0 border-t border-line px-4 py-3 text-xs text-ink-tertiary">
          {t('settings.autoSave')}
        </div> */}
      </aside>

      <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[55rem] px-8 pt-11 pb-10">{content}</div>
      </main>
    </div>
  );
}
