import type { EChartsCoreOption } from 'echarts/core';
import type { UsageReport } from '@opc/shared/ipc';

export type ConsumptionMetric = 'cost' | 'tokens' | 'requests';
export type ConsumptionStyle = 'area' | 'bar';

export interface ActorBreakdownItem {
  key: string;
  name: string;
  costUsd: number;
  tokens: number;
  requests?: number;
}

export interface MergedWorkerActor {
  key: string;
  name: string;
  costUsd: number;
  tokens: number;
  requests: number;
  workerIds: string[];
}

/**
 * Collapse multiple worker instances sharing the same display name (e.g. repeated
 * "小助手" living workers) into a single logical entry for attribution & trend charts.
 */
export function mergeWorkersByName(
  workers: UsageReport['actors']['workers'] | undefined,
  fallbackName: string,
): MergedWorkerActor[] {
  const byName = new Map<string, MergedWorkerActor>();
  for (const worker of workers ?? []) {
    const name = worker.name.trim() || fallbackName;
    const existing = byName.get(name);
    if (existing) {
      existing.costUsd += worker.costUsd;
      existing.tokens += worker.tokens;
      existing.requests += worker.requests;
      existing.workerIds.push(worker.id);
    } else {
      byName.set(name, {
        key: `worker-name:${name}`,
        name,
        costUsd: worker.costUsd,
        tokens: worker.tokens,
        requests: worker.requests,
        workerIds: [worker.id],
      });
    }
  }
  return [...byName.values()].sort(
    (a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd || b.requests - a.requests,
  );
}

export interface ChartTheme {
  isDark: boolean;
  palette: readonly string[];
  text: string;
  muted: string;
  subtle: string;
  gridLine: string;
  axisLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  surface: string;
  accent: string;
  accentSoft: string;
  accentFade: string;
  coral: string;
}

export const LIGHT_PALETTE = [
  '#168352',
  '#3b82f6',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
] as const;

export const DARK_PALETTE = [
  '#38b679',
  '#60a5fa',
  '#a78bfa',
  '#fbbf24',
  '#f472b6',
  '#2dd4bf',
] as const;

export function getChartTheme(isDark: boolean): ChartTheme {
  return isDark
    ? {
        isDark: true,
        palette: DARK_PALETTE,
        text: '#eceef2',
        muted: '#848a96',
        subtle: '#626874',
        gridLine: 'rgba(255, 255, 255, 0.07)',
        axisLine: 'rgba(255, 255, 255, 0.10)',
        tooltipBg: 'rgba(24, 26, 32, 0.96)',
        tooltipBorder: 'rgba(255, 255, 255, 0.12)',
        surface: '#1b1d22',
        accent: '#38b679',
        accentSoft: 'rgba(56, 182, 121, 0.28)',
        accentFade: 'rgba(56, 182, 121, 0.0)',
        coral: '#f06a6f',
      }
    : {
        isDark: false,
        palette: LIGHT_PALETTE,
        text: '#18181b',
        muted: '#71717a',
        subtle: '#a1a1aa',
        gridLine: 'rgba(24, 24, 27, 0.07)',
        axisLine: 'rgba(24, 24, 27, 0.10)',
        tooltipBg: 'rgba(255, 255, 255, 0.97)',
        tooltipBorder: 'rgba(24, 24, 27, 0.10)',
        surface: '#ffffff',
        accent: '#168352',
        accentSoft: 'rgba(22, 131, 82, 0.22)',
        accentFade: 'rgba(22, 131, 82, 0.0)',
        coral: '#dc4c4c',
      };
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return Math.round(value).toLocaleString();
}

export function formatAxisValue(value: number, metric: ConsumptionMetric): string {
  if (metric === 'cost') {
    if (value === 0) return '$0';
    if (Math.abs(value) < 0.01) return `$${value.toFixed(3)}`;
    if (Math.abs(value) < 1) return `$${value.toFixed(2)}`;
    if (Math.abs(value) >= 1000) return `$${formatCompactNumber(value)}`;
    return `$${Number(value.toFixed(2))}`;
  }
  return formatCompactNumber(value);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linearFill(topColor: string, bottomColor: string) {
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: topColor },
      { offset: 1, color: bottomColor },
    ],
  };
}

