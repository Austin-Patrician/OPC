import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronDown, RefreshCw, Tags, Users, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCapability, CapabilityCatalog, CapabilityTool } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { PageHeader, Section } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/** Extension ids contain dots, which i18next reads as nesting — map to flat keys. */
const EXTENSION_KEY: Record<string, string> = {
  'opc.work': 'work',
  'coding-tools': 'coding',
  'opc.sandbox': 'sandbox',
  'opc.limits': 'limits',
  'opc.image': 'image',
  'opc.speech': 'speech',
  'opc.ocr': 'ocr',
  'opc.memory': 'memory',
  'opc.comm': 'comm',
  'opc.decompose': 'decompose',
};

interface ExtensionGroup {
  name: string;
  tools: CapabilityTool[];
  agents: number;
  hooks: number;
  tasks: number;
  sections: number;
}

/** Union of what every agent installed, in the registry's install order. */
function groupExtensions(agents: AgentCapability[]): ExtensionGroup[] {
  const groups = new Map<string, ExtensionGroup>();

  for (const agent of agents) {
    for (const extension of agent.extensions) {
      const group = groups.get(extension.name) ?? {
        name: extension.name,
        tools: [],
        agents: 0,
        hooks: 0,
        tasks: 0,
        sections: 0,
      };
      group.agents += 1;
      group.hooks = Math.max(group.hooks, extension.hooks);
      group.tasks = Math.max(group.tasks, extension.tasks);
      group.sections = Math.max(group.sections, extension.sections);
      for (const tool of agent.tools) {
        if (tool.extension !== extension.name) continue;
        if (!group.tools.some((entry) => entry.name === tool.name)) group.tools.push(tool);
      }
      groups.set(extension.name, group);
    }
  }

  return [...groups.values()];
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-2xs font-medium text-ink-tertiary">{label}</div>
        <div className="text-lg leading-tight font-semibold text-ink">{value}</div>
      </div>
    </div>
  );
}

function ExtensionRow({ group }: { group: ExtensionGroup }) {
  const { t } = useTranslation();
  const key = EXTENSION_KEY[group.name];
  const title = key ? t(`capabilities.extensions.${key}.title`) : group.name;
  const description = key
    ? t(`capabilities.extensions.${key}.description`)
    : t('capabilities.unknownExtension');

  // Hook-only extensions are still capabilities; say what they add instead of tools.
  const runtimeParts = [
    group.hooks > 0 ? t('capabilities.counts.hooks', { count: group.hooks }) : '',
    group.tasks > 0 ? t('capabilities.counts.tasks', { count: group.tasks }) : '',
    group.sections > 0 ? t('capabilities.counts.sections', { count: group.sections }) : '',
  ].filter(Boolean);

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted text-ink-tertiary">
          <Boxes className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm-plus font-semibold text-ink">{title}</h4>
            <code className="rounded bg-surface-muted px-1.5 py-px font-mono text-3xs text-ink-tertiary">
              {group.name}
            </code>
            <span className="rounded bg-surface-muted px-1.5 py-0.5 text-3xs font-medium text-ink-tertiary">
              {t('capabilities.extensionAgents', { count: group.agents })}
            </span>
            {group.tools.length > 0 ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-medium text-accent-ink">
                {t('capabilities.extensionToolCount', { count: group.tools.length })}
              </span>
            ) : (
              <span className="rounded bg-warning/12 px-1.5 py-0.5 text-3xs font-medium text-warning">
                {t('capabilities.extensionNoTools')}
                {runtimeParts.length > 0 ? ` · ${runtimeParts.join(' · ')}` : ''}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs-plus leading-relaxed text-ink-tertiary">{description}</p>

          {group.tools.length > 0 ? (
            <ul className="mt-2 grid gap-1.5 xl:grid-cols-2">
              {group.tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex items-start gap-2 rounded-md border border-line/70 bg-surface-muted/50 px-2.5 py-1.5"
                >
                  <code className="shrink-0 pt-px font-mono text-2xs font-medium text-ink">
                    {tool.name}
                  </code>
                  {tool.deferred ? (
                    <span className="shrink-0 rounded bg-surface px-1 py-px text-3xs text-ink-tertiary">
                      {t('capabilities.deferred')}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 text-xs-plus leading-relaxed text-ink-tertiary">
                    {tool.description}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
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
            className={cn(
              'size-3.5 text-ink-quaternary transition-transform',
              open && 'rotate-180',
            )}
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
                const key = EXTENSION_KEY[extension.name];
                return (
                  <span
                    key={extension.name}
                    title={extension.name}
                    className="rounded border border-line bg-surface px-1.5 py-0.5 text-3xs text-ink-secondary"
                  >
                    {key ? t(`capabilities.extensions.${key}.title`) : extension.name}
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
                  <span
                    key={skill}
                    className="rounded bg-surface px-1.5 py-0.5 text-3xs text-ink-tertiary"
                  >
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
                  key={`${tool.extension}:${tool.name}`}
                  title={`${tool.extension} · ${tool.description}`}
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

export function CapabilitiesPage() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.opc?.capabilities.list();
      setCatalog(next ?? null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = useMemo(() => catalog?.agents ?? [], [catalog]);
  const groups = useMemo(() => groupExtensions(agents), [agents]);
  const toolNames = useMemo(
    () => new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name))),
    [groups],
  );
  const skillNames = useMemo(() => new Set(agents.flatMap((agent) => agent.skills)), [agents]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
      <div className="mx-auto w-full max-w-[64rem] px-6 py-6">
        <PageHeader
          crumbs={[t('nav.skills')]}
          title={t('capabilities.title')}
          description={t('capabilities.subtitle')}
          actions={
            <button
              type="button"
              onClick={() => void load()}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('capabilities.refresh')}
            </button>
          }
        />

        {error ? (
          <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {t('capabilities.loadError', { message: error })}
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          <Section
            title={t('capabilities.overviewTitle')}
            description={t('capabilities.overviewHint')}
            action={
              catalog ? (
                <span className="text-3xs text-ink-quaternary">
                  {new Date(catalog.generatedAt).toLocaleTimeString()}
                </span>
              ) : null
            }
          >
            <div className="grid grid-cols-2 sm:grid-cols-4">
              <Stat
                icon={Users}
                label={t('capabilities.stats.agents')}
                value={String(agents.length)}
              />
              <Stat
                icon={Boxes}
                label={t('capabilities.stats.extensions')}
                value={String(groups.length)}
              />
              <Stat
                icon={Wrench}
                label={t('capabilities.stats.tools')}
                value={String(toolNames.size)}
              />
              <Stat
                icon={Tags}
                label={t('capabilities.stats.skills')}
                value={String(skillNames.size)}
              />
            </div>
            <p className="border-t border-line px-4 py-3 text-xs leading-relaxed text-ink-tertiary">
              {t('capabilities.honesty')}
            </p>
          </Section>

          <Section
            title={t('capabilities.extensionsTitle')}
            description={t('capabilities.extensionsHint')}
            action={<Wrench className="size-4 text-ink-quaternary" />}
          >
            {groups.length > 0 ? (
              <ul className="divide-y divide-line">
                {groups.map((group) => (
                  <ExtensionRow key={group.name} group={group} />
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
        </div>
      </div>
    </div>
  );
}
