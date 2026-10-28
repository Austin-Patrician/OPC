import { useId } from 'react';
import { cn } from '@/shared/lib/cn';
import { areaPath, arcPath, donutSlice, linePath, niceMax, polar, scaleY } from './geometry';

/**
 * The chart kit: hand-drawn SVG, no dependency.
 *
 * One aesthetic, applied everywhere — an **instrument cluster**, not a dashboard. Thin
 * strokes, hairline grids, monospace numerals, and a single accent that is spent only on
 * the value that matters. Nothing is rounded-blobby, nothing is filled with a rainbow:
 * the palette is the app's own tokens, so a chart cannot look pasted in.
 *
 * Every chart is `role="img"` with a sentence for a label, and every number that is
 * drawn is also written down somewhere in the row it belongs to. A picture that only
 * exists as a picture is decoration.
 */

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  neutral: 'var(--text-quaternary)',
};

/** The colour a utilisation ratio deserves, matching the budget states. */
export function toneForRatio(ratio: number): Tone {
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'accent';
}

/* ── Gauge ──────────────────────────────────────────────────────────────── */

/**
 * A 240° arc gauge: utilisation at a glance.
 *
 * The sweep starts at 8 o'clock rather than at 12, because a gauge that starts at the
 * top reads as a clock; starting low leaves the open gap at the bottom where the value
 * sits, which is where the eye lands.
 */
export function Gauge({
  ratio,
  label,
  value,
  caption,
  size = 64,
  tone,
  testId,
}: {
  /** 0..1 (values above 1 are clamped, the number itself is still shown). */
  ratio: number;
  label: string;
  value: string;
  caption?: string;
  size?: number;
  tone?: Tone;
  testId?: string;
}) {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const resolved = tone ?? toneForRatio(ratio);
  const stroke = Math.max(3, size * 0.085);
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  const start = -120;
  const end = 120;
  const filled = start + (end - start) * clamped;

  return (
    <div className="flex items-center gap-2.5">
      <svg
        role="img"
        aria-label={`${label}: ${value}`}
        data-testid={testId}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0 overflow-visible"
      >
        {/* The empty track, drawn as the whole sweep. */}
        <path
          d={arcPath({ cx: centre, cy: centre, radius, start, end })}
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {clamped > 0 ? (
          <path
            d={arcPath({ cx: centre, cy: centre, radius, start, end: filled })}
            fill="none"
            stroke={TONE_COLOR[resolved]}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        ) : null}
        {/* Tick at the warn threshold: the one mark that changes behaviour. */}
        {[0.8].map((mark) => {
          const angle = start + (end - start) * mark;
          const outer = polar(centre, centre, radius + stroke * 0.75, angle);
          const inner = polar(centre, centre, radius - stroke * 0.75, angle);
          return (
            <line
              key={mark}
              x1={outer.x}
              y1={outer.y}
              x2={inner.x}
              y2={inner.y}
              stroke="var(--surface)"
              strokeWidth={Math.max(1, stroke * 0.3)}
            />
          );
        })}
        <text
          x={centre}
          y={centre + size * 0.02}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-[var(--text-primary)] font-mono"
          style={{ fontSize: size * 0.26, fontWeight: 600 }}
        >
          {value}
        </text>
      </svg>
      <div className="min-w-0">
        <div className="truncate text-2xs font-medium text-ink-secondary">{label}</div>
        {caption ? <div className="truncate text-3xs text-ink-quaternary">{caption}</div> : null}
      </div>
    </div>
  );
}

/* ── Donut ──────────────────────────────────────────────────────────────── */

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Composition of a total. Slices are drawn clockwise from 12 o'clock, largest first, so
 * the same data always produces the same picture.
 */