function baseTooltip(theme: ChartTheme) {
  return {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    padding: [10, 12],
    textStyle: {
      color: theme.text,
      fontSize: 12,
      fontFamily: 'Inter Variable, Noto Sans SC Variable, sans-serif',
    },
    extraCssText:
      'border-radius:10px;backdrop-filter:blur(10px);box-shadow:0 12px 28px rgba(0,0,0,0.16);',
  };
}

export function buildConsumptionOption(
  report: UsageReport | null,
  metric: ConsumptionMetric,
  style: ConsumptionStyle,
  theme: ChartTheme,
  money: (usd: number, opts?: { digits?: number }) => string,
  labels: { cost: string; tokens: string; requests: string; unpriced: string },
): EChartsCoreOption {
  const points = report?.series ?? [];
  const data = points.map((point) =>
    metric === 'cost' ? point.costUsd : metric === 'tokens' ? point.tokens : point.requests,
  );
  // A single-point area line collapses to a tiny invisible pixel, so fall back to a bar.
  const useBar = style === 'bar' || points.length <= 1;

  return {
    animationDuration: 320,
    animationEasing: 'cubicOut',
    grid: { left: 56, right: 16, top: 18, bottom: 28 },
    tooltip: {
      ...baseTooltip(theme),
      trigger: 'axis',
      axisPointer: {
        type: useBar ? 'shadow' : 'line',
        lineStyle: { color: theme.axisLine, type: 'dashed' },
        shadowStyle: { color: hexToRgba(theme.accent, theme.isDark ? 0.08 : 0.05) },
      },
      formatter: (raw: unknown) => {
        const list = Array.isArray(raw) ? (raw as { dataIndex?: number }[]) : [];
        const idx = list[0]?.dataIndex ?? -1;
        const point = points[idx];
        if (!point) return '';
        const rows = [
          `<div style="font-weight:600;margin-bottom:6px;color:${theme.text}">${escapeHtml(point.label)}</div>`,
          `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.6"><span style="color:${theme.muted}">${escapeHtml(labels.cost)}</span><span style="font-weight:600;font-variant-numeric:tabular-nums">${escapeHtml(money(point.costUsd, { digits: 4 }))}</span></div>`,
          `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.6"><span style="color:${theme.muted}">${escapeHtml(labels.tokens)}</span><span style="font-weight:500;font-variant-numeric:tabular-nums">${point.tokens.toLocaleString()}</span></div>`,
          `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.6"><span style="color:${theme.muted}">${escapeHtml(labels.requests)}</span><span style="font-weight:500;font-variant-numeric:tabular-nums">${point.requests.toLocaleString()}</span></div>`,
        ];
        if (point.unpricedCalls > 0) {
          rows.push(
            `<div style="display:flex;justify-content:space-between;gap:18px;margin-top:3px;padding-top:3px;border-top:1px solid ${theme.gridLine};font-size:11px;color:${theme.muted}"><span>${escapeHtml(labels.unpriced)}</span><span>${point.unpricedCalls}</span></div>`,
          );
        }
        return rows.join('');
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: useBar,
      data: points.map((point) => point.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, margin: 10 },
    },
    yAxis: {
      type: 'value',
      minInterval: metric === 'requests' ? 1 : undefined,
      splitLine: { lineStyle: { color: theme.gridLine, type: 'dashed' } },
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        formatter: (value: number) => formatAxisValue(value, metric),
      },
    },
    series: [
      useBar
        ? {
            type: 'bar',
            barMaxWidth: points.length <= 1 ? 36 : 26,
            data,
            itemStyle: {
              borderRadius: [6, 6, 0, 0],
              color: linearFill(theme.accent, hexToRgba(theme.accent, 0.55)),
            },
            emphasis: {
              itemStyle: { color: theme.accent },
            },
          }
        : {
            type: 'line',
            smooth: 0.36,
            smoothMonotone: 'x',
            symbol: 'circle',
            showSymbol: points.length <= 8,
            symbolSize: 6,
            data,
            itemStyle: {
              color: theme.accent,
              borderColor: theme.surface,
              borderWidth: 2,
            },
            lineStyle: { color: theme.accent, width: 2.25 },
            areaStyle: {
              color: linearFill(theme.accentSoft, theme.accentFade),
            },
          },
    ],
  };
}

