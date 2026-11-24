import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MemoryReflectionRunView } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Section } from '../kit';

export function ConsolidationPage() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<MemoryReflectionRunView[]>([]);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    void window.opc?.memory
      .status()
      .then((state) => setRuns(state.recentRuns ?? []))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reflectNow = async () => {
    if (!window.opc || running) return;
    setRunning(true);
    try {
      await window.opc.memory.reflectNow();
      load();
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.behavior')]}
        title={t('settings.page.consolidation')}
        description={t('settings.runs.desc')}
        actions={
          <button
            type="button"
            disabled={running}
            onClick={() => void reflectNow()}
            className={buttonClass.primary}
          >
            <Sparkles className="size-3.5" />
            {running ? t('settings.memory.reflecting') : t('settings.memory.reflectNow')}
          </button>
        }
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
                className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-xs"
              >
                <span className="w-36 shrink-0 font-mono text-3xs text-ink-quaternary">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                <span className="w-20 shrink-0 font-mono text-3xs text-ink-tertiary">
                  {run.trigger}
                </span>
                <span className="w-16 shrink-0 font-mono text-3xs">
                  {run.status === 'done' ? (
                    <span className="text-success">done</span>
                  ) : run.status === 'skipped' ? (
                    <span className="text-ink-quaternary">skipped</span>
                  ) : (
                    <span className="text-danger">failed</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-secondary">
                  {run.error ? `${run.summary} (${run.error})` : run.summary}
                </span>
                <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                  {run.changedFiles.length > 0 ? run.changedFiles.join(', ') : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
