import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Gauge, PauseCircle, RefreshCw, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BudgetOverview, BudgetView } from '@opc/shared/ipc';
import { PageHeader, Section } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/** 展示顺序：钱最先被决策的维度排在最前（§8.1）。 */
const SCOPE_ORDER = ['project', 'department', 'employee', 'company'] as const;

/**
 * 预算中心 (§8)。
 *
 * 每一行都是 `budget` 里的一行；"预计月末"是唯一算出来的数字，并明确标成预测。
 * 硬停在这里可以被解除 —— 改额度会同时恢复被暂停的任职（F8 的反向操作）。
 */
export function BudgetPage() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<BudgetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 正在编辑额度的行（`scope:scopeId`），以及草稿值。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    if (!window.opc?.budget) return;
    try {
      setOverview(await window.opc.budget.overview());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (budget: BudgetView) => {
    const value = Number(draft.replace(/[^\d]/g, ''));
    setEditing(null);
    if (!Number.isFinite(value) || value <= 0) return;
    try {
      setOverview(
        await window.opc!.budget.setLimit({
          scope: budget.scope,
          scopeId: budget.scopeId,
          limitTokens: value,
        }),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const rows = (overview?.budgets ?? []).slice().sort((a, b) => {
    const byScope = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope);
    if (byScope !== 0) return byScope;
    return b.usedTokens - a.usedTokens;
  });

  const stopped = rows.filter((row) => row.state === 'stopped');
  const warned = rows.filter((row) => row.state === 'warn');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
      <div className="mx-auto w-full max-w-[62rem] px-6 py-6">
        <PageHeader
          crumbs={[t('nav.budget')]}
          title={t('budget.centerTitle')}
          description={t('budget.centerSubtitle', { period: overview?.periodKey ?? '—' })}
          actions={
            <button
              type="button"
              onClick={() => void load()}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('budget.refresh')}
            </button>
          }
        />

        {error ? (
          <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        {stopped.length > 0 || warned.length > 0 ? (
          <p className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              {stopped.length > 0
                ? t('budget.bannerStopped', { count: stopped.length })
                : t('budget.bannerWarn', { count: warned.length })}
            </span>
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          {overview && overview.paused.length > 0 ? (
            <Section
              title={`${t('budget.pausedTitle')} · ${overview.paused.length}`}
              description={t('budget.pausedHint')}
              action={<PauseCircle className="size-4 text-warning" />}
            >
              <ul className="divide-y divide-line">
                {overview.paused.map((entry) => (
                  <li
                    key={`${entry.projectId}:${entry.employeeId}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm-plus text-ink">
                      {entry.employeeName}
                      <span className="mx-1.5 text-ink-quaternary">·</span>
                      <span className="text-ink-tertiary">{entry.projectName}</span>
                    </span>
                    <span className="shrink-0 rounded bg-warning/12 px-1.5 py-0.5 text-2xs font-medium text-warning">
                      {t(`budget.reason.${entry.reason || 'unknown'}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section
            title={t('budget.tableTitle')}
            description={t('budget.tableHint')}
            action={<Gauge className="size-4 text-ink-quaternary" />}
          >
            <ul className="divide-y divide-line">
              {rows.map((budget) => {
                const key = `${budget.scope}:${budget.scopeId}`;
                const ratio = budget.limitTokens > 0 ? budget.usedTokens / budget.limitTokens : 1;
                return (
                  <li key={key} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-ink/5 px-1.5 py-0.5 text-2xs font-medium text-ink-tertiary">
                        {t(`budget.scope.${budget.scope}`)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm-plus font-medium text-ink">
                        {budget.label}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium',
                          budget.state === 'stopped'
                            ? 'bg-danger/12 text-danger'
                            : budget.state === 'warn'
                              ? 'bg-warning/12 text-warning'
                              : 'bg-success/12 text-success',
                        )}
                      >
                        {t(`budget.state.${budget.state}`)}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/8">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            budget.state === 'stopped'
                              ? 'bg-danger'
                              : budget.state === 'warn'
                                ? 'bg-warning'
                                : 'bg-accent',
                          )}
                          style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-xs-plus text-ink-tertiary">
                        {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                      </span>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-plus text-ink-quaternary">
                      <span>{t('budget.projected', { tokens: budget.projectedTokens.toLocaleString() })}</span>
                      {budget.willExceed ? (
                        <span className="text-warning">{t('budget.willExceed')}</span>
                      ) : null}
                      {budget.reservedTokens > 0 ? (
                        <span>{t('budget.reserved', { tokens: budget.reservedTokens.toLocaleString() })}</span>
                      ) : null}

                      {editing === key ? (
                        <span className="ml-auto flex items-center gap-1">
                          <input
                            autoFocus
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void save(budget);
                              if (event.key === 'Escape') setEditing(null);
                            }}
                            className="w-28 rounded border border-line bg-surface px-1.5 py-0.5 text-xs-plus text-ink outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            onClick={() => void save(budget)}
                            className="rounded px-1.5 py-0.5 text-2xs font-medium text-accent hover:bg-accent-soft"
                          >
                            {t('budget.save')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(key);
                            setDraft(String(budget.limitTokens));
                          }}
                          className="ml-auto rounded px-1.5 py-0.5 text-2xs font-medium text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
                        >
                          {t('budget.editLimit')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section
            title={`${t('budget.alertsTitle')} · ${overview?.alerts.length ?? 0}`}
            description={t('budget.alertsHint')}
            action={<Wallet className="size-4 text-ink-quaternary" />}
          >
            {overview && overview.alerts.length > 0 ? (
              <ul className="divide-y divide-line">
                {overview.alerts.map((alert) => (
                  <li key={alert.id} className="flex items-center gap-3 px-4 py-2.5 text-sm-plus">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium',
                        alert.level === 'stop'
                          ? 'bg-danger/12 text-danger'
                          : 'bg-warning/12 text-warning',
                      )}
                    >
                      {t(`budget.level.${alert.level}`)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {alert.label}
                      <span className="ml-1.5 text-xs-plus text-ink-quaternary">
                        {t('budget.alertDetail', {
                          percent: Math.round(alert.ratio * 100),
                          limit: alert.limitTokens.toLocaleString(),
                        })}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs-plus text-ink-quaternary">
                      {new Date(alert.createdAt).toLocaleString(undefined, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-sm text-ink-quaternary">
                {t('budget.alertsEmpty')}
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