export function buildActorDonutOption(
  actors: readonly ActorBreakdownItem[],
  metric: 'cost' | 'tokens',
  theme: ChartTheme,
  money: (usd: number, opts?: { digits?: number }) => string,
  labels: { tokens: string; cost: string },
): EChartsCoreOption {
  const top = actors.slice(0, 6);
  return {
    animationDuration: 320,
    color: [...theme.palette],
    tooltip: {
      ...baseTooltip(theme),
      trigger: 'item',
      formatter: (raw: unknown) => {
        const entry = raw as { dataIndex?: number; percent?: number };
        const actor = top[entry.dataIndex ?? -1];
        if (!actor) return '';
        return [
          `<div style="font-weight:600;margin-bottom:5px;max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(actor.name)}</div>`,
          `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.6"><span style="color:${theme.muted}">${escapeHtml(labels.tokens)}</span><span style="font-weight:600">${formatCompactNumber(actor.tokens)} (${(entry.percent ?? 0).toFixed(1)}%)</span></div>`,
          `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.6"><span style="color:${theme.muted}">${escapeHtml(labels.cost)}</span><span>${escapeHtml(money(actor.costUsd, { digits: 4 }))}</span></div>`,
        ].join('');
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['64%', '88%'],
        center: ['50%', '50%'],
        padAngle: 3,
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 6,
          borderColor: theme.surface,
          borderWidth: 2,
        },
        label: { show: false },
        emphasis: {
          scale: true,
          scaleSize: 4,
        },
        data: top.map((item) => ({
          name: item.name,
          value: metric === 'cost' ? item.costUsd : item.tokens,
        })),
      },
    ],
  };
}

