import { useState } from 'react';
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
  Users,
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
        action={
          <span className="rounded-full bg-accent-soft px-2.5 py-1 text-3xs font-semibold text-accent-ink">
            {total}
          </span>
        }
        className="capabilities-section"
      >
        {groups.length > 0 ? (
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {groups.map((group) => (
              <ToolGroupCard key={group.name} group={group} counts={counts} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
        )}
      </Section>

      <Section
        title={t('capabilities.agentTitle')}
        description={t('capabilities.agentHint')}
        action={<Users className="size-4 text-accent" />}
        className="capabilities-section"
      >
        {agents.length > 0 ? (
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {agents.map((agent) => (
              <AgentCard key={agent.workerId} agent={agent} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
        )}
      </Section>
    </>
  );
}

function ToolGroupCard({ group, counts }: { group: ToolGroup; counts: Map<string, number> }) {
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
    <article className="capability-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="capability-icon grid size-10 shrink-0 place-items-center rounded-xl">
          <Wrench className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="truncate text-sm-plus font-semibold text-ink">{title}</h4>
              <code className="mt-1 block truncate font-mono text-3xs text-ink-quaternary">{group.name}</code>
            </div>
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-1 text-3xs font-semibold text-accent-ink">
              {group.tools.length}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-xs-plus leading-relaxed text-ink-tertiary">{description}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {group.tools.map((tool) => {
          const Icon = toolIcon(tool.name);
          return (
            <div key={tool.name} className="rounded-xl border border-line/70 bg-surface-muted/45 p-2.5">
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-accent" />
                <code className="min-w-0 truncate font-mono text-2xs font-medium text-ink" title={tool.name}>
                  {tool.name}
                </code>
                <span className="ml-auto shrink-0 text-3xs text-ink-quaternary">
                  {t('capabilities.toolsTab.agents', { count: counts.get(tool.name) ?? 0 })}
                </span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-3xs leading-relaxed text-ink-tertiary">
                {tool.description || t(`capabilities.tools.${tool.name}`, { defaultValue: '' })}
              </p>
              {tool.deferred ? <span className="mt-1.5 inline-flex rounded-full bg-surface px-1.5 py-0.5 text-3xs text-ink-quaternary">{t('capabilities.deferred')}</span> : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}

function AgentCard({ agent }: { agent: AgentCapability }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <article className="capability-card overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <Avatar name={agent.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm-plus font-semibold text-ink">{agent.name}</span>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-3xs font-medium text-accent-ink">
              {t(`capabilities.statuses.${agent.status}`)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-3xs text-ink-quaternary">
            <span>{t(`capabilities.templates.${agent.template}`)}</span>
            <span aria-hidden="true">·</span>
            <span>{agent.tools.length} {t('capabilities.tabs.tools')}</span>
          </div>
        </div>
        <ChevronDown className={cn('size-4 shrink-0 text-ink-quaternary transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div className="border-t border-line/70 bg-surface-muted/25 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((tool) => (
              <code key={tool.name} title={tool.extension} className="rounded-lg border border-line bg-surface px-2 py-1 font-mono text-3xs text-ink-secondary">
                {tool.name}
              </code>
            ))}
          </div>
          {agent.skills.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {agent.skills.map((skill) => <span key={skill} className="rounded-lg bg-accent-soft px-2 py-1 text-3xs text-accent-ink">{skill}</span>)}
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
