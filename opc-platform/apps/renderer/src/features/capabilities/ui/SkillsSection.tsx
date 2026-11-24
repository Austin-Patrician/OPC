import { useMemo, useState } from 'react';
import { BookOpen, Braces, FileCode2, FolderOpen, Gem, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PiSkillCatalog, PiSkillView } from '@opc/shared/ipc';
import { Section, Toggle } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';
import { FilterPills, FilterToolbar, StatStrip } from './CapabilityPrimitives';

type SkillStatusFilter = 'all' | 'enabled' | 'disabled';

export function SkillsSection({
  catalog,
  busyId,
  error,
  onToggle,
}: {
  catalog: PiSkillCatalog | null;
  busyId: string;
  error: string;
  onToggle: (entry: PiSkillView, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>('all');

  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const enabled = useMemo(() => entries.filter((entry) => entry.enabled), [entries]);
  const disabledCount = entries.length - enabled.length;
  const tokens = useMemo(
    () => enabled.reduce((sum, entry) => sum + entry.promptTokens, 0),
    [enabled],
  );
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    return entries.filter((entry) => {
      if (statusFilter === 'enabled' && !entry.enabled) return false;
      if (statusFilter === 'disabled' && entry.enabled) return false;
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.dir.toLowerCase().includes(q)
      );
    });
  }, [entries, q, statusFilter]);

  return (
    <div className="space-y-5">
      <StatStrip
        items={[
          {
            label: t('capabilities.ui.statEnabledSkills'),
            value: `${enabled.length}/${entries.length}`,
            accent: enabled.length > 0,
          },
          {
            label: t('capabilities.ui.statPromptBudget'),
            value: `~${tokens}`,
            hint: 'tokens',
          },
          {
            label: t('capabilities.ui.statScanDirs'),
            value: catalog?.roots.length ?? 0,
          },
        ]}
      />

      {entries.length > 0 ? (
        <FilterToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t('capabilities.ui.searchSkills')}
          rightSlot={
            <FilterPills<SkillStatusFilter>
              label={t('capabilities.skills.title')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: t('capabilities.ui.filterAll'), count: entries.length },
                { value: 'enabled', label: t('capabilities.ui.filterEnabled'), count: enabled.length },
                { value: 'disabled', label: t('capabilities.ui.filterDisabled'), count: disabledCount },
              ]}
            />
          }
        />
      ) : null}

      <Section
        title={t('capabilities.skills.title')}
        description={
          entries.length > 0
            ? t('capabilities.skills.summary', {
                enabled: enabled.length,
                total: entries.length,
                tokens,
              })
            : t('capabilities.skills.description')
        }
        action={
          <span className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-secondary tabular-nums">
            {filtered.length}
          </span>
        }
      >
        {error ? (
          <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p>
        ) : null}

        {filtered.length > 0 ? (
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {filtered.map((entry) => (
              <SkillCard
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : entries.length > 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {t('capabilities.ui.noMatches')}
          </p>
        ) : (
          <div className="px-4 py-5">
            <div className="rounded-xl border border-dashed border-line bg-surface-muted/30 px-4 py-4">
              <p className="text-sm font-medium text-ink-secondary">{t('capabilities.skills.empty')}</p>
              <ul className="mt-2.5 flex flex-wrap gap-1.5">
                {(catalog?.roots ?? []).map((root) => (
                  <li
                    key={root}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-3xs text-ink-tertiary"
                  >
                    <FolderOpen className="size-3 shrink-0 text-ink-quaternary" />
                    <code className="truncate font-mono">{root}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 max-w-[44rem] text-xs leading-relaxed text-ink-quaternary">
                {t('capabilities.skills.emptyHint')}
              </p>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function SkillCard({
  entry,
  busy,
  onToggle,
}: {
  entry: PiSkillView;
  busy: boolean;
  onToggle: (entry: PiSkillView, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const Icon = skillIcon(entry.name);

  return (
    <article
      className={cn(
        'flex flex-col justify-between rounded-xl border p-3.5 transition-colors',
        entry.enabled
          ? 'border-line bg-surface hover:border-line-strong'
          : 'border-line/75 bg-surface-muted/25 opacity-85 hover:border-line-strong hover:opacity-100',
      )}
    >
      <div>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-lg border',
              entry.enabled
                ? 'border-accent/20 bg-accent-soft text-accent-ink'
                : 'border-line bg-surface-muted text-ink-tertiary',
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-ink">{entry.name}</h4>
                <span className="mt-0.5 inline-flex rounded-full bg-surface-muted px-2 py-px text-3xs font-medium text-ink-tertiary">
                  {t(`capabilities.external.scope.${entry.scope}`)}
                </span>
              </div>
              <Toggle
                checked={entry.enabled}
                disabled={busy}
                onChange={(next) => onToggle(entry, next)}
                label={entry.name}
                title={busy ? t('capabilities.external.working') : undefined}
              />
            </div>
          </div>
        </div>

        {entry.description ? (
          <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-tertiary">
            {entry.description}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line/60 pt-2.5 text-3xs text-ink-quaternary">
        <div className="flex min-w-0 items-center gap-1.5">
          <Terminal className="size-3 shrink-0" />
          <code className="truncate font-mono" title={entry.file}>
            {entry.dir}
          </code>
        </div>
        <span className="shrink-0 tabular-nums">
          {entry.files} · {t('capabilities.skills.promptTokens', { tokens: entry.promptTokens })}
        </span>
      </div>
    </article>
  );
}

function skillIcon(name: string): LucideIcon {
  const normalized = name.toLowerCase();
  if (normalized.includes('code') || normalized.includes('dev')) return FileCode2;
  if (normalized.includes('json') || normalized.includes('schema')) return Braces;
  if (normalized.includes('design') || normalized.includes('creative')) return Gem;
  return BookOpen;
}
