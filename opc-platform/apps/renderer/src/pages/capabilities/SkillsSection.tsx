import { BookOpen, FolderOpen, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PiSkillCatalog, PiSkillView } from '@opc/shared/ipc';
import { Section, Toggle } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/**
 * Local skills, in 技能与工具.
 *
 * No trust dialog here, unlike extensions: a skill is Markdown, so turning one on
 * can only cost prompt tokens. The row says so, and shows the estimate, because
 * "free" and "costs ~90 tokens on every request" are different promises.
 */
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
      action={<BookOpen className="size-4 text-ink-quaternary" />}
    >
      {error ? (
        <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p>
      ) : null}

      {entries.length > 0 ? (
        <>
          <p className="border-b border-line px-4 py-2 text-3xs text-ink-quaternary">
            {t('capabilities.skills.summary', { enabled: enabled.length, total: entries.length, tokens })}
          </p>
          <ul className="divide-y divide-line">
            {entries.map((entry) => (
              <SkillRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onToggle={onToggle}
              />
            ))}
          </ul>
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

function SkillRow({
  entry,
  busy,
  onToggle,
}: {
  entry: PiSkillView;
  busy: boolean;
  onToggle: (entry: PiSkillView, next: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border',
            entry.enabled
              ? 'border-accent/40 bg-accent-soft text-accent-ink'
              : 'border-line bg-surface-muted text-ink-tertiary',
          )}
        >
          <BookOpen className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm-plus font-semibold text-ink">{entry.name}</h4>
            <span className="rounded bg-surface-muted px-1.5 py-0.5 text-3xs font-medium text-ink-tertiary">
              {t(`capabilities.external.scope.${entry.scope}`)}
            </span>
            {entry.enabled ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-medium text-accent-ink">
                {t('capabilities.skills.promptTokens', { tokens: entry.promptTokens })}
              </span>
            ) : null}
            {entry.files > 0 ? (
              <span className="text-3xs text-ink-quaternary">
                {t('capabilities.skills.files', { count: entry.files })}
              </span>
            ) : null}
          </div>

          {entry.description ? (
            <p className="mt-1 line-clamp-2 text-xs-plus leading-relaxed text-ink-tertiary">
              {entry.description}
            </p>
          ) : null}

          <div className="mt-1 flex items-center gap-1.5 text-3xs text-ink-quaternary">
            <Terminal className="size-3 shrink-0" />
            <code className="truncate font-mono" title={entry.file}>
              {entry.dir}
            </code>
          </div>
        </div>

        <Toggle
          checked={entry.enabled}
          disabled={busy}
          onChange={(next) => onToggle(entry, next)}
          label={entry.name}
          title={busy ? t('capabilities.external.working') : undefined}
        />
      </div>
    </li>
  );
}
