import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Plug,
  PlugZap,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type {
  CapabilityCatalog,
  PiExtensionCatalog,
  PiExtensionView,
  PiSkillCatalog,
  PiSkillView,
} from '@opc/shared/ipc';
import { Section } from '@/features/settings/ui/kit';
import {
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
  isExternalExtension,
} from '@/shared/lib/extensionCopy';
import { cn } from '@/shared/lib/cn';
import { ExternalExtensionsSection } from './ExternalExtensionsSection';
import { McpSection } from './McpSection';
import { SkillsSection } from './SkillsSection';
import { ToolsSection } from './ToolsSection';
import { distinctToolNames, groupExtensions, toToolGroups } from './model/grouping';
import type { ExtensionGroup } from './model/grouping';

type Tab = 'extensions' | 'tools' | 'skills' | 'mcp';
const TABS: readonly Tab[] = ['extensions', 'tools', 'skills', 'mcp'];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);

/**
 * One installed extension. Tools are counted here, not listed: the 工具 tab is
 * the place that answers "what can the model call", and duplicating it in both
 * tabs makes the two drift apart.
 */
function ExtensionRow({ group }: { group: ExtensionGroup }) {
  const { t } = useTranslation();
  const titleKey = extensionTitleKey(group.name);
  const descriptionKey = extensionDescriptionKey(group.name);
  // External Pi extensions are named `pi.<slug>` by the host; point at the
  // section above instead of the generic "unregistered" copy.
  const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
  const description = descriptionKey
    ? t(descriptionKey)
    : isExternalExtension(group.name)
      ? t('capabilities.external.groupDescription')
      : t('capabilities.unknownExtension');

  // Hook-only extensions are still capabilities; say what they add instead of tools.
  const runtimeParts = [
    group.hooks > 0 ? t('capabilities.counts.hooks', { count: group.hooks }) : '',
    group.tasks > 0 ? t('capabilities.counts.tasks', { count: group.tasks }) : '',
    group.sections > 0 ? t('capabilities.counts.sections', { count: group.sections }) : '',
  ].filter(Boolean);

  return (
    <article className="capability-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="capability-icon grid size-10 shrink-0 place-items-center rounded-xl">
          <Boxes className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className="min-w-0 truncate text-sm-plus font-semibold text-ink">{title}</h4>
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-1 text-3xs font-semibold text-accent-ink">
              {group.tools.length}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs-plus leading-relaxed text-ink-tertiary">{description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-3xs text-ink-quaternary">
            <span>{t('capabilities.extensionAgents', { count: group.agents })}</span>
            <span aria-hidden="true">·</span>
            <span>{group.tools.length > 0 ? t('capabilities.extensionToolCount', { count: group.tools.length }) : t('capabilities.extensionNoTools')}</span>
            {runtimeParts.length > 0 ? <span className="truncate">· {runtimeParts.join(' · ')}</span> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function TabBar({
  tab,
  onTab,
  counts,
}: {
  tab: Tab;
  onTab: (next: Tab) => void;
  counts: Record<Tab, number | null>;
}) {
  const { t } = useTranslation();
  const tabs: { id: Tab; icon: LucideIcon; label: string }[] = [
    { id: 'extensions', icon: Plug, label: t('capabilities.tabs.extensions') },
    { id: 'tools', icon: Wrench, label: t('capabilities.tabs.tools') },
    { id: 'skills', icon: Boxes, label: t('capabilities.tabs.skills') },
    { id: 'mcp', icon: PlugZap, label: t('capabilities.tabs.mcp') },
  ];

  return (
    <div
      role="tablist"
      aria-label={t('capabilities.title')}
      className="capabilities-tabs flex shrink-0 items-center gap-1 rounded-xl p-1"
    >
      {tabs.map(({ id, icon: Icon, label }) => {
        const active = tab === id;
        const count = counts[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTab(id)}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm-plus font-medium transition-colors',
              active ? 'bg-surface/90 text-ink shadow-card' : 'text-ink-tertiary hover:bg-surface/45 hover:text-ink',
            )}
          >
            <Icon className={cn('size-3.5', active && 'text-accent')} />
            {label}
            {count !== null ? (
              <span
                className={cn(
                  'rounded px-1 font-mono text-3xs',
                  active ? 'bg-accent-soft text-accent-ink' : 'bg-surface text-ink-quaternary',
                )}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function CapabilitiesPage() {
  const { t } = useTranslation();
  // The tab lives in the URL (`#/skills?tab=tools`) so a reload or a refresh
  // click does not bounce the user back to the first tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: Tab = isTab(requested) ? requested : 'extensions';
  const setTab = useCallback(
    (next: Tab) => setSearchParams(next === 'extensions' ? {} : { tab: next }, { replace: true }),
    [setSearchParams],
  );
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [extensions, setExtensions] = useState<PiExtensionCatalog | null>(null);
  const [skills, setSkills] = useState<PiSkillCatalog | null>(null);
  const [error, setError] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [busyExtension, setBusyExtension] = useState('');
  const [skillError, setSkillError] = useState('');
  const [busySkill, setBusySkill] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, found, discovered] = await Promise.all([
        window.opc?.capabilities.list(),
        window.opc?.extensions.list(),
        window.opc?.skills.list(),
      ]);
      setCatalog(next ?? null);
      setExtensions(found ?? null);
      setSkills(discovered ?? null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleExtension = useCallback(
    async (entry: PiExtensionView, next: boolean) => {
      setBusyExtension(entry.id);
      setExtensionError('');
      try {
        const updated = await window.opc?.extensions.setEnabled(entry.id, next, true);
        if (updated) setExtensions(updated);
        // The registry changed, so the per-agent snapshot is stale as well.
        const refreshed = await window.opc?.capabilities.list();
        if (refreshed) setCatalog(refreshed);
      } catch (cause) {
        setExtensionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyExtension('');
      }
    },
    [],
  );

  const toggleSkill = useCallback(async (entry: PiSkillView, next: boolean) => {
    setBusySkill(entry.id);
    setSkillError('');
    try {
      const updated = await window.opc?.skills.setEnabled(entry.id, next);
      if (updated) setSkills(updated);
      // The skills prompt section is part of the registry, so refresh both.
      const refreshed = await window.opc?.capabilities.list();
      if (refreshed) setCatalog(refreshed);
    } catch (cause) {
      setSkillError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySkill('');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = useMemo(() => catalog?.agents ?? [], [catalog]);
  const groups = useMemo(() => groupExtensions(agents), [agents]);
  const toolGroups = useMemo(() => toToolGroups(groups), [groups]);
  const toolNames = useMemo(() => distinctToolNames(groups), [groups]);

  const counts: Record<Tab, number | null> = {
    extensions: (extensions?.entries.length ?? 0) + groups.length,
    tools: toolNames.size,
    skills: skills?.entries.filter((entry) => entry.enabled).length ?? null,
    mcp: null,
  };

  return (
    <div className="capabilities-page page-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[72rem] px-5 py-5 sm:px-7 sm:py-7">
        <div className="flex items-center justify-between gap-4 pb-1">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-ink">{t('capabilities.title')}</h1>
            <p className="mt-1 text-xs-plus text-ink-tertiary">{t('capabilities.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface/75 px-3 text-xs-plus font-semibold text-ink-secondary shadow-card transition hover:bg-surface hover:text-ink disabled:opacity-60"
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">{t('capabilities.refresh')}</span>
          </button>
        </div>

        {error ? (
          <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {t('capabilities.loadError', { message: error })}
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          <TabBar tab={tab} onTab={setTab} counts={counts} />

          {tab === 'extensions' ? (
            <>
              <ExternalExtensionsSection
                catalog={extensions}
                busyId={busyExtension}
                error={extensionError}
                onToggle={(entry, next) => void toggleExtension(entry, next)}
              />

              <Section
                className="capabilities-section"
                title={t('capabilities.extensionsTitle')}
                description={t('capabilities.extensionsHint')}
                action={<Boxes className="size-4 text-ink-quaternary" />}
              >
                {groups.length > 0 ? (
                  <div className="grid gap-3 p-4 md:grid-cols-2">
                    {groups.map((group) => (
                      <ExtensionRow key={group.name} group={group} />
                    ))}
                  </div>
                ) : (
                  <p className="px-4 py-6 text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
                )}
              </Section>
            </>
          ) : null}

          {tab === 'tools' ? <ToolsSection groups={toolGroups} agents={agents} /> : null}

          {tab === 'skills' ? (
            <SkillsSection
              catalog={skills}
              busyId={busySkill}
              error={skillError}
              onToggle={(entry, next) => void toggleSkill(entry, next)}
            />
          ) : null}

          {tab === 'mcp' ? <McpSection /> : null}
        </div>
      </div>
    </div>
  );
}
