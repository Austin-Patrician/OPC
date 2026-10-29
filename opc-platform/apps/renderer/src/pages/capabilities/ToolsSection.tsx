import { useState } from 'react';
import { ChevronDown, Users, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCapability } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { Section } from '@/features/settings/ui/kit';
import {
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
  isExternalExtension,
} from '@/features/employee-stack/model/extensionCopy';
import { cn } from '@/shared/lib/cn';
import { toolAgentCounts, type ToolGroup } from './model/grouping';

/**
 * 工具 tab: the callable surface, not the packaging.
 *
 * The extension tab answers "what is installed"; this one answers "what can the
 * model actually call", so a tool appears once no matter how many agents share
 * it, and the per-agent view at the bottom is the reverse index.
 */

export function ToolsSection({
  groups,
  agents,
}: {
  groups: readonly ToolGroup[];
  agents: readonly AgentCapability[];
}) {
  const { t } = useTranslation();
  const counts = toolAgentCounts(agents);
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0);

  return (
    <>
      <Section
        title={t('capabilities.toolsTab.title')}
        description={t('capabilities.toolsTab.description', { count: total })}
        action={<Wrench className="size-4 text-ink-quaternary" />}
      >
        {groups.length > 0 ? (
          <ul className="divide-y divide-line">
            {groups.map((group) => (
              <ToolGroupRow key={group.name} group={group} counts={counts} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
        )}
      </Section>

      <Section
        title={t('capabilities.agentTitle')}
        description={t('capabilities.agentHint')}
        action={<Users className="size-4 text-ink-quaternary" />}
      >
        {agents.length > 0 ? (
          <ul className="divide-y divide-line">
            {agents.map((agent) => (
              <AgentRow key={agent.employeeId} agent={agent} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
        )}
      </Section>
    </>
  );
}

function ToolGroupRow({
  group,
  counts,
}: {
  group: ToolGroup;
  counts: Map<string, number>;
}) {
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
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm-plus font-semibold text-ink">{title}</h4>
        <code className="rounded bg-surface-muted px-1.5 py-px font-mono text-3xs text-ink-tertiary">
          {group.name}
        </code>
        <span className="rounded bg-surface-muted px-1.5 py-0.5 text-3xs font-medium text-ink-tertiary">
          {t('capabilities.extensionAgents', { count: group.agents })}
        </span>
      </div>
      <p className="mt-1 text-xs-plus leading-relaxed text-ink-tertiary">{description}</p>

      <ul className="mt-2 grid gap-1.5 xl:grid-cols-2">
        {group.tools.map((tool) => (
          <li
            key={tool.name}
            className="flex items-start gap-2 rounded-md border border-line/70 bg-surface-muted/50 px-2.5 py-1.5"
          >
            <code className="shrink-0 pt-px font-mono text-2xs font-medium text-ink">{tool.name}</code>
            {tool.deferred ? (
              <span className="shrink-0 rounded bg-surface px-1 py-px text-3xs text-ink-tertiary">
                {t('capabilities.deferred')}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 text-xs-plus leading-relaxed text-ink-tertiary">
              {tool.description || t(`capabilities.tools.${tool.name}`, { defaultValue: '' })}
            </span>
            <span className="shrink-0 text-3xs text-ink-quaternary">
              {t('capabilities.toolsTab.agents', { count: counts.get(tool.name) ?? 0 })}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function AgentRow({ agent }: { agent: AgentCapability }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <Avatar name={agent.name} src={agent.avatar || undefined} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm-plus font-medium text-ink">{agent.name}</span>
            {agent.isHead ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-medium text-accent-ink">
                {t('capabilities.head')}
              </span>
            ) : null}
            <span className="text-3xs text-ink-quaternary">{agent.departmentName}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-tertiary">
            {agent.role}
            <span className="mx-1 text-ink-quaternary">·</span>
            {agent.level}
            <span className="mx-1 text-ink-quaternary">·</span>
            <code className="font-mono text-3xs">{agent.model || '—'}</code>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-3xs text-ink-tertiary">
          <span>{t('capabilities.agentExtensions', { count: agent.extensions.length })}</span>
          <span className="text-ink-quaternary">/</span>
          <span>{t('capabilities.agentTools', { count: agent.tools.length })}</span>
          <ChevronDown
            className={cn('size-3.5 text-ink-quaternary transition-transform', open && 'rotate-180')}
          />
        </div>
      </button>

      {open ? (
        <div className="grid gap-3 border-t border-line bg-surface-muted/30 px-4 py-3 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1.5 text-2xs font-semibold text-ink-tertiary">
              {t('capabilities.agentExtensionsLabel')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agent.extensions.map((extension) => {
                const key = extensionTitleKey(extension.name);
                return (
                  <span
                    key={extension.name}
                    title={extension.name}
                    className="rounded border border-line bg-surface px-1.5 py-0.5 text-3xs text-ink-secondary"
                  >
                    {key ? t(key) : extensionFallbackTitle(extension.name)}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-1.5 text-2xs font-semibold text-ink-tertiary">
              {t('capabilities.agentSkillsLabel')}
            </div>
            {agent.skills.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map((skill) => (
                  <span key={skill} className="rounded bg-surface px-1.5 py-0.5 text-3xs text-ink-tertiary">
                    {skill}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-3xs text-ink-quaternary">{t('capabilities.noSkills')}</span>
            )}
          </div>
          <div className="min-w-0 sm:col-span-2">
            <div className="mb-1.5 text-2xs font-semibold text-ink-tertiary">
              {t('capabilities.agentToolsLabel')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.map((tool) => (
                <code
                  key={tool.name}
                  title={tool.extension}
                  className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-3xs text-ink-secondary"
                >
                  {tool.name}
                </code>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