export function Donut({
  slices,
  size = 108,
  thickness = 13,
  centreValue,
  centreLabel,
  emptyLabel,
}: {
  slices: readonly DonutSlice[];
  size?: number;
  thickness?: number;
  centreValue?: string;
  centreLabel?: string;
  emptyLabel: string;
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const outer = size / 2;
  const inner = outer - thickness;
  const sorted = [...slices].filter((slice) => slice.value > 0).sort((a, b) => b.value - a.value);

  let cursor = 0;
  const drawn = sorted.map((slice) => {
    const sweep = total > 0 ? (slice.value / total) * 360 : 0;
    const path = donutSlice({
      cx: outer,
      cy: outer,
      inner,
      outer,
      start: cursor,
      end: cursor + sweep,
    });
    cursor += sweep;
    return { ...slice, path, share: total > 0 ? slice.value / total : 0 };
  });

  return (
    <div className="flex items-center gap-4">
      <svg
        role="img"
        aria-label={total > 0 ? centreLabel ?? emptyLabel : emptyLabel}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
      >
        {total === 0 ? (
          <circle
            cx={outer}
            cy={outer}
            r={(outer + inner) / 2}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={thickness}
          />
        ) : (
          drawn.map((slice) => (
            <path key={slice.key} d={slice.path} fill={slice.color} fillRule="evenodd">
              <title>{`${slice.label}: ${slice.value}`}</title>
            </path>
          ))
        )}
        {centreValue ? (
          <text
            x={outer}
            y={outer - (centreLabel ? size * 0.045 : 0)}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-[var(--text-primary)] font-mono"
            style={{ fontSize: size * 0.17, fontWeight: 600 }}
          >
            {centreValue}
          </text>
        ) : null}
        {centreLabel ? (
          <text
            x={outer}
            y={outer + size * 0.14}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-[var(--text-quaternary)]"
            style={{ fontSize: size * 0.09 }}
          >
            {centreLabel}
          </text>
        ) : null}
      </svg>

      <ul className="min-w-0 flex-1 space-y-1">
        {drawn.length === 0 ? (
          <li className="text-2xs text-ink-quaternary">{emptyLabel}</li>
        ) : (
          drawn.map((slice) => (
            <li key={slice.key} className="flex items-center gap-1.5 text-2xs">
              <span aria-hidden className="size-1.5 shrink-0 rounded-[2px]" style={{ background: slice.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{slice.label}</span>
              <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                {Math.round(slice.share * 100)}%
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/* ── Trend ──────────────────────────────────────────────────────────────── */

export interface TrendPoint {
  label: string;
  value: number;
  /** Optional second series, drawn dashed and never filled (an ideal / baseline). */
  reference?: number;
}

/**
 * An area trend with a hairline grid.
 *
 * `smooth` is off by default on purpose: a burndown that curves between two real
 * samples is a claim the data did not make. Pass it only where the shape is decorative.
 */
export function Trend({
  points,
  height = 96,
  tone = 'accent',
  smooth = false,
  ariaLabel,
  valueFormat = (value) => String(value),
  testId,
}: {
  points: readonly TrendPoint[];
  height?: number;
  tone?: Tone;
  smooth?: boolean;
  ariaLabel: string;
  valueFormat?: (value: number) => string;
  testId?: string;
}) {
  const gradientId = useId();
  const width = 100;
  const max = niceMax(Math.max(0, ...points.map((point) => Math.max(point.value, point.reference ?? 0))));
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const color = TONE_COLOR[tone];

  const project = (value: number) => ({ x: 0, y: scaleY(value, max, height) });
  const actual = points.map((point, index) => ({
    x: points.length > 1 ? index * step : 0,
    y: project(point.value).y,
  }));
  const reference = points.some((point) => point.reference !== undefined)
    ? points.map((point, index) => ({
        x: points.length > 1 ? index * step : 0,
        y: project(point.reference ?? 0).y,
      }))
    : [];

  const last = actual.at(-1);
  const peak = points.reduce<TrendPoint | undefined>(
    (best, point) => (!best || point.value > best.value ? point : best),
    undefined,
  );

  return (
    <div className="w-full">
      <svg
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Hairline grid: three lines, no labels — the axis numbers live outside. */}
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
            stroke="var(--border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {reference.length > 0 ? (
          <path
            d={linePath(reference)}
            fill="none"
            stroke="var(--text-quaternary)"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        <path d={areaPath(actual, height, smooth)} fill={`url(#${gradientId})`} />
        <path
          d={linePath(actual, smooth)}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {last ? (
          <circle
            cx={last.x}
            cy={last.y}
            r="2"
            fill={color}
            stroke="var(--surface)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      <div className="mt-1 flex items-center justify-between font-mono text-3xs text-ink-quaternary">
        <span>{points[0]?.label ?? ''}</span>
        {peak ? (
          <span className="truncate px-2">
            {valueFormat(peak.value)}
          </span>
        ) : null}
        <span>{points.at(-1)?.label ?? ''}</span>
      </div>
    </div>
  );
}

/* ── Columns ────────────────────────────────────────────────────────────── */

/**
 * Vertical bars for a short series (a fortnight of spend). Bars are square-topped and
 * thin: they are counts, not decoration, so they must not look like a progress bar.
 */
export function Columns({
  points,
  height = 72,
  tone = 'accent',
  ariaLabel,
  valueFormat = (value) => String(value),
  testId,
}: {
  points: readonly { label: string; value: number }[];
  height?: number;
  tone?: Tone;
  ariaLabel: string;
  valueFormat?: (value: number) => string;
  testId?: string;
}) {
  const max = niceMax(Math.max(0, ...points.map((point) => point.value)));
  const color = TONE_COLOR[tone];

  return (
    <div className="w-full">
      <div
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
        className="flex items-end gap-[3px] border-b border-line"
        style={{ height }}
      >
        {points.map((point) => {
          const ratio = max > 0 ? Math.max(0, point.value) / max : 0;
          return (
            <div key={point.label} className="group relative flex h-full flex-1 items-end">
              <span
                className="w-full rounded-t-[2px] transition-[height] duration-300"
                style={{
                  height: `${Math.max(point.value > 0 ? 2 : 0, ratio * 100)}%`,
                  background: color,
                  opacity: point.value > 0 ? 0.85 : 0,
                }}
                title={`${point.label} · ${valueFormat(point.value)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-3xs text-ink-quaternary">
        <span>{points[0]?.label ?? ''}</span>
        <span>{valueFormat(max)}</span>
        <span>{points.at(-1)?.label ?? ''}</span>
      </div>
    </div>
  );
}

/* ── Ranked bars ────────────────────────────────────────────────────────── */

/**
 * Horizontal ranked bars: the shape of "who/what is spending the most".
 *
 * The track is the full width so a 3% bar still reads as 3% of something rather than as
 * a short line; the value is printed at the end, because a bar length is an estimate and
 * the number is not.
 */
export function RankedBars({
  rows,
  ariaLabel,
  emptyLabel,
  formatValue = (value) => value.toLocaleString(),
}: {
  rows: readonly { key: string; label: string; value: number; caption?: string; color?: string }[];
  ariaLabel: string;
  emptyLabel: string;
  formatValue?: (value: number) => string;
}) {
  if (rows.length === 0) return <p className="text-2xs text-ink-quaternary">{emptyLabel}</p>;
  const max = Math.max(0, ...rows.map((row) => row.value));

  return (
    <ul role="img" aria-label={ariaLabel} className="space-y-1.5">
      {rows.map((row) => {
        const ratio = max > 0 ? Math.max(0, row.value) / max : 0;
        return (
          <li key={row.key} className="group">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-2xs text-ink-secondary">{row.label}</span>
              {row.caption ? (
                <span className="shrink-0 font-mono text-3xs text-ink-quaternary">{row.caption}</span>
              ) : null}
              <span className="shrink-0 font-mono text-2xs font-medium text-ink">
                {formatValue(row.value)}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.max(row.value > 0 ? 2 : 0, ratio * 100)}%`,
                  background: row.color ?? 'var(--accent)',
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Stacked bar ────────────────────────────────────────────────────────── */

/**
 * One bar split into its parts — the composition of a single row.
 *
 * Segments keep the caller's order (never sorted) because a status scale has a meaning
 * of its own; an empty part is skipped rather than drawn as a hairline, so "0 blocked"
 * does not look like "a little blocked".
 */
export function StackedBar({
  segments,
  ariaLabel,
  height = 6,
}: {
  segments: readonly { key: string; label: string; value: number; color: string }[];
  ariaLabel: string;
  height?: number;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);

  return (
    <div
      role="img"
      aria-label={`${ariaLabel}（${segments
        .filter((segment) => segment.value > 0)
        .map((segment) => `${segment.label} ${segment.value}`)
        .join('，')}）`}
      className="flex w-full items-stretch gap-px overflow-hidden rounded-full bg-surface-muted"
      style={{ height }}
    >
      {total === 0
        ? null
        : segments
            .filter((segment) => segment.value > 0)
            .map((segment) => (
              <span
                key={segment.key}
                title={`${segment.label}: ${segment.value}`}
                style={{
                  flexGrow: segment.value,
                  flexBasis: 0,
                  background: segment.color,
                }}
              />
            ))}
    </div>
  );
}

/* ── Capacity bar ───────────────────────────────────────────────────────── */

/**
 * Headcount against a cap, drawn as discrete seats.
 *
 * Discrete because the question is "how many chairs are left", and a continuous bar
 * cannot show that there are exactly two. Two cases fall back to a single bar: more
 * seats than can be counted at this size, and **over-establishment** — discrete seats
 * physically cannot draw a ninth person into eight chairs, and dropping them would hide
 * the one state worth seeing.
 */
export function CapacityBar({
  filled,
  total,
  ariaLabel,
  maxSeats = 24,
}: {
  filled: number;
  total: number;
  ariaLabel: string;
  maxSeats?: number;
}) {
  const seats = Math.max(0, total);
  const over = filled > seats;
  const discrete = seats > 0 && seats <= maxSeats && !over;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('flex h-1.5 items-stretch gap-px overflow-hidden rounded-full', !discrete && 'bg-surface-muted')}
    >
      {discrete ? (
        Array.from({ length: seats }, (_, index) => (
          <span
            key={index}
            className="flex-1 rounded-[1px]"
            style={{
              background:
                index < filled
                  ? filled > total * 0.9
                    ? 'var(--warning)'
                    : 'var(--accent)'
                  : 'var(--border-strong)',
            }}
          />
        ))
      ) : (
        <span
          className="h-full rounded-full"
          style={{
            width: `${seats > 0 ? Math.min(100, (filled / seats) * 100) : over ? 100 : 0}%`,
            background: over ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      )}
    </div>
  );
}
