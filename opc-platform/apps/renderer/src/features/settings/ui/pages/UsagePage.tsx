import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  init,
  getInstanceByDom,
  use as registerModules,
  type EChartsCoreOption,
} from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Coins,
  Cpu,
  Download,
  Image as ImageIcon,
  Mic,
  RefreshCw,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UsageCallView, UsageFilter, UsageReport } from '@opc/shared/ipc';
import { useMoney } from '@/entities/billing/model/useBilling';
import { useModels } from '@/features/models/model/useModels';
import { appTimeZone, formatAppDate, formatAppTime } from '@/shared/lib/appTime';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Section } from '../kit';
import {
  buildActorDonutOption,
  buildActorOption,
  buildConsumptionOption,
  buildLifecycleOption,
  formatCompactNumber,
  getChartTheme,
  mergeWorkersByName,
  type ActorBreakdownItem,
  type ConsumptionMetric,
  type ConsumptionStyle,
} from './usageCharts';

type Preset = 'today' | 'last7' | 'last30' | 'month' | 'all' | 'custom';
type BreakdownView = 'distribution' | 'ranking';
type ActorTab = 'consumption' | 'lifecycle';

const DAY = 86_400_000;

registerModules([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

function localDateInput(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateStart(value: string, zone: string): number {
  const [year, month, day] = value.split('-').map(Number);
  const guess = Date.UTC(year!, month! - 1, day!, 12);
  const rendered = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(guess);
  const p = Object.fromEntries(rendered.map((part) => [part.type, Number(part.value)]));
  const zoneDelta =
    Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - guess;
  return Date.UTC(year!, month! - 1, day!) - zoneDelta;
}

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.theme === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

function Chart({
  option,
  className = 'h-64 w-full',
}: {
  option: EChartsCoreOption;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(option);
  latest.current = option;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = init(el, undefined, { renderer: 'canvas' });
    chart.setOption(latest.current);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = getInstanceByDom(el);
    chart?.setOption(option, true);
  }, [option]);

  return <div ref={host} className={className} />;
}

function MiniSparkline({
  values,
  color = 'var(--accent)',
}: {
  values: readonly number[];
  color?: string;
}) {
  const gradId = useId().replace(/:/g, '');
  const points = values.length > 0 ? values : [0, 0];
  const max = Math.max(...points, 1e-9);
  const min = Math.min(...points, 0);
  const span = Math.max(max - min, 1e-9);
  const W = 88;
  const H = 26;
  const coords = points.map((v, idx) => {
    const x = points.length === 1 ? W : (idx / (points.length - 1)) * W;
    const y = H - 3 - ((v - min) / span) * (H - 6);
    return [x, y] as const;
  });
  const line = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-[26px] w-[84px] shrink-0 overflow-visible"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MiniBarsSpark({ values }: { values: readonly number[] }) {
  const slice = (values.length > 14 ? values.slice(-14) : values).map((v) => Math.max(0, v));
  const bars = slice.length > 0 ? slice : [0, 0, 0, 0];
  const max = Math.max(...bars, 1);

  return (
    <div className="flex h-[26px] w-[84px] shrink-0 items-end justify-end gap-[2px]" aria-hidden>
      {bars.map((val, idx) => {
        const pct = val <= 0 ? 10 : Math.max(18, Math.round((val / max) * 100));
        return (
          <span
            key={idx}
            className={cn('w-[4px] rounded-t-[2px]', val > 0 ? 'bg-accent/75' : 'bg-line')}
            style={{ height: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex rounded-lg border border-line bg-surface-muted/70 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-7 items-center rounded-[6px] px-2.5 text-xs whitespace-nowrap transition-colors',
              active
                ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-ink-tertiary hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const { providers } = useModels();
  const isDark = useIsDarkTheme();
  const theme = useMemo(() => getChartTheme(isDark), [isDark]);
  const zone = appTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [preset, setPreset] = useState<Preset>('last30');
  const [startDate, setStartDate] = useState(() => localDateInput(Date.now() - 29 * DAY, zone));
  const [endDate, setEndDate] = useState(() => localDateInput(Date.now(), zone));
  const [advanced, setAdvanced] = useState(false);
  const [consumptionMetric, setConsumptionMetric] = useState<ConsumptionMetric>('cost');
  const [consumptionStyle, setConsumptionStyle] = useState<ConsumptionStyle>('area');
  const [actorMetric, setActorMetric] = useState<'cost' | 'tokens'>('tokens');
  const [breakdownView, setBreakdownView] = useState<BreakdownView>('distribution');
  const [actorTab, setActorTab] = useState<ActorTab>('consumption');
  const [filter, setFilter] = useState<UsageFilter>(() => ({
    startAt: Date.now() - 30 * DAY,
    endAt: Date.now() + 1,
    timezone: zone,
    page: 1,
    pageSize: 30,
    metric: 'cost',
  }));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const userPickedMetricRef = useRef(false);
  const userPickedActorMetricRef = useRef(false);
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';

  const load = useCallback(
    async (next = filter) => {
      setLoading(true);
      setError(null);
      if (!window.opc?.usage) {
        setError(t('settings.usage.bridgeUnavailable'));
        setLoading(false);
        return;
      }
      try {
        const nextReport = await window.opc.usage.report(next);
        setReport(nextReport);

        // Automatically choose the richest non-zero metric so unpriced accounts don't plot flat zeros.
        if (!userPickedMetricRef.current) {
          if (nextReport.summary.chargedCostUsd > 0) {
            setConsumptionMetric('cost');
          } else if (nextReport.summary.totalTokens > 0) {
            setConsumptionMetric('tokens');
          } else if (nextReport.summary.requests > 0) {
            setConsumptionMetric('requests');
          }
        }
        if (!userPickedActorMetricRef.current) {
          setActorMetric(nextReport.summary.chargedCostUsd > 0 ? 'cost' : 'tokens');
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [filter, t],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(filter), 30_000);
    const unsubscribe = window.opc?.usage.onChanged(() => void load(filter));
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [filter, load]);

  const selectConsumptionMetric = (next: ConsumptionMetric) => {
    userPickedMetricRef.current = true;
    setConsumptionMetric(next);
    if (!userPickedActorMetricRef.current && (next === 'cost' || next === 'tokens')) {
      setActorMetric(next);
    }
  };

  const selectActorMetric = (next: 'cost' | 'tokens') => {
    userPickedActorMetricRef.current = true;
    setActorMetric(next);
  };

  const setMulti = (key: 'providers' | 'statuses', value: string, checked: boolean) => {
    setFilter((current) => {
      const entries = new Set(current[key] ?? []);
      if (checked) entries.add(value);
      else entries.delete(value);
      return { ...current, [key]: entries.size ? ([...entries] as never) : undefined, page: 1 };
    });
  };

  const statusOptions = useMemo(
    () =>
      [
        ['ok', t('settings.usage.ok')],
        ['error', t('settings.usage.error')],
        ['aborted', t('settings.usage.aborted')],
        ['interrupted', t('settings.usage.interrupted')],
        ['unknown', t('settings.usage.unknown')],
      ] as [string, string][],
    [t],
  );

  const applyPreset = (next: Preset) => {
    setPreset(next);
    if (next === 'custom') return;
    const now = Date.now();
    const today = localDateInput(now, zone);
    let from: number;
    let to = dateStart(today, zone) + DAY;
    if (next === 'today') from = dateStart(today, zone);
    else if (next === 'month') {
      const parts = today.split('-');
      from = dateStart(`${parts[0]}-${parts[1]}-01`, zone);
    } else if (next === 'all') {
      from = 0;
      to = now + 1;
    } else from = dateStart(localDateInput(now - (next === 'last7' ? 6 : 29) * DAY, zone), zone);
    setStartDate(localDateInput(from, zone));
    setEndDate(localDateInput(to - 1, zone));
    setFilter((current) => ({ ...current, startAt: from, endAt: to, timezone: zone, page: 1 }));
  };

  const applyDates = () =>
    setFilter((current) => ({
      ...current,
      startAt: dateStart(startDate, zone),
      endAt: dateStart(endDate, zone) + DAY,
      timezone: zone,
      page: 1,
    }));

  const applyAdvanced = () => {
    setFilter((current) => ({ ...current, query: query.trim() || undefined, page: 1 }));
  };

  const exportCsv = async () => {
    try {
      await window.opc?.usage.exportCsv(filter);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const activeFilterCount =
    (filter.providers?.length ?? 0) +
    (filter.statuses?.length ?? 0) +
    (filter.query ? 1 : 0);

  const summary = report?.summary;
  const series = useMemo(() => report?.series ?? [], [report]);
  const hasTrendData = series.some((p) => p.costUsd > 0 || p.tokens > 0 || p.requests > 0);
  const avgCostPerCall =
    summary && summary.requests > 0 ? summary.chargedCostUsd / summary.requests : 0;
  const avgTokensPerCall =
    summary && summary.requests > 0 ? Math.round(summary.totalTokens / summary.requests) : 0;
  const peakRequests = series.reduce((max, p) => Math.max(max, p.requests), 0);
  const successRatePct =
    summary?.successRate == null ? null : Math.min(100, Math.max(0, summary.successRate * 100));

  const actorItems = useMemo<ActorBreakdownItem[]>(() => {
    if (!report) return [];
    const routerTotals = (report.actors.router ?? []).reduce(
      (acc, row) => ({
        costUsd: acc.costUsd + row.costUsd,
        tokens: acc.tokens + row.tokens,
      }),
      { costUsd: 0, tokens: 0 },
    );
    const workers = mergeWorkersByName(
      report.actors.workers,
      t('settings.usage.otherWorkers'),
    );
    const workersTotals = workers.reduce(
      (acc, worker) => ({
        costUsd: acc.costUsd + worker.costUsd,
        tokens: acc.tokens + worker.tokens,
      }),
      { costUsd: 0, tokens: 0 },
    );
    const otherTokens = Math.max(
      0,
      report.summary.totalTokens - routerTotals.tokens - workersTotals.tokens,
    );
    const otherCost = Math.max(
      0,
      report.summary.chargedCostUsd - routerTotals.costUsd - workersTotals.costUsd,
    );

    const list: ActorBreakdownItem[] = [];
    if (routerTotals.tokens > 0 || routerTotals.costUsd > 0) {
      list.push({
        key: '__router__',
        name: t('settings.usage.router'),
        costUsd: routerTotals.costUsd,
        tokens: routerTotals.tokens,
      });
    }
    for (const worker of workers) {
      if (worker.tokens > 0 || worker.costUsd > 0 || worker.requests > 0) {
        list.push({
          key: worker.key,
          name: worker.name,
          costUsd: worker.costUsd,
          tokens: worker.tokens,
          requests: worker.requests,
        });
      }
    }
    if (otherTokens > 0 || otherCost > 1e-9) {
      list.push({
        key: '__other__',
        name: t('settings.usage.otherOrigin'),
        costUsd: otherCost,
        tokens: otherTokens,
      });
    }

    return list.sort((a, b) => {
      const av = actorMetric === 'cost' ? a.costUsd : a.tokens;
      const bv = actorMetric === 'cost' ? b.costUsd : b.tokens;
      return bv - av || b.tokens - a.tokens;
    });
  }, [actorMetric, report, t]);

  const modelNameLookup = useMemo(() => {
    const exact = new Map<string, string>();
    const byId = new Map<string, string>();
    for (const provider of providers) {
      for (const model of provider.models) {
        const displayName = model.name?.trim();
        if (!displayName) continue;
        exact.set(`${provider.id}::${model.id}`, displayName);
        if (!byId.has(model.id)) byId.set(model.id, displayName);
      }
    }
    return { exact, byId };
  }, [providers]);

  const resolveModelName = useCallback(
    (providerId: string, modelId: string): string => {
      const matched =
        modelNameLookup.exact.get(`${providerId}::${modelId}`) ??
        modelNameLookup.byId.get(modelId);
      if (matched) return matched;
      const slash = modelId.lastIndexOf('/');
      return slash >= 0 ? modelId.slice(slash + 1) : modelId;
    },
    [modelNameLookup],
  );

  const activeActorItems = useMemo(
    () =>
      actorItems.filter((item) => (actorMetric === 'cost' ? item.costUsd > 0 : item.tokens > 0)),
    [actorItems, actorMetric],
  );

  const actorTotalValue = useMemo(
    () =>
      activeActorItems.reduce(
        (sum, item) => sum + (actorMetric === 'cost' ? item.costUsd : item.tokens),
        0,
      ),
    [activeActorItems, actorMetric],
  );

  const consumptionOption = useMemo(
    () =>
      buildConsumptionOption(report, consumptionMetric, consumptionStyle, theme, money, {
        cost: t('settings.usage.trendCost'),
        tokens: t('settings.usage.trendTokens'),
        requests: t('settings.usage.trendRequests'),
        unpriced: t('settings.usage.unpriced'),
      }),
    [consumptionMetric, consumptionStyle, money, report, t, theme],
  );

  const actorDonutOption = useMemo(
    () =>
      buildActorDonutOption(activeActorItems, actorMetric, theme, money, {
        tokens: t('settings.usage.tokens'),
        cost: t('settings.usage.charged'),
      }),
    [activeActorItems, actorMetric, money, t, theme],
  );

  const sourceCostOption = useMemo(
    () =>
      buildActorOption(report, actorMetric, theme, money, {
        router: t('settings.usage.router'),
        otherWorkers: t('settings.usage.otherWorkers'),
        otherOrigin: t('settings.usage.otherOrigin'),
      }),
    [actorMetric, money, report, t, theme],
  );

  const workerLifecycleOption = useMemo(
    () =>
      buildLifecycleOption(report, theme, {
        active: t('settings.usage.activeWorkers'),
        created: t('settings.usage.createdWorkers'),
        retired: t('settings.usage.retiredWorkers'),
      }),
    [report, t, theme],
  );

  const canSwitchCostToTokens =
    actorMetric === 'cost' && (summary?.chargedCostUsd ?? 0) <= 0 && (summary?.totalTokens ?? 0) > 0;
  const pages = Math.max(1, Math.ceil((report?.totalCalls ?? 0) / (report?.pageSize ?? 30)));

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.usage')]}
        title={t('settings.page.usage')}
        description={t('settings.usage.desc')}
        actions={
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => void load(filter)}
              disabled={loading}
              title={t('settings.usage.refresh')}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('settings.usage.refresh')}
            </button>
            <button type="button" className={buttonClass.primary} onClick={() => void exportCsv()}>
              <Download className="size-3.5" />
              {t('settings.usage.export')}
            </button>
          </>
        }
      />

      <div className="space-y-5">
        {/* Top Command Bar */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <SegmentedTabs<Preset>
              label={t('settings.page.usage')}
              value={preset}
              onChange={applyPreset}
              options={(['today', 'last7', 'last30', 'month', 'all', 'custom'] as Preset[]).map(
                (item) => ({
                  value: item,
                  label: t(`settings.usage.${item}`),
                }),
              )}
            />

            <div className="flex items-center gap-2">
              <span className="hidden rounded-md bg-surface-muted/80 px-2 py-1 text-3xs text-ink-tertiary sm:inline-flex">
                {t('settings.usage.timeZone', { zone })}
              </span>
              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                aria-expanded={advanced}
                className={cn(
                  buttonClass.secondary,
                  'h-8 gap-1.5 text-xs',
                  (advanced || activeFilterCount > 0) && 'border-accent/40 text-accent-ink',
                )}
              >
                <SlidersHorizontal className="size-3.5" />
                <span>{t('settings.usage.advanced')}</span>
                {activeFilterCount > 0 ? (
                  <span className="inline-flex size-4 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-white tabular-nums">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
            </div>
          </div>

          {preset === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-muted/40 px-3.5 py-2.5">
              <label className="flex items-center gap-2 text-xs text-ink-tertiary">
                <span>{t('settings.usage.start')}</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => {
                    setStartDate(event.target.value);
                    setPreset('custom');
                  }}
                  className="h-7 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
                />
              </label>
              <span className="text-ink-quaternary">–</span>
              <label className="flex items-center gap-2 text-xs text-ink-tertiary">
                <span>{t('settings.usage.end')}</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    setPreset('custom');
                  }}
                  className="h-7 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
                />
              </label>
              <button type="button" className={buttonClass.primary} onClick={applyDates}>
                {t('settings.usage.apply')}
              </button>
            </div>
          ) : null}

          {advanced ? (
            <Section title={t('settings.usage.filters')}>
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
                {(
                  [
                    [
                      t('settings.usage.providers'),
                      'providers',
                      (report?.options.providers ?? []).map((x) => [x, x]),
                    ],
                    [t('settings.usage.statuses'), 'statuses', statusOptions],
                  ] as [string, 'providers' | 'statuses', [string, string][]][]
                ).map(([label, key, options]) => (
                  <fieldset key={key} className="min-w-0">
                    <legend className="mb-1.5 text-3xs font-medium tracking-wide text-ink-tertiary uppercase">
                      {label}
                    </legend>
                    <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-muted/25 px-2.5 py-2">
                      {options.length ? (
                        options.map(([value, title]) => (
                          <label
                            key={value}
                            className="flex cursor-pointer items-center gap-2 truncate text-xs text-ink-secondary hover:text-ink"
                          >
                            <input
                              type="checkbox"
                              checked={filter[key]?.includes(value as never) ?? false}
                              onChange={(event) => setMulti(key, value, event.target.checked)}
                              className="accent-accent"
                            />
                            <span className="truncate" title={title}>
                              {title}
                            </span>
                          </label>
                        ))
                      ) : (
                        <span className="text-xs text-ink-quaternary">—</span>
                      )}
                    </div>
                  </fieldset>
                ))}

                <label className="min-w-0 text-3xs font-medium tracking-wide text-ink-tertiary uppercase">
                  {t('settings.usage.query')}
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('settings.usage.queryPlaceholder')}
                    className="mt-1.5 h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-xs font-normal text-ink normal-case outline-none focus:border-accent"
                  />
                </label>

                <div className="col-span-full flex justify-end gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => {
                      setQuery('');
                      setFilter((current) => ({
                        ...current,
                        providers: undefined,
                        statuses: undefined,
                        query: undefined,
                        page: 1,
                      }));
                    }}
                  >
                    {t('settings.usage.reset')}
                  </button>
                  <button type="button" className={buttonClass.primary} onClick={applyAdvanced}>
                    {t('settings.usage.apply')}
                  </button>
                </div>
              </div>
            </Section>
          ) : null}

          {report && !report.coverage.backfillComplete ? (
            <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2 text-xs text-warning">
              <AlertCircle className="size-3.5 shrink-0" />
              <span>{t('settings.usage.coveragePending')}</span>
            </div>
          ) : null}
        </div>

        {/* Hero 4 KPI Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative flex flex-col justify-between overflow-hidden rounded-xl border border-line bg-gradient-to-br from-accent/[0.06] via-surface to-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('settings.usage.charged')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-accent/20 bg-accent-soft text-accent-ink">
                <Coins className="size-3.5" />
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[1.45rem] leading-none font-bold tracking-tight text-ink tabular-nums">
                  {money(summary?.chargedCostUsd ?? 0)}
                </div>
                <div className="mt-1.5 truncate text-3xs text-ink-quaternary tabular-nums">
                  {t('settings.usage.avgPerCall', {
                    value: money(avgCostPerCall, { digits: 4 }),
                  })}
                </div>
              </div>
              <MiniSparkline values={series.map((p) => p.costUsd)} />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('settings.usage.tokens')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-line bg-surface-muted text-ink-secondary">
                <Cpu className="size-3.5" />
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <div
                  className="truncate text-[1.45rem] leading-none font-bold tracking-tight text-ink tabular-nums"
                  title={(summary?.totalTokens ?? 0).toLocaleString()}
                >
                  {formatCompactNumber(summary?.totalTokens ?? 0)}
                </div>
                <div className="mt-1.5 truncate text-3xs text-ink-quaternary tabular-nums">
                  {t('settings.usage.avgTokensPerCall', {
                    value: formatCompactNumber(avgTokensPerCall),
                  })}
                </div>
              </div>
              <MiniSparkline values={series.map((p) => p.tokens)} color="#3b82f6" />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('settings.usage.requests')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-line bg-surface-muted text-ink-secondary">
                <Activity className="size-3.5" />
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[1.45rem] leading-none font-bold tracking-tight text-ink tabular-nums">
                  {(summary?.requests ?? 0).toLocaleString()}
                </div>
                <div className="mt-1.5 truncate text-3xs text-ink-quaternary tabular-nums">
                  {t('settings.usage.peakBucket', { value: peakRequests.toLocaleString() })}
                </div>
              </div>
              <MiniBarsSpark values={series.map((p) => p.requests)} />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('settings.usage.successRate')}
              </span>
              <span
                className={cn(
                  'grid size-7 place-items-center rounded-lg border',
                  successRatePct === null
                    ? 'border-line bg-surface-muted text-ink-tertiary'
                    : successRatePct >= 95
                      ? 'border-success/25 bg-success/10 text-success'
                      : successRatePct >= 85
                        ? 'border-warning/25 bg-warning/10 text-warning'
                        : 'border-danger/25 bg-danger/10 text-danger',
                )}
              >
                <CheckCircle2 className="size-3.5" />
              </span>
            </div>
            <div className="mt-3">
              <div className="text-[1.45rem] leading-none font-bold tracking-tight text-ink tabular-nums">
                {successRatePct === null ? '—' : `${successRatePct.toFixed(1)}%`}
              </div>
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    successRatePct === null
                      ? 'bg-ink-quaternary/30'
                      : successRatePct >= 95
                        ? 'bg-success'
                        : successRatePct >= 85
                          ? 'bg-warning'
                          : 'bg-danger',
                  )}
                  style={{ width: `${successRatePct ?? 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Compact Secondary Multimodal & Unpriced Telemetry Strip */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-line bg-surface-muted/35 px-4 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="inline-flex items-center gap-1.5 text-ink-tertiary">
              <ImageIcon className="size-3.5 text-ink-quaternary" />
              <span>{t('settings.usage.images')}:</span>
              <strong
                className={cn(
                  'font-semibold tabular-nums',
                  (summary?.images ?? 0) > 0 ? 'text-ink' : 'text-ink-quaternary',
                )}
              >
                {summary?.images ?? 0}
              </strong>
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-tertiary">
              <Mic className="size-3.5 text-ink-quaternary" />
              <span>{t('settings.usage.asr')}:</span>
              <strong
                className={cn(
                  'font-semibold tabular-nums',
                  (summary?.asrSeconds ?? 0) > 0 ? 'text-ink' : 'text-ink-quaternary',
                )}
              >
                {(summary?.asrSeconds ?? 0).toFixed(1)} s
              </strong>
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-tertiary">
              <Volume2 className="size-3.5 text-ink-quaternary" />
              <span>{t('settings.usage.tts')}:</span>
              <strong
                className={cn(
                  'font-semibold tabular-nums',
                  (summary?.ttsCharacters ?? 0) > 0 ? 'text-ink' : 'text-ink-quaternary',
                )}
              >
                {(summary?.ttsCharacters ?? 0).toLocaleString()}
              </strong>
            </span>
            <span className="inline-flex items-center gap-1.5 text-ink-tertiary">
              <AlertCircle
                className={cn(
                  'size-3.5',
                  (summary?.unpricedCalls ?? 0) > 0 ? 'text-warning' : 'text-ink-quaternary',
                )}
              />
              <span>{t('settings.usage.unpriced')}:</span>
              <strong
                className={cn(
                  'font-semibold tabular-nums',
                  (summary?.unpricedCalls ?? 0) > 0 ? 'text-warning' : 'text-ink-quaternary',
                )}
              >
                {summary?.unpricedCalls ?? 0}
              </strong>
            </span>
          </div>
          {report?.coverage.backfillComplete && report.coverage.backfillFrom ? (
            <span className="text-3xs text-ink-quaternary">
              {t('settings.usage.coverageComplete')} ·{' '}
              {formatAppDate(report.coverage.backfillFrom, locale)}
            </span>
          ) : null}
        </div>

        {/* Hero Trend Chart */}
        <Section
          title={t('settings.usage.consumptionDistribution')}
          action={
            <div className="flex flex-wrap items-center justify-end gap-1.5 sm:flex-nowrap">
              <SegmentedTabs<ConsumptionMetric>
                label={t('settings.usage.trendMetric')}
                value={consumptionMetric}
                onChange={selectConsumptionMetric}
                options={[
                  { value: 'cost', label: t('settings.usage.trendCost') },
                  { value: 'tokens', label: t('settings.usage.trendTokens') },
                  { value: 'requests', label: t('settings.usage.trendRequests') },
                ]}
              />
              <SegmentedTabs<ConsumptionStyle>
                label={t('settings.usage.consumptionDistribution')}
                value={consumptionStyle}
                onChange={setConsumptionStyle}
                options={[
                  { value: 'area', label: t('settings.usage.areaChart') },
                  { value: 'bar', label: t('settings.usage.barChart') },
                ]}
              />
            </div>
          }
        >
          <div className="px-4 py-3">
            {hasTrendData ? (
              <Chart option={consumptionOption} className="h-[268px] w-full" />
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-ink-quaternary">
                {loading ? t('settings.usage.loading') : t('settings.usage.noChartData')}
              </div>
            )}
          </div>
        </Section>

        {/* Asymmetric 2-Column Bento Row: Actor Breakdown + Actor/Lifecycle Trends */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Section
            title={t('settings.usage.actorBreakdown')}
            className="lg:col-span-5"
            action={
              <SegmentedTabs<BreakdownView>
                label={t('settings.usage.actorBreakdown')}
                value={breakdownView}
                onChange={setBreakdownView}
                options={[
                  { value: 'distribution', label: t('settings.usage.shareView') },
                  { value: 'ranking', label: t('settings.usage.rankingView') },
                ]}
              />
            }
          >
            {activeActorItems.length === 0 ? (
              <div className="flex h-[270px] flex-col items-center justify-center gap-2 px-4 text-center text-sm text-ink-quaternary">
                <span>{loading ? t('settings.usage.loading') : t('settings.usage.noChartData')}</span>
                {canSwitchCostToTokens ? (
                  <button
                    type="button"
                    onClick={() => selectActorMetric('tokens')}
                    className="text-xs font-medium text-accent-ink hover:underline"
                  >
                    {t('settings.usage.switchToTokens')}
                  </button>
                ) : null}
              </div>
            ) : breakdownView === 'distribution' ? (
              <div className="space-y-4 p-4">
                <div className="relative">
                  <Chart option={actorDonutOption} className="h-[184px] w-full" />
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xs font-medium text-ink-tertiary uppercase">
                      {actorMetric === 'cost'
                        ? t('settings.usage.trendCost')
                        : t('settings.usage.trendTokens')}
                    </span>
                    <span className="mt-0.5 text-lg font-bold tracking-tight text-ink tabular-nums">
                      {actorMetric === 'cost'
                        ? money(actorTotalValue)
                        : formatCompactNumber(actorTotalValue)}
                    </span>
                  </div>
                </div>
                <ul className="space-y-2 border-t border-line pt-3">
                  {activeActorItems.slice(0, 5).map((actor, idx) => {
                    const val = actorMetric === 'cost' ? actor.costUsd : actor.tokens;
                    const share = actorTotalValue > 0 ? (val / actorTotalValue) * 100 : 0;
                    const color = theme.palette[idx % theme.palette.length]!;
                    return (
                      <li key={actor.key} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span className="truncate font-medium text-ink" title={actor.name}>
                              {actor.name}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-3xs text-ink-secondary tabular-nums">
                            {actorMetric === 'cost'
                              ? money(val, { digits: 3 })
                              : formatCompactNumber(val)}{' '}
                            · {share.toFixed(0)}%
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-muted">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(3, share)}%`, backgroundColor: color }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <ul className="divide-y divide-line/70 px-4 py-2">
                {activeActorItems.slice(0, 7).map((actor, idx) => {
                  const val = actorMetric === 'cost' ? actor.costUsd : actor.tokens;
                  const share = actorTotalValue > 0 ? (val / actorTotalValue) * 100 : 0;
                  const color = theme.palette[idx % theme.palette.length]!;
                  return (
                    <li key={actor.key} className="py-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="w-4 text-3xs font-semibold text-ink-quaternary tabular-nums">
                            #{idx + 1}
                          </span>
                          <span className="truncate font-medium text-ink" title={actor.name}>
                            {actor.name}
                          </span>
                        </div>
                        <span className="shrink-0 text-xs font-semibold text-ink tabular-nums">
                          {actorMetric === 'cost'
                            ? money(actor.costUsd, { digits: 3 })
                            : formatCompactNumber(actor.tokens)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 pl-6">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(4, share)}%`, backgroundColor: color }}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-3xs text-ink-quaternary tabular-nums">
                          {actorMetric === 'cost'
                            ? formatCompactNumber(actor.tokens)
                            : money(actor.costUsd, { digits: 3 })}{' '}
                          · {share.toFixed(0)}%
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title={
              actorTab === 'consumption'
                ? t('settings.usage.actorConsumption')
                : t('settings.usage.workerLifecycle')
            }
            className="lg:col-span-7"
            action={
              <div className="flex flex-wrap items-center justify-end gap-1.5 sm:flex-nowrap">
                {actorTab === 'consumption' ? (
                  <SegmentedTabs<'tokens' | 'cost'>
                    label={t('settings.usage.trendMetric')}
                    value={actorMetric}
                    onChange={selectActorMetric}
                    options={[
                      { value: 'tokens', label: t('settings.usage.trendTokens') },
                      { value: 'cost', label: t('settings.usage.trendCost') },
                    ]}
                  />
                ) : null}
                <SegmentedTabs<ActorTab>
                  label={t('settings.usage.actorConsumption')}
                  value={actorTab}
                  onChange={setActorTab}
                  options={[
                    { value: 'consumption', label: t('settings.usage.actorTabConsumption') },
                    { value: 'lifecycle', label: t('settings.usage.actorTabLifecycle') },
                  ]}
                />
              </div>
            }
          >
            <div className="space-y-3 px-4 py-3">
              {actorTab === 'consumption' ? (
                hasTrendData && activeActorItems.length > 0 ? (
                  <>
                    <Chart option={sourceCostOption} className="h-[246px] w-full" />
                    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                      {activeActorItems.slice(0, 5).map((actor, idx) => (
                        <span
                          key={actor.key}
                          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted/45 px-2.5 py-1 text-3xs"
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: theme.palette[idx % theme.palette.length] }}
                          />
                          <span className="max-w-[9rem] truncate text-ink-secondary">
                            {actor.name}
                          </span>
                          <span className="font-mono font-medium text-ink tabular-nums">
                            {actorMetric === 'cost'
                              ? money(actor.costUsd, { digits: 3 })
                              : formatCompactNumber(actor.tokens)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="flex h-[270px] flex-col items-center justify-center gap-2 text-sm text-ink-quaternary">
                    <span>{loading ? t('settings.usage.loading') : t('settings.usage.noChartData')}</span>
                    {canSwitchCostToTokens ? (
                      <button
                        type="button"
                        onClick={() => selectActorMetric('tokens')}
                        className="text-xs font-medium text-accent-ink hover:underline"
                      >
                        {t('settings.usage.switchToTokens')}
                      </button>
                    ) : null}
                  </div>
                )
              ) : (report?.workerLifecycle.length ?? 0) > 0 ? (
                <Chart option={workerLifecycleOption} className="h-[286px] w-full" />
              ) : (
                <div className="flex h-[270px] items-center justify-center text-sm text-ink-quaternary">
                  {loading ? t('settings.usage.loading') : t('settings.usage.noChartData')}
                </div>
              )}
            </div>
          </Section>
        </div>

        {/* Polished Call Ledger */}
        <Section
          title={t('settings.usage.details')}
          description={loading ? t('settings.usage.loading') : (error ?? undefined)}
          action={
            report ? (
              <span className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-secondary tabular-nums">
                {report.totalCalls.toLocaleString()}
              </span>
            ) : null
          }
        >
          {error ? (
            <p className="px-4 py-5 text-sm text-danger">
              {t('settings.usage.loadFailed')}: {error}
            </p>
          ) : report?.calls.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs-plus">
                  <thead className="border-b border-line bg-surface-muted/50 text-3xs tracking-wider text-ink-quaternary uppercase">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">{t('settings.usage.time')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('settings.usage.source')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('settings.usage.model')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('settings.usage.capability')}</th>
                      <th className="px-3 py-2.5 font-medium">{t('settings.usage.quantity')}</th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        {t('settings.usage.amount')}
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        {t('settings.usage.durationMs')}
                      </th>
                      <th className="px-4 py-2.5 text-right font-medium">
                        {t('settings.usage.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {report.calls.map((call: UsageCallView) => {
                      const modelLabel = resolveModelName(call.providerId, call.modelId);
                      const statusStyle =
                        call.status === 'ok'
                          ? { dot: 'bg-success', badge: 'bg-success/10 text-success' }
                          : call.status === 'error'
                            ? { dot: 'bg-danger', badge: 'bg-danger/10 text-danger' }
                            : call.status === 'aborted' || call.status === 'interrupted'
                              ? { dot: 'bg-warning', badge: 'bg-warning/10 text-warning' }
                              : {
                                  dot: 'bg-ink-quaternary',
                                  badge: 'bg-surface-muted text-ink-tertiary',
                                };

                      return (
                        <tr key={call.id} className="transition-colors hover:bg-surface-muted/35">
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <div className="font-mono text-xs text-ink tabular-nums">
                              {formatAppTime(call.startedAt, locale)}
                            </div>
                            <div className="text-3xs text-ink-quaternary tabular-nums">
                              {formatAppDate(call.startedAt, locale)}
                            </div>
                          </td>
                          <td
                            className="max-w-[10rem] truncate px-3 py-2.5 text-xs font-medium text-ink-secondary"
                            title={call.workerName ?? call.origin}
                          >
                            {call.workerName ?? call.origin}
                          </td>
                          <td
                            className="max-w-[11rem] truncate px-3 py-2.5 text-xs text-ink-secondary"
                            title={modelLabel}
                          >
                            {modelLabel}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <span className="inline-flex rounded-md border border-line bg-surface-muted/60 px-1.5 py-0.5 font-mono text-3xs text-ink-secondary uppercase">
                              {call.capability}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {call.totalTokens > 0 ? (
                              <div>
                                <div className="font-mono text-xs text-ink tabular-nums">
                                  {call.totalTokens.toLocaleString()}
                                </div>
                                <div className="flex items-center gap-1.5 font-mono text-3xs text-ink-quaternary tabular-nums">
                                  <span>↑{formatCompactNumber(call.inputTokens)}</span>
                                  <span>↓{formatCompactNumber(call.outputTokens)}</span>
                                  {call.cacheReadTokens > 0 ? (
                                    <span className="rounded bg-accent-soft px-1 text-[10px] text-accent-ink">
                                      ⚡{formatCompactNumber(call.cacheReadTokens)}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ) : call.billingUnit === 'second' ? (
                              <span className="font-mono text-xs text-ink-secondary tabular-nums">
                                {call.tokenSource === 'provider-duration-missing'
                                  ? '—'
                                  : `${call.billedQuantity}s`}
                              </span>
                            ) : call.billedQuantity ? (
                              <span className="font-mono text-xs text-ink-secondary tabular-nums">
                                {call.billedQuantity} {call.billingUnit}
                              </span>
                            ) : (
                              <span className="text-ink-quaternary">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                            {call.chargedCostUsd === null ? (
                              <span
                                className="text-3xs text-ink-quaternary"
                                title={t('settings.usage.noPriceHint')}
                              >
                                {t('settings.usage.noPrice')}
                              </span>
                            ) : (
                              <span className="font-medium text-ink">
                                {money(call.chargedCostUsd, { digits: 4 })}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs whitespace-nowrap text-ink-tertiary tabular-nums">
                            {call.durationMs === null
                              ? '—'
                              : `${(call.durationMs / 1000).toFixed(1)}s`}
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <span
                              title={call.error ?? undefined}
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-3xs font-medium',
                                statusStyle.badge,
                              )}
                            >
                              <span className={cn('size-1.5 rounded-full', statusStyle.dot)} />
                              {t(`settings.usage.${call.status}`)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-ink-tertiary">
                <span className="tabular-nums">
                  {report.totalCalls.toLocaleString()} ·{' '}
                  {t('settings.usage.page', { page: report.page, pages })}
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={report.page <= 1}
                    className={buttonClass.secondary}
                    onClick={() =>
                      setFilter((f) => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))
                    }
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    disabled={report.page >= pages}
                    className={buttonClass.secondary}
                    onClick={() => setFilter((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}
                  >
                    ›
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-ink-tertiary">
              <p>{loading ? t('settings.usage.loading') : t('settings.usage.empty')}</p>
              {!loading && preset !== 'all' ? (
                <button
                  type="button"
                  className="text-xs font-medium text-accent-ink hover:underline"
                  onClick={() => applyPreset('all')}
                >
                  {t('settings.usage.viewAll')}
                </button>
              ) : null}
              {!loading && !report?.totalCalls && !report?.coverage.backfillComplete ? (
                <p className="max-w-lg text-xs text-ink-quaternary">
                  {t('settings.usage.emptyBackfillPending')}
                </p>
              ) : null}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
