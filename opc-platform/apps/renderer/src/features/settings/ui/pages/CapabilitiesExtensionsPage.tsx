import { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCapability } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { BuiltinExtensionsSection } from '@/features/capabilities/ui/BuiltinExtensionsSection';
import { FilterPills, FilterToolbar } from '@/features/capabilities/ui/CapabilityPrimitives';
import { ExternalExtensionsSection } from '@/features/capabilities/ui/ExternalExtensionsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import {
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
} from '@/shared/lib/extensionCopy';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Section } from '../kit';

type ScopeFilter = 'all' | 'external' | 'builtin' | 'agents';

/** 技能与工具 · 扩展：本机 Pi 扩展、内置能力模块与按执行体查看。 */
export function CapabilitiesExtensionsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');

  const externalEntries = useMemo(() => capabilities.extensions?.entries ?? [], [capabilities.extensions]);
  const q = query.trim().toLowerCase();

  const filteredExternal = useMemo(() => {
    if (!q) return externalEntries;
    return externalEntries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.tools.some((tool) => tool.toLowerCase().includes(q)),
    );
  }, [externalEntries, q]);

  const filteredBuiltin = useMemo(() => {
    if (!q) return capabilities.groups;
    return capabilities.groups.filter((group) => {
      const titleKey = extensionTitleKey(group.name);
      const descKey = extensionDescriptionKey(group.name);
      const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
      const desc = descKey ? t(descKey) : '';
      return (
        title.toLowerCase().includes(q) ||
        desc.toLowerCase().includes(q) ||
        group.name.toLowerCase().includes(q) ||
        group.tools.some((tool) => tool.name.toLowerCase().includes(q))
      );
    });
  }, [capabilities.groups, q, t]);

  const filteredAgents = useMemo(() => {
    if (!q) return capabilities.agents;
    return capabilities.agents.filter((agent) => {
      const nonMcpTools = agent.tools.filter((tool) => tool.extension !== 'opc.mcp');
      return (
        agent.name.toLowerCase().includes(q) ||
        nonMcpTools.some((tool) => tool.name.toLowerCase().includes(q)) ||
        agent.skills.some((skill) => skill.toLowerCase().includes(q))
      );
    });
  }, [capabilities.agents, q]);

  const filteredExternalCatalog = useMemo(
    () =>
      capabilities.extensions
        ? { ...capabilities.extensions, entries: filteredExternal }
        : null,
    [capabilities.extensions, filteredExternal],
  );

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.capabilities'), t('settings.page.capabilitiesExtensions')]}
        title={t('settings.page.capabilitiesExtensions')}
        description={t('capabilities.extensionsPageDescription')}
        actions={
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => void capabilities.load()}
            disabled={capabilities.loading}
          >
            <RefreshCw className={cn('size-3.5', capabilities.loading && 'animate-spin')} />
            {t('capabilities.refresh')}
          </button>
        }
      />

      {capabilities.error ? (
        <p className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
          {t('capabilities.loadError', { message: capabilities.error })}
        </p>
      ) : null}

      <div className="space-y-5">
        <FilterToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t('capabilities.ui.searchExtensions')}
          rightSlot={
            <FilterPills<ScopeFilter>
              label={t('capabilities.ui.filterScopeLabel')}
              value={scope}
              onChange={setScope}
              options={[
                {
                  value: 'all',
                  label: t('capabilities.ui.filterAll'),
                  count: externalEntries.length + capabilities.groups.length,
                },
                {
                  value: 'external',
                  label: t('capabilities.ui.filterExternal'),
                  count: externalEntries.length,
                },
                {
                  value: 'builtin',
                  label: t('capabilities.ui.filterBuiltin'),
                  count: capabilities.groups.length,
                },
                {
                  value: 'agents',
                  label: t('capabilities.ui.filterByAgent'),
                  count: capabilities.agents.length,
                },
              ]}
            />
          }
        />

        {scope === 'agents' ? (
          filteredAgents.length > 0 ? (
            <div className="space-y-3">
              {filteredAgents.map((agent, index) => (
                <AgentCapabilitiesCard
                  key={agent.workerId}
                  agent={agent}
                  defaultOpen={index === 0}
                />
              ))}
            </div>
          ) : (
            <Section title={t('capabilities.agentTitle')}>
              <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
                {q ? t('capabilities.ui.noMatches') : t('capabilities.empty')}
              </p>
            </Section>
          )
        ) : (
          <>
            {scope === 'all' || scope === 'external' ? (
              <ExternalExtensionsSection
                catalog={filteredExternalCatalog}
                filteredEmpty={Boolean(q) && externalEntries.length > 0 && filteredExternal.length === 0}
                busyId={capabilities.busyExtension}
                error={capabilities.extensionError}
                onToggle={(entry, next) => void capabilities.toggleExtension(entry, next)}
              />
            ) : null}

            {scope === 'all' || scope === 'builtin' ? (
              <BuiltinExtensionsSection
                groups={filteredBuiltin}
                filteredEmpty={Boolean(q) && capabilities.groups.length > 0 && filteredBuiltin.length === 0}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function AgentCapabilitiesCard({
  agent,
  defaultOpen,
}: {
  agent: AgentCapability;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  const { nonMcpTools, mcpToolCount } = useMemo(() => {
    const regular = agent.tools.filter((tool) => tool.extension !== 'opc.mcp');
    return {
      nonMcpTools: regular,
      mcpToolCount: agent.tools.length - regular.length,
    };
  }, [agent.tools]);

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted/30"
      >
        <Avatar name={agent.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{agent.name}</span>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-3xs font-medium text-accent-ink">
              {t(`capabilities.statuses.${agent.status}`)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-3xs text-ink-quaternary">
            <span>{t(`capabilities.templates.${agent.template}`)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {t('capabilities.agentTools', { count: nonMcpTools.length })}
            </span>
            {agent.skills.length > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {agent.skills.length} {t('capabilities.tabs.skills')}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-ink-quaternary transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-line bg-surface-muted/20 px-4 py-3.5">
          <div className="flex flex-wrap gap-1.5">
            {nonMcpTools.map((tool) => (
              <code
                key={tool.name}
                title={tool.extension}
                className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-3xs text-ink-secondary"
              >
                {tool.name}
              </code>
            ))}
            {mcpToolCount > 0 ? (
              <span className="rounded-md border border-line bg-surface-muted/60 px-2 py-1 text-3xs text-ink-tertiary">
                {t('capabilities.agentMcpSummary', { count: mcpToolCount })}
              </span>
            ) : null}
          </div>
          {agent.skills.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line/60 pt-2.5">
              {agent.skills.map((skill) => (
                <span
                  key={skill}
                  className="rounded-md bg-accent-soft px-2 py-0.5 text-3xs font-medium text-accent-ink"
                >
                  {skill}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
