import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  init,
  getInstanceByDom,
  use as registerModules,
  type EChartsCoreOption,
} from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UsageCallView, UsageFilter, UsageReport } from '@opc/shared/ipc';
import { useMoney } from '@/entities/billing/model/useBilling';
import { appTimeZone, formatAppDate, formatAppTime } from '@/shared/lib/appTime';
import { PageHeader, Section, buttonClass } from '../kit';

type Preset = 'today' | 'last7' | 'last30' | 'month' | 'all' | 'custom';
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
  const zoneDelta = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - guess;
  return Date.UTC(year!, month! - 1, day!) - zoneDelta;
}

function Chart({ option, className = 'h-64' }: { option: EChartsCoreOption; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(option);
  latest.current = option;
  useEffect(() => {
    if (!host.current) return;
    const chart = init(host.current, undefined, { renderer: 'canvas' });
    chart.setOption(latest.current);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, []);
  useEffect(() => {
    const chart = getInstanceByDom(host.current!);
    chart?.setOption(option, true);
  }, [option]);
  return <div ref={host} className={className} />;
}

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const zone = appTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [preset, setPreset] = useState<Preset>('last30');
  const [startDate, setStartDate] = useState(() => localDateInput(Date.now() - 6 * DAY, zone));
  const [endDate, setEndDate] = useState(() => localDateInput(Date.now(), zone));
  const [advanced, setAdvanced] = useState(false);
  const [consumptionMetric, setConsumptionMetric] = useState<'cost' | 'tokens'>('cost');
  const [consumptionStyle, setConsumptionStyle] = useState<'bar' | 'area'>('bar');
  const [modelView, setModelView] = useState<'trend' | 'distribution' | 'ranking'>('trend');
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
        setReport(await window.opc.usage.report(next));
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

  const setMulti = (key: 'providers' | 'models' | 'statuses', value: string, checked: boolean) => {
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

  const consumptionOption = useMemo<EChartsCoreOption>(
    () => ({
      animationDuration: 280,
      grid: { left: 54, right: 18, top: 20, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        borderWidth: 1,
        borderColor: '#d9ddd7',
        backgroundColor: '#fff',
        textStyle: { color: '#242a25' },
        formatter: (items: unknown) => {
          const item = (items as { dataIndex: number }[])[0];
          const point = report?.series[item?.dataIndex ?? -1];
          return point
            ? `${point.label}<br/>${consumptionMetric === 'cost' ? money(point.costUsd, { digits: 4 }) : point.tokens.toLocaleString()}<br/>${t('settings.usage.unpriced')}: ${point.unpricedCalls}`
            : '';
        },
      },
      xAxis: {
        type: 'category',
        data: report?.series.map((point) => point.label) ?? [],
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#d9ddd7' } },
        axisLabel: { color: '#778078', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#edf0eb' } },
        axisLabel: {
          color: '#778078',
          formatter: (value: number) =>
            consumptionMetric === 'cost' ? `$${value}` : Number(value).toLocaleString(),
        },
      },
      series: [
        {
          type: consumptionStyle === 'bar' ? 'bar' : 'line',
          smooth: false,
          showSymbol: consumptionStyle === 'area',
          symbolSize: 5,
          data:
            report?.series.map((point) =>
              consumptionMetric === 'cost' ? point.costUsd : point.tokens,
            ) ?? [],
          itemStyle: { color: '#22b560' },
          lineStyle: { color: '#16845b', width: 2 },
          ...(consumptionStyle === 'area' ? { areaStyle: { color: 'rgba(22,132,91,.16)' } } : {}),
        },
      ],
    }),
    [consumptionMetric, consumptionStyle, money, report, t],
  );
  const modelAnalysisOption = useMemo<EChartsCoreOption>(() => {
    if (modelView === 'distribution')
      return {
        tooltip: { trigger: 'item' },
        legend: {
          type: 'scroll',
          orient: 'vertical',
          right: 8,
          top: 'middle',
          textStyle: { color: '#68736a' },
        },
        series: [
          {
            type: 'pie',
            radius: ['38%', '70%'],
            center: ['37%', '50%'],
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            label: { show: false },
            data: (report?.actors.models ?? []).map((item) => ({
              name: item.label,
              value: item.requests,
            })),
          },
        ],
      };
    if (modelView === 'trend') {
      const topModels = (report?.actors.models ?? []).slice(0, 5);
      const modelBuckets = new Map(
        (report?.actors.modelSeries ?? []).map((point) => [point.at, point]),
      );
      return {
        tooltip: { trigger: 'axis' },
        grid: { left: 54, right: 20, top: 20, bottom: 34 },
        xAxis: {
          type: 'category',
          data: report?.series.map((point) => point.label) ?? [],
          axisLabel: { hideOverlap: true },
        },
        yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#edf0eb' } } },
        legend: { type: 'scroll', top: 0 },
        series: topModels.map((model) => ({
          name: model.label,
          type: 'line',
          symbolSize: 4,
          emphasis: { focus: 'series' },
          data: (report?.series ?? []).map(
            (point) =>
              modelBuckets.get(point.at)?.models.find((item) => item.key === model.key)?.requests ??
              0,
          ),
        })),
      };
    }
    const models = [...(report?.actors.models ?? [])].sort((a, b) => a.requests - b.requests);
    return {
      animationDuration: 240,
      grid: { left: 150, right: 28, top: 18, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#edf0eb' } } },
      yAxis: {
        type: 'category',
        data: models.map((item) => item.label),
        axisLabel: { width: 135, overflow: 'truncate' },
      },
      series: [
        { type: 'bar', data: models.map((item) => item.requests), itemStyle: { color: '#22b560' } },
      ],
    };
  }, [modelView, report]);
  const sourceCostOption = useMemo<EChartsCoreOption>(() => {
    const points = report?.series ?? [];
    const router = new Map(report?.actors.router.map((point) => [point.at, point]) ?? []);
    const workerData = report?.actors.workerSeries ?? [];
    const workerPoints = new Map(workerData.map((point) => [point.at, point]));
    const topWorkers = [...(report?.actors.workers ?? [])].slice(0, 5);
    const workerIds = new Set(topWorkers.map((worker) => worker.id));
    const makeData = (id: string, metric: 'cost' | 'tokens') =>
      points.map((point) => {
        const row = workerPoints.get(point.at)?.workers.find((worker) => worker.id === id);
        return metric === 'cost' ? (row?.costUsd ?? 0) : (row?.tokens ?? 0);
      });
    return {
      animationDuration: 240,
      grid: { left: 54, right: 20, top: 38, bottom: 34 },
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 0 },
      xAxis: {
        type: 'category',
        data: points.map((point) => point.label),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#edf0eb' } } },
      series: [
        {
          name: t('settings.usage.router'),
          type: 'line',
          stack: 'total',
          areaStyle: {},
          emphasis: { focus: 'series' },
          data: points.map((point) => {
            const row = router.get(point.at);
            return consumptionMetric === 'cost' ? (row?.costUsd ?? 0) : (row?.tokens ?? 0);
          }),
        },
        ...topWorkers.map((worker) => ({
          name: worker.name,
          type: 'line',
          stack: 'total',
          areaStyle: {},
          emphasis: { focus: 'series' },
          data: makeData(worker.id, consumptionMetric),
        })),
        {
          name: t('settings.usage.otherWorkers'),
          type: 'line',
          stack: 'total',
          areaStyle: {},
          emphasis: { focus: 'series' },
          data: points.map((point) =>
            (workerPoints.get(point.at)?.workers ?? [])
              .filter((worker) => !workerIds.has(worker.id))
              .reduce(
                (sum, worker) =>
                  sum + (consumptionMetric === 'cost' ? worker.costUsd : worker.tokens),
                0,
              ),
          ),
        },
      ],
    };
  }, [consumptionMetric, report, t]);
  const workerLifecycleOption = useMemo<EChartsCoreOption>(
    () => ({
      animationDuration: 240,
      grid: { left: 48, right: 20, top: 24, bottom: 34 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      xAxis: {
        type: 'category',
        data: report?.workerLifecycle.map((point) => point.label) ?? [],
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#edf0eb' } } },
      series: [
        {
          name: t('settings.usage.activeWorkers'),
          type: 'line',
          data: report?.workerLifecycle.map((point) => point.active) ?? [],
          symbolSize: 5,
          lineStyle: { width: 2, color: '#16845b' },
        },
        {
          name: t('settings.usage.createdWorkers'),
          type: 'bar',
          data: report?.workerLifecycle.map((point) => point.created) ?? [],
          itemStyle: { color: '#22b560' },
        },
        {
          name: t('settings.usage.retiredWorkers'),
          type: 'bar',
          data: report?.workerLifecycle.map((point) => point.retired) ?? [],
          itemStyle: { color: '#e27963' },
        },
      ],
    }),
    [report, t],
  );

  const card = (label: string, value: string, detail?: string) => (
    <div className="min-w-0 border-l-2 border-[#16845b] pl-3">
      <div className="text-xs-plus text-ink-tertiary">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tabular-nums text-ink">{value}</div>
      {detail && <div className="mt-0.5 text-2xs text-ink-quaternary">{detail}</div>}
    </div>
  );
  const pick = (
    label: string,
    key: 'providers' | 'models' | 'statuses',
    options: [string, string][],
  ) => (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs-plus text-ink-tertiary">{label}</legend>
      <div className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-line bg-surface px-2 py-1.5">
        {options.length ? (
          options.map(([value, title]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 truncate text-xs-plus text-ink-secondary"
            >
              <input
                type="checkbox"
                checked={filter[key]?.includes(value as never) ?? false}
                onChange={(event) => setMulti(key, value, event.target.checked)}
              />{' '}
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
  );
  const dateField = (value: string, change: (v: string) => void, label: string) => (
    <label className="flex items-center gap-2 text-xs-plus text-ink-tertiary">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => {
          change(event.target.value);
          setPreset('custom');
        }}
        className="h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-xs-plus text-ink"
      />
    </label>
  );
  const applyDates = () =>
    setFilter((current) => ({
      ...current,
      startAt: dateStart(startDate, zone),
      endAt: dateStart(endDate, zone) + DAY,
      timezone: zone,
      page: 1,
    }));
  const pages = Math.max(1, Math.ceil((report?.totalCalls ?? 0) / (report?.pageSize ?? 30)));

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.general')]}
        title={t('settings.page.usage')}
        description={t('settings.usage.desc')}
        actions={
          <>
            <button
              className={buttonClass.secondary}
              onClick={() => void load(filter)}
              title={t('settings.usage.refresh')}
            >
              <RefreshCw className="size-3.5" />
              {t('settings.usage.refresh')}
            </button>
            <button className={buttonClass.primary} onClick={() => void exportCsv()}>
              <Download className="size-3.5" />
              {t('settings.usage.export')}
            </button>
          </>
        }
      />
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex flex-wrap gap-1">
            {(['today', 'last7', 'last30', 'month', 'all', 'custom'] as Preset[]).map((item) => (
              <button
                key={item}
                onClick={() => applyPreset(item)}
                className={`rounded-md px-2.5 py-1.5 text-xs-plus ${preset === item ? 'bg-[#16845b] text-white' : 'text-ink-secondary hover:bg-ink/5'}`}
              >
                {t(`settings.usage.${item}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dateField(startDate, setStartDate, t('settings.usage.start'))}
            <span className="text-ink-quaternary">–</span>
            {dateField(endDate, setEndDate, t('settings.usage.end'))}
            <button className={buttonClass.secondary} onClick={applyDates}>
              {t('settings.usage.apply')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs-plus text-ink-tertiary">
          <span>{t('settings.usage.timeZone', { zone })}</span>
          <button
            className="inline-flex items-center gap-1.5 hover:text-ink"
            onClick={() => setAdvanced((value) => !value)}
          >
            <SlidersHorizontal className="size-3.5" />
            {t('settings.usage.advanced')}
          </button>
        </div>
        {advanced && (
          <Section title={t('settings.usage.filters')}>
            <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
              {pick(
                t('settings.usage.providers'),
                'providers',
                (report?.options.providers ?? []).map((x) => [x, x]),
              )}
              {pick(
                t('settings.usage.models'),
                'models',
                (report?.options.models ?? []).map((x) => [x, x]),
              )}
              {pick(t('settings.usage.statuses'), 'statuses', statusOptions)}
              <label className="col-span-2 min-w-0 text-xs-plus text-ink-tertiary md:col-span-1">
                {t('settings.usage.query')}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('settings.usage.queryPlaceholder')}
                  className="mt-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-ink"
                />
              </label>
              <div className="col-span-full flex justify-end gap-2">
                <button
                  className={buttonClass.secondary}
                  onClick={() => {
                    setQuery('');
                    setFilter((f) => ({
                      ...f,
                      providers: undefined,
                      models: undefined,
                      statuses: undefined,
                      query: undefined,
                      page: 1,
                    }));
                  }}
                >
                  {t('settings.usage.reset')}
                </button>
                <button className={buttonClass.primary} onClick={applyAdvanced}>
                  {t('settings.usage.apply')}
                </button>
              </div>
            </div>
          </Section>
        )}
        {report?.coverage.backfillComplete ? (
          <p className="border-l-2 border-[#16845b] pl-3 text-xs-plus text-ink-tertiary">
            {t('settings.usage.coverageComplete')}
            {report.coverage.backfillFrom
              ? ` · ${formatAppDate(report.coverage.backfillFrom, locale)}`
              : ''}
          </p>
        ) : (
          <p className="border-l-2 border-[#d69b31] pl-3 text-xs-plus text-ink-tertiary">
            {t('settings.usage.coveragePending')}
          </p>
        )}
        <div className="grid grid-cols-2 gap-y-4 border-y border-line py-4 md:grid-cols-4">
          {card(t('settings.usage.charged'), money(report?.summary.chargedCostUsd ?? 0))}
          {card(t('settings.usage.requests'), (report?.summary.requests ?? 0).toLocaleString())}
          {card(t('settings.usage.tokens'), (report?.summary.totalTokens ?? 0).toLocaleString())}
          {card(
            t('settings.usage.successRate'),
            report?.summary.successRate == null
              ? '—'
              : `${(report.summary.successRate * 100).toFixed(1)}%`,
          )}
          {card(
            t('settings.usage.unpriced'),
            String(report?.summary.unpricedCalls ?? 0),
            t('settings.usage.noPrice'),
          )}
          {card(t('settings.usage.images'), String(report?.summary.images ?? 0))}
          {card(t('settings.usage.asr'), `${(report?.summary.asrSeconds ?? 0).toFixed(1)} s`)}
          {card(t('settings.usage.tts'), (report?.summary.ttsCharacters ?? 0).toLocaleString())}
        </div>
        <Section
          title={t('settings.usage.consumptionDistribution')}
          action={
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-line p-0.5">
                {(['cost', 'tokens'] as const).map((value) => (
                  <button
                    key={value}
                    className={`rounded px-2 py-1 text-xs-plus ${consumptionMetric === value ? 'bg-surface-muted text-ink' : 'text-ink-tertiary'}`}
                    onClick={() => setConsumptionMetric(value)}
                  >
                    {t(
                      value === 'cost' ? 'settings.usage.trendCost' : 'settings.usage.trendTokens',
                    )}
                  </button>
                ))}
              </div>
              <div className="inline-flex rounded-md border border-line p-0.5">
                {(['bar', 'area'] as const).map((value) => (
                  <button
                    key={value}
                    className={`rounded px-2 py-1 text-xs-plus ${consumptionStyle === value ? 'bg-surface-muted text-ink' : 'text-ink-tertiary'}`}
                    onClick={() => setConsumptionStyle(value)}
                  >
                    {t(value === 'bar' ? 'settings.usage.barChart' : 'settings.usage.areaChart')}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <div className="px-4 py-3">
            <Chart option={consumptionOption} />
          </div>
        </Section>
        <Section
          title={t('settings.usage.modelAnalysis')}
          action={
            <div
              role="tablist"
              aria-label={t('settings.usage.modelAnalysis')}
              className="flex items-center gap-1"
            >
              {(['trend', 'distribution', 'ranking'] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={modelView === value}
                  className={`rounded-md px-2.5 py-1.5 text-xs-plus ${modelView === value ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-tertiary hover:bg-ink/5'}`}
                  onClick={() => setModelView(value)}
                >
                  {t(`settings.usage.model${value[0]!.toUpperCase()}${value.slice(1)}`)}
                </button>
              ))}
            </div>
          }
        >
          <div className="px-4 py-3">
            <Chart option={modelAnalysisOption} />
          </div>
        </Section>
        <Section
          title={t('settings.usage.actorConsumption')}
          action={
            <div className="inline-flex rounded-md border border-line p-0.5">
              {(['cost', 'tokens'] as const).map((value) => (
                <button
                  key={value}
                  className={`rounded px-2 py-1 text-xs-plus ${consumptionMetric === value ? 'bg-surface-muted text-ink' : 'text-ink-tertiary'}`}
                  onClick={() => setConsumptionMetric(value)}
                >
                  {t(value === 'cost' ? 'settings.usage.trendCost' : 'settings.usage.trendTokens')}
                </button>
              ))}
            </div>
          }
        >
          <div className="px-4 py-3">
            <Chart option={sourceCostOption} />
          </div>
        </Section>
        <Section title={t('settings.usage.workerLifecycle')}>
          <div className="px-4 py-3">
            <Chart option={workerLifecycleOption} />
          </div>
        </Section>
        <Section
          title={t('settings.usage.details')}
          description={loading ? t('settings.usage.loading') : (error ?? undefined)}
        >
          {error ? (
            <p className="px-4 py-5 text-sm text-danger">
              {t('settings.usage.loadFailed')}: {error}
            </p>
          ) : report?.calls.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[780px] text-left text-xs-plus">
                  <thead className="bg-surface-muted text-ink-tertiary">
                    <tr>
                      {[
                        'time',
                        'source',
                        'capability',
                        'model',
                        'quantity',
                        'amount',
                        'durationMs',
                        'status',
                      ].map((key) => (
                        <th key={key} className="px-3 py-2 font-medium">
                          {t(`settings.usage.${key}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.calls.map((call: UsageCallView) => (
                      <tr key={call.id} className="border-t border-line hover:bg-ink/[.025]">
                        <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">
                          {formatAppDate(call.startedAt, locale)}{' '}
                          {formatAppTime(call.startedAt, locale)}
                        </td>
                        <td
                          className="max-w-32 truncate px-3 py-2 text-ink-secondary"
                          title={call.workerName ?? call.origin}
                        >
                          {call.workerName ?? call.origin}
                        </td>
                        <td className="px-3 py-2 text-ink-secondary">{call.capability}</td>
                        <td
                          className="max-w-44 truncate px-3 py-2 font-medium text-ink"
                          title={`${call.providerId}/${call.modelId}`}
                        >
                          {call.providerId}/{call.modelId}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-secondary">
                          {call.totalTokens
                            ? `${call.totalTokens.toLocaleString()} tokens`
                            : call.billingUnit === 'second'
                              ? call.tokenSource === 'provider-duration-missing'
                                ? '—'
                                : `${call.billedQuantity}s`
                              : call.billedQuantity
                                ? `${call.billedQuantity} ${call.billingUnit}`
                                : '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                          {call.chargedCostUsd === null ? (
                            <span className="text-ink-quaternary">
                              {t('settings.usage.noPrice')}
                            </span>
                          ) : (
                            money(call.chargedCostUsd, { digits: 4 })
                          )}
                        </td>
                        <td className="px-3 py-2 text-ink-secondary">
                          {call.durationMs === null
                            ? '—'
                            : `${(call.durationMs / 1000).toFixed(1)} s`}
                        </td>
                        <td className="px-3 py-2 text-ink-secondary">
                          {t(`settings.usage.${call.status}`)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs-plus text-ink-tertiary">
                <span>
                  {report.totalCalls.toLocaleString()} ·{' '}
                  {t('settings.usage.page', { page: report.page, pages })}
                </span>
                <div className="flex gap-1">
                  <button
                    disabled={report.page <= 1}
                    className={buttonClass.secondary}
                    onClick={() =>
                      setFilter((f) => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))
                    }
                  >
                    ‹
                  </button>
                  <button
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
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-ink-tertiary">
              <p>{loading ? t('settings.usage.loading') : t('settings.usage.empty')}</p>
              {!loading && preset !== 'all' ? (
                <button
                  className="text-xs-plus font-medium text-[#16845b] hover:underline"
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
