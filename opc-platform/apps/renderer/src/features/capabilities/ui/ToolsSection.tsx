import { useMemo, useState } from 'react';
import {
  AudioLines,
  Brain,
  ChevronDown,
  File,
  GitBranch,
  Image,
  MessageSquare,
  Pencil,
  ScanText,
  Scale,
  Terminal,
  Volume2,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCapability } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { Section } from '@/features/settings/ui/kit';
import {
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
  isExternalExtension,
} from '@/shared/lib/extensionCopy';
import { cn } from '@/shared/lib/cn';
import { toolAgentCounts, type ToolGroup } from '../model/grouping';
import { FilterPills, FilterToolbar } from './CapabilityPrimitives';
import { ExtensionTile } from './ExtensionCard';

type ToolsView = 'groups' | 'agents';

export function ToolsSection({
  groups,
  agents,
}: {
  groups: readonly ToolGroup[];
  agents: readonly AgentCapability[];
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<ToolsView>('groups');
  const [query, setQuery] = useState('');
  const counts = useMemo(() => toolAgentCounts(agents), [agents]);
  const q = query.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((group) => {
        const titleKey = extensionTitleKey(group.name);
        const title = (titleKey ? t(titleKey) : extensionFallbackTitle(group.name)).toLowerCase();
        const groupMatches = title.includes(q) || group.name.toLowerCase().includes(q);
        if (groupMatches) return group;
        const tools = group.tools.filter((tool) => {
          const desc = (
            tool.description || t(`capabilities.tools.${tool.name}`, { defaultValue: '' })
          ).toLowerCase();
          return tool.name.toLowerCase().includes(q) || desc.includes(q);
        });
        return tools.length > 0 ? { ...group, tools } : null;
      })
      .filter((item): item is ToolGroup => item !== null);
  }, [groups, q, t]);

  const filteredAgents = useMemo(() => {
    if (!q) return agents;
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(q) ||
        agent.tools.some((tool) => tool.name.toLowerCase().includes(q)) ||
        agent.skills.some((skill) => skill.toLowerCase().includes(q)),
    );
  }, [agents, q]);

  return (
    <div className="space-y-4">
      <FilterToolbar
        query={query}
        onQueryChange={setQuery}
        placeholder={t('capabilities.ui.searchTools')}
        rightSlot={
          <FilterPills<ToolsView>
            label={t('capabilities.toolsTab.title')}
            value={view}
            onChange={setView}
            options={[
              {
                value: 'groups',
                label: t('capabilities.ui.viewByGroup'),
                count: filteredGroups.length,
              },
              {
                value: 'agents',
                label: t('capabilities.ui.viewByAgent'),
                count: filteredAgents.length,
              },
            ]}
          />
        }
      />

      {view === 'groups' ? (
        filteredGroups.length > 0 ? (
          <div className="space-y-4">
            {filteredGroups.map((group) => (
              <ToolGroupSection key={group.name} group={group} counts={counts} />
            ))}
          </div>
        ) : (
          <Section title={t('capabilities.toolsTab.title')}>
            <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
              {q ? t('capabilities.ui.noMatches') : t('capabilities.empty')}
            </p>
          </Section>
        )
      ) : filteredAgents.length > 0 ? (
        <div className="space-y-3">
          {filteredAgents.map((agent, index) => (
            <AgentRow key={agent.workerId} agent={agent} defaultOpen={index === 0} />
          ))}
        </div>
      ) : (
        <Section title={t('capabilities.agentTitle')}>
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {q ? t('capabilities.ui.noMatches') : t('capabilities.empty')}
          </p>
        </Section>
      )}
    </div>
  );
}

function ToolGroupSection({ group, counts }: { group: ToolGroup; counts: Map<string, number> }) {
  const { t } = useTranslation();
  const titleKey = extensionTitleKey(group.name);
  const descriptionKey = extensionDescriptionKey(group.name);
  const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
  const description = descriptionKey
    ? t(descriptionKey)
    : isExternalExtension(group.name)
      ? t('capabilities.external.groupDescription')
      : t('capabilities.unknownExtension');

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <ExtensionTile name={group.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base-plus font-semibold text-ink">{title}</h3>
            <code className="hidden rounded bg-surface-muted px-1.5 py-px font-mono text-2xs text-ink-quaternary sm:inline-block">
              {group.name}
            </code>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs-plus text-ink-tertiary">{description}</p>
        </div>
        <span className="shrink-0 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-secondary tabular-nums">
          {group.tools.length}
        </span>
      </header>

      <div className="grid gap-2.5 p-4 sm:grid-cols-2">
        {group.tools.map((tool) => {
          const Icon = toolIcon(tool.name);
          const desc =
            tool.description || t(`capabilities.tools.${tool.name}`, { defaultValue: '' });
          return (
            <div
              key={tool.name}
              className="flex flex-col justify-between rounded-lg border border-line/80 bg-surface-muted/25 px-3.5 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-muted/45"
            >
              <div>
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0 text-accent" />
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink"
                    title={tool.name}
                  >
                    {tool.name}
                  </code>
                  {tool.deferred ? (
                    <span className="shrink-0 rounded-full border border-line bg-surface px-1.5 py-px text-3xs text-ink-quaternary">
                      {t('capabilities.deferred')}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-3xs text-ink-quaternary tabular-nums">
                    {t('capabilities.toolsTab.agents', { count: counts.get(tool.name) ?? 0 })}
                  </span>
                </div>
                {desc ? (
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-tertiary">
                    {desc}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AgentRow({ agent, defaultOpen }: { agent: AgentCapability; defaultOpen: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

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
              {agent.tools.length} {t('capabilities.tabs.tools')}
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
            {agent.tools.map((tool) => (
              <code
                key={tool.name}
                title={tool.extension}
                className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-3xs text-ink-secondary"
              >
                {tool.name}
              </code>
            ))}
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

function toolIcon(name: string): LucideIcon {
  const normalized = name.toLowerCase();
  if (normalized === 'read' || normalized === 'write') return File;
  if (normalized === 'edit') return Pencil;
  if (normalized === 'bash') return Terminal;
  if (normalized.includes('image') || normalized.includes('generate')) return Image;
  if (normalized.includes('transcribe')) return AudioLines;
  if (normalized.includes('speech')) return Volume2;
  if (normalized.includes('ocr')) return ScanText;
  if (normalized.includes('remember')) return Brain;
  if (normalized.includes('decompose')) return GitBranch;
  if (normalized.includes('decide')) return Scale;
  if (normalized.includes('message') || normalized.includes('colleague')) return MessageSquare;
  return Wrench;
}
