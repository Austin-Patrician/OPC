import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Section } from '../kit';

export function ConsolidationPage() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<
    Awaited<ReturnType<NonNullable<typeof window.opc>['memory']['consolidationRuns']>>
  >([]);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.memory.consolidationRuns()
      .then((rows) => {
        if (alive) setRuns(rows);
      })
      .catch(() => {
        if (alive) setRuns([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.behavior')]}
        title={t('settings.page.consolidation')}
        description={t('settings.runs.desc')}
      />
      <Section title={`${t('settings.runs.title')} · ${runs.length}`}>
        {runs.length === 0 ? (
          <p className="px-4 py-5 text-sm text-ink-quaternary">{t('settings.runs.empty')}</p>
        ) : (
          <ul data-testid="consolidation-runs">
            {runs.map((run) => (
              <li
                key={run.id}
                data-testid="consolidation-run-row"
                className="flex items-center gap-3 border-t border-line px-4 py-2 text-xs"
              >
                <span className="w-32 shrink-0 font-mono text-3xs text-ink-quaternary">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                <span className="w-16 shrink-0 font-mono text-3xs">
                  {run.status === 'done' ? (
                    <span className="text-success">done</span>
                  ) : run.status === 'skipped' ? (
                    <span className="text-ink-quaternary">skipped</span>
                  ) : run.status === 'failed' ? (
                    <span className="text-danger">failed</span>
                  ) : (
                    <span className="text-accent">running</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-secondary">
                  {run.status === 'done'
                    ? t('settings.runs.created', {
                        count: run.memoriesCreated,
                        episodes: run.episodeCount,
                      })
                    : (run.error ?? '—')}
                </span>
                <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                  {run.ownerId.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
