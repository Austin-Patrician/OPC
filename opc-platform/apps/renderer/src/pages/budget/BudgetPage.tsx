import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, Coins, Gauge as Gauge2, PauseCircle, RefreshCw, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BudgetOverview, BudgetView, CostCentersOverview, PayrollOverview } from '@opc/shared/ipc';
import { Donut, Gauge, RankedBars } from '@/shared/ui/charts';
import { PageHeader, Section } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/** 展示顺序：钱最先被决策的维度排在最前（§8.1）。 */
/**
 * 薪酬视图：把同一个账本读成"这个月每个人花了多少钱"。
 *
 * 三列数字的来源各不相同，所以标签必须诚实：
 * - 已花 = 账本里真实结算过的金额（事实）；
 * - 折合月薪 = 用**已观测到的**单价把 token 上限折算成钱（推算，没花过就没有）；
 * - 预计月末 = 按当前速度直线外推到月底（预测）。
 */
function PayrollSection({ periodKey }: { periodKey: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<PayrollOverview | null>(null);

  useEffect(() => {
    let alive = true;
    void window.opc?.budget
      .payroll()
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [periodKey]);

  const lines = view?.lines ?? [];
  const money = (value: number) => `$${value.toFixed(2)}`;

  return (
    <Section
      title={`${t('budget.payrollTitle')} · ${view?.headcount ?? 0}`}
      description={t('budget.payrollHint')}
      action={<Coins className="size-4 text-ink-quaternary" />}
    >
      {lines.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-quaternary">{t('budget.payrollEmpty')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-4 py-2.5 text-sm">
            <span className="text-ink-tertiary">
              {t('budget.payrollTotal')}{' '}
              <span className="font-mono font-semibold text-ink">{money(view?.totalSpentUsd ?? 0)}</span>
            </span>
            <span className="text-ink-tertiary">
              {t('budget.payrollProjected')}{' '}
              <span className="font-mono text-ink-secondary">{money(view?.totalProjectedUsd ?? 0)}</span>
            </span>
          </div>
          <ul data-testid="payroll" className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.employeeId} data-testid="payroll-row" className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm-plus font-medium text-ink">
                    {line.name}
                    <span className="ml-1.5 text-xs text-ink-quaternary">
                      {line.title}
                      {line.departmentName ? ` · ${line.departmentName}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold text-ink">{money(line.spentUsd)}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {/* 占比条：长度表示"占公司总花费的比例"，所以满格 = 100%，不是"最高的人"。 */}
                    <div className="h-1 overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-500"
                        style={{ width: `${Math.min(100, Math.round(line.share * 100))}%` }}
                      />
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                    {Math.round(line.share * 100)}%
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-ink-quaternary">
                  <span className="font-mono">{line.tokensUsed.toLocaleString()} tok</span>
                  {line.budgetUsd !== undefined ? (
                    <span>{t('budget.payrollCap', { amount: money(line.budgetUsd) })}</span>
                  ) : (
                    <span>{t('budget.payrollUnpriced')}</span>
                  )}
                  <span className="ml-auto">{t('budget.payrollForecast', { amount: money(line.projectedUsd) })}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/**
 * 成本中心：本月每个部门、每个项目各花了多少钱。
 *
 * 与薪酬视图同源不同轴。两条轴只在"结算时知道它"的情况下才记账，所以合计数通常小于
 * 公司合计；差额作为**无法归属**显式列出来，而不是让两份报表对不上。
 */
function CostCentersSection({ periodKey }: { periodKey: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<CostCentersOverview | null>(null);
  const [axis, setAxis] = useState<'department' | 'project'>('department');

  useEffect(() => {
    let alive = true;
    void window.opc?.budget
      .costCenters()
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [periodKey]);

  const money = (value: number) => `$${value.toFixed(2)}`;
  const lines = axis === 'department' ? (view?.departments ?? []) : (view?.projects ?? []);
  const unattributed =
    axis === 'department' ? (view?.unattributedDepartmentUsd ?? 0) : (view?.unattributedProjectUsd ?? 0);

  return (
    <Section
      title={`${t('budget.costCentersTitle')} · ${lines.length}`}
      description={t('budget.costCentersHint')}
      action={<Building2 className="size-4 text-ink-quaternary" />}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        {(['department', 'project'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`cost-axis-${value}`}
            aria-pressed={axis === value}
            onClick={() => setAxis(value)}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs transition-colors',
              axis === value
                ? 'bg-surface-active font-medium text-ink'
                : 'text-ink-tertiary hover:text-ink',
            )}
          >
            {t(`budget.scope.${value}`)}
          </button>
        ))}
        <span className="flex-1" />
        <span className="text-xs-plus text-ink-quaternary">
          {t('budget.costCentersTotal', { amount: money(view?.totalSpentUsd ?? 0) })}
        </span>
      </div>

      {lines.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-quaternary">{t('budget.costCentersEmpty')}</p>
      ) : (
        <div className="px-4 py-3.5" data-testid="cost-centers">
          <RankedBars
            ariaLabel={t('budget.costCentersTitle')}
            emptyLabel={t('budget.costCentersEmpty')}
            formatValue={money}
            rows={lines.map((line) => ({
              key: line.id,
              label: line.name,
              value: line.spentUsd,
              caption: `${line.tokensUsed.toLocaleString()} tok · ${t('budget.costCentersPeople', {
                count: line.headcount,
              })} · ${Math.round(line.share * 100)}%`,
              color: line.share > 0.5 ? 'var(--warning)' : 'var(--accent)',
            }))}
          />
          <p className="mt-2 font-mono text-3xs text-ink-quaternary">
            {t('budget.costCentersScale', { amount: money(view?.totalSpentUsd ?? 0) })}
          </p>
        </div>
      )}

      {unattributed > 0 ? (
        <p
          data-testid="cost-unattributed"
          className="border-t border-line px-4 py-2 text-xs-plus text-ink-tertiary"
        >
          {t('budget.costCentersUnattributed', { amount: money(unattributed) })}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * 一个小图标 + 数字 + 说明：概览区里的三个计数。
 *
 * 图标承担"这是哪一类"，数字承担"多少"；两者不重复，所以图标永远不解释数字。
 */
function MiniStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof AlertTriangle;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-ink-quaternary" />
      <span className="min-w-0 flex-1 truncate text-2xs text-ink-tertiary">{label}</span>
      <span className={cn('shrink-0 font-mono text-sm font-semibold', tone)}>{value}</span>
    </div>
  );
}

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

  // Composition of the *caps*, not of the spend. `usedTokens` is charged to every axis
  // of one run, so its four totals overlap and a share of them would be meaningless;
  // `limitTokens` is set independently per axis, so this really is a partition.
  const scopeSlices = SCOPE_ORDER.map((scope) => {
    const inScope = rows.filter((row) => row.scope === scope);
    return {
      key: scope,
      label: t(`budget.scope.${scope}`),
      value: inScope.reduce((sum, row) => sum + row.limitTokens, 0),
      color:
        scope === 'company'
          ? 'var(--text-quaternary)'
          : scope === 'employee'
            ? 'var(--accent)'
            : scope === 'department'
              ? 'var(--warning)'
              : 'var(--success)',
    };
  });

  const totalUsed = rows.reduce((sum, row) => sum + row.usedTokens, 0);
  const totalLimit = rows.reduce((sum, row) => sum + row.limitTokens, 0);
  const compact = (value: number) =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : `${value}`;

  return (
    <div className="page-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
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
          {/* 概览：一眼看到"钱烧到哪一维"以及整体水位。 */}
          {rows.length > 0 ? (
            <Section
              title={t('budget.overviewTitle')}
              description={t('budget.overviewHint')}
              action={<Gauge2 className="size-4 text-ink-quaternary" />}
            >
              <div className="grid grid-cols-1 gap-5 px-4 py-4 sm:grid-cols-[auto_1fr]">
                <div className="flex items-center gap-5">
                  <Gauge
                    ratio={totalLimit > 0 ? totalUsed / totalLimit : 0}
                    label={t('budget.overviewTotal')}
                    value={`${totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0}%`}
                    caption={`${totalUsed.toLocaleString()} / ${totalLimit.toLocaleString()}`}
                    size={92}
                    testId="budget-gauge"
                  />
                  <div className="grid gap-2">
                    <MiniStat
                      icon={PauseCircle}
                      label={t('budget.overviewStopped')}
                      value={String(stopped.length)}
                      tone={stopped.length > 0 ? 'text-danger' : 'text-ink'}
                    />
                    <MiniStat
                      icon={AlertTriangle}
                      label={t('budget.overviewWarned')}
                      value={String(warned.length)}
                      tone={warned.length > 0 ? 'text-warning' : 'text-ink'}
                    />
                    <MiniStat
                      icon={Gauge2}
                      label={t('budget.overviewAxes')}
                      value={String(rows.length)}
                      tone="text-ink"
                    />
                  </div>
                </div>
                <div className="min-w-0 border-t border-line pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5">
                  <div className="mb-2 text-2xs font-semibold text-ink-tertiary">
                    {t('budget.overviewSplit')}
                  </div>
                  <Donut
                    slices={scopeSlices}
                    centreValue={compact(totalLimit)}
                    centreLabel={t('budget.overviewCapShort')}
                    emptyLabel={t('budget.overviewEmpty')}
                  />
                </div>
              </div>
            </Section>
          ) : null}

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
            action={<Gauge2 className="size-4 text-ink-quaternary" />}
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

                    <div className="mt-2 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-ink/8">
                          <div
                            className={cn(
                              'h-full rounded-full transition-[width] duration-500',
                              budget.state === 'stopped'
                                ? 'bg-danger'
                                : budget.state === 'warn'
                                  ? 'bg-warning'
                                  : 'bg-accent',
                            )}
                            style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                          />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-plus text-ink-quaternary">
                          <span className="font-mono">
                            {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                          </span>
                          <span>{t('budget.projected', { tokens: budget.projectedTokens.toLocaleString() })}</span>
                          {budget.willExceed ? (
                            <span className="text-warning">{t('budget.willExceed')}</span>
                          ) : null}
                          {budget.reservedTokens > 0 ? (
                            <span>{t('budget.reserved', { tokens: budget.reservedTokens.toLocaleString() })}</span>
                          ) : null}
                        </div>
                      </div>

                      {/* The gauge repeats the same ratio as an arc: a hairline bar is
                          precise but unreadable at a glance, an arc is the reverse. */}
                      <Gauge
                        ratio={ratio}
                        label={t(`budget.scope.${budget.scope}`)}
                        value={`${Math.round(ratio * 100)}%`}
                        size={44}
                        tone={
                          budget.state === 'stopped'
                            ? 'danger'
                            : budget.state === 'warn'
                              ? 'warning'
                              : 'accent'
                        }
                      />
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-plus text-ink-quaternary">
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

          <PayrollSection periodKey={overview?.periodKey ?? ''} />
          <CostCentersSection periodKey={overview?.periodKey ?? ''} />

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