export function buildActorOption(
  report: UsageReport | null,
  metric: 'cost' | 'tokens',
  theme: ChartTheme,
  money: (usd: number, opts?: { digits?: number }) => string,
  labels: { router: string; otherWorkers: string; otherOrigin: string },
): EChartsCoreOption {
  const points = report?.series ?? [];
  const router = new Map((report?.actors.router ?? []).map((point) => [point.at, point]));
  const workerPoints = new Map(
    (report?.actors.workerSeries ?? []).map((point) => [point.at, point]),
  );
  const mergedWorkers = mergeWorkersByName(report?.actors.workers, labels.otherWorkers).sort(
    (a, b) =>
      metric === 'cost'
        ? b.costUsd - a.costUsd || b.tokens - a.tokens
        : b.tokens - a.tokens || b.costUsd - a.costUsd,
  );
  const topWorkers = mergedWorkers.slice(0, 4);
  const topWorkerNames = new Set(topWorkers.map((worker) => worker.name));
  const idToGroupName = new Map<string, string>();
  for (const group of mergedWorkers) {
    for (const id of group.workerIds) idToGroupName.set(id, group.name);
  }

  const routerData = points.map((point) => {
    const row = router.get(point.at);
    return metric === 'cost' ? (row?.costUsd ?? 0) : (row?.tokens ?? 0);
  });

  const allWorkersByIdx = points.map((point) =>
    (workerPoints.get(point.at)?.workers ?? []).reduce(
      (sum, worker) => sum + (metric === 'cost' ? worker.costUsd : worker.tokens),
      0,
    ),
  );

  const otherOriginData = points.map((point, idx) => {
    const bucketTotal = metric === 'cost' ? point.costUsd : point.tokens;
    const remainder = bucketTotal - (routerData[idx] ?? 0) - (allWorkersByIdx[idx] ?? 0);
    return remainder > 1e-9 ? remainder : 0;
  });

  const rawSeries: { name: string; data: number[] }[] = [
    { name: labels.router, data: routerData },
    ...topWorkers.map((group) => ({
      name: group.name,
      data: points.map((point) =>
        (workerPoints.get(point.at)?.workers ?? [])
          .filter((w) => idToGroupName.get(w.id) === group.name)
          .reduce(
            (sum, w) => sum + (metric === 'cost' ? w.costUsd : w.tokens),
            0,
          ),
      ),
    })),
    {
      name: labels.otherWorkers,
      data: points.map((point) =>
        (workerPoints.get(point.at)?.workers ?? [])
          .filter((worker) => {
            const groupName = idToGroupName.get(worker.id);
            return !groupName || !topWorkerNames.has(groupName);
          })
          .reduce(
            (sum, worker) => sum + (metric === 'cost' ? worker.costUsd : worker.tokens),
            0,
          ),
      ),
    },
    { name: labels.otherOrigin, data: otherOriginData },
  ];

  const nonZero = rawSeries.filter((entry) => entry.data.some((value) => value > 0));
  const activeSeries = nonZero.length > 0 ? nonZero : [rawSeries[0]!];
  const useBar = points.length <= 2;

  return {
    animationDuration: 300,
    color: [...theme.palette],
    tooltip: {
      ...baseTooltip(theme),
      trigger: 'axis',
      axisPointer: {
        type: useBar ? 'shadow' : 'line',
        lineStyle: { color: theme.axisLine, type: 'dashed' },
      },
      valueFormatter: (value: unknown) => {
        const num = typeof value === 'number' ? value : Number(value ?? 0);
        return metric === 'cost' ? money(num, { digits: 4 }) : formatCompactNumber(num);
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: theme.muted, fontSize: 11 },
    },
    grid: { left: 54, right: 16, top: 34, bottom: 26 },
    xAxis: {
      type: 'category',
      boundaryGap: useBar,
      data: points.map((point) => point.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: theme.gridLine, type: 'dashed' } },
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        formatter: (value: number) => formatAxisValue(value, metric),
      },
    },
    series: activeSeries.map((entry, idx) => {
      const hex = theme.palette[idx % theme.palette.length]!;
      if (useBar) {
        const isTop = idx === activeSeries.length - 1;
        return {
          name: entry.name,
          type: 'bar',
          stack: 'total',
          barMaxWidth: 32,
          itemStyle: {
            color: hex,
            borderRadius: isTop ? [4, 4, 0, 0] : [0, 0, 0, 0],
          },
          emphasis: { focus: 'series' },
          data: entry.data,
        };
      }
      return {
        name: entry.name,
        type: 'line',
        stack: 'total',
        smooth: 0.35,
        smoothMonotone: 'x',
        showSymbol: points.length <= 8,
        symbolSize: 5,
        lineStyle: { width: 1.8, color: hex },
        itemStyle: { color: hex },
        areaStyle: {
          color: linearFill(hexToRgba(hex, 0.26), hexToRgba(hex, 0.03)),
        },
        emphasis: { focus: 'series' },
        data: entry.data,
      };
    }),
  };
}

export function buildLifecycleOption(
  report: UsageReport | null,
  theme: ChartTheme,
  labels: { active: string; created: string; retired: string },
): EChartsCoreOption {
  const rows = report?.workerLifecycle ?? [];
  const blue = theme.palette[1]!;
  return {
    animationDuration: 300,
    tooltip: {
      ...baseTooltip(theme),
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: hexToRgba(theme.accent, 0.05) } },
    },
    legend: {
      top: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: theme.muted, fontSize: 11 },
    },
    grid: { left: 40, right: 14, top: 34, bottom: 26 },
    xAxis: {
      type: 'category',
      data: rows.map((point) => point.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: theme.gridLine, type: 'dashed' } },
      axisLabel: { color: theme.muted, fontSize: 11 },
    },
    series: [
      {
        name: labels.active,
        type: 'line',
        smooth: 0.35,
        smoothMonotone: 'x',
        showSymbol: rows.length <= 8,
        symbolSize: 6,
        data: rows.map((point) => point.active),
        itemStyle: { color: blue },
        lineStyle: { width: 2.2, color: blue },
        areaStyle: {
          color: linearFill(hexToRgba(blue, 0.20), hexToRgba(blue, 0.02)),
        },
      },
      {
        name: labels.created,
        type: 'bar',
        barMaxWidth: 14,
        data: rows.map((point) => point.created),
        itemStyle: { color: theme.accent, borderRadius: [4, 4, 0, 0] },
      },
      {
        name: labels.retired,
        type: 'bar',
        barMaxWidth: 14,
        data: rows.map((point) => point.retired),
        itemStyle: { color: theme.coral, borderRadius: [4, 4, 0, 0] },
      },
    ],
  };
}
