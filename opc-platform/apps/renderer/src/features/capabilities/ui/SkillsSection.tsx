import { BookOpen, Braces, FileCode2, FolderOpen, Gem, Sparkles, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PiSkillCatalog, PiSkillView } from '@opc/shared/ipc';
import { Section, Toggle } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

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
  const entries = catalog?.entries ?? [];
  const enabled = entries.filter((entry) => entry.enabled);
  const tokens = enabled.reduce((sum, entry) => sum + entry.promptTokens, 0);

  return (
    <Section
      title={t('capabilities.skills.title')}
      description={t('capabilities.skills.description')}
      action={
        <div className="flex items-center gap-2 text-xs text-ink-tertiary">
          <span className="rounded-full bg-accent-soft px-2 py-1 font-semibold text-accent-ink">
            {enabled.length}/{entries.length}
          </span>
          <Sparkles className="size-4 text-accent" />
        </div>
      }
      className="capabilities-section"
    >
      {error ? <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p> : null}

      {entries.length > 0 ? (
        <>
          <div className="border-b border-line/70 px-4 py-3 text-xs text-ink-tertiary">
            {t('capabilities.skills.summary', { enabled: enabled.length, total: entries.length, tokens })}
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {entries.map((entry) => (
              <SkillCard
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onToggle={onToggle}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="px-4 py-6">
          <p className="text-sm text-ink-tertiary">{t('capabilities.skills.empty')}</p>
          <ul className="mt-2 space-y-1">
            {(catalog?.roots ?? []).map((root) => (
              <li key={root} className="flex items-center gap-1.5 text-3xs text-ink-quaternary">
                <FolderOpen className="size-3 shrink-0" />
                <code className="truncate font-mono">{root}</code>
              </li>
            ))}
          </ul>
          <p className="mt-2 max-w-[42rem] text-xs leading-relaxed text-ink-quaternary">
            {t('capabilities.skills.emptyHint')}
          </p>
        </div>
      )}
    </Section>
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
    <article className="capability-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className={cn('capability-icon grid size-10 shrink-0 place-items-center rounded-xl', !entry.enabled && 'opacity-55')}>
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="truncate text-sm-plus font-semibold text-ink">{entry.name}</h4>
              <span className="mt-1 inline-flex rounded-full bg-surface-muted px-2 py-0.5 text-3xs font-medium text-ink-tertiary">
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

          {entry.description ? (
            <p className="mt-3 line-clamp-2 text-xs-plus leading-relaxed text-ink-tertiary">{entry.description}</p>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-2 text-3xs text-ink-quaternary">
            <div className="flex min-w-0 items-center gap-1.5">
              <Terminal className="size-3 shrink-0" />
              <code className="truncate font-mono" title={entry.file}>{entry.dir}</code>
            </div>
            <span className="shrink-0">
              {entry.files} · {t('capabilities.skills.promptTokens', { tokens: entry.promptTokens })}
            </span>
          </div>
        </div>
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
