/**
 * Chart geometry, kept pure so the drawings can be tested without a DOM.
 *
 * Every chart in the app is hand-drawn SVG rather than a charting dependency: the
 * renderer runs offline inside Electron, the palette is a set of CSS variables, and a
 * library would fight both. What a library would have given us — scales, arcs, smooth
 * paths — is 120 lines of arithmetic, and arithmetic can be asserted.
 */

export interface Point {
  x: number;
  y: number;
}

/** Angle in degrees, 0 at 12 o'clock, increasing clockwise. */
export function polar(cx: number, cy: number, radius: number, angle: number): Point {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

/** Clockwise arc from `start` to `end` (degrees). */
export function arcPath(input: {
  cx: number;
  cy: number;
  radius: number;
  start: number;
  end: number;
}): string {
  const { cx, cy, radius, start, end } = input;
  const from = polar(cx, cy, radius, start);
  const to = polar(cx, cy, radius, end);
  const largeArc = Math.abs(end - start) > 180 ? 1 : 0;
  return `M ${round(from.x)} ${round(from.y)} A ${radius} ${radius} 0 ${largeArc} 1 ${round(to.x)} ${round(to.y)}`;
}

/**
 * An annulus sector (a donut slice).
 *
 * A single slice covering the full circle cannot be drawn as one arc — its start and
 * end points coincide, so SVG draws nothing. That case is split into two half arcs.
 */
export function donutSlice(input: {
  cx: number;
  cy: number;
  inner: number;
  outer: number;
  start: number;
  end: number;
}): string {
  const { cx, cy, inner, outer, start, end } = input;
  const sweep = Math.abs(end - start);

  if (sweep >= 359.999) {
    const top = polar(cx, cy, outer, 0);
    const bottom = polar(cx, cy, outer, 180);
    const innerTop = polar(cx, cy, inner, 0);
    const innerBottom = polar(cx, cy, inner, 180);
    return [
      `M ${round(top.x)} ${round(top.y)}`,
      `A ${outer} ${outer} 0 1 1 ${round(bottom.x)} ${round(bottom.y)}`,
      `A ${outer} ${outer} 0 1 1 ${round(top.x)} ${round(top.y)}`,
      `M ${round(innerTop.x)} ${round(innerTop.y)}`,
      `A ${inner} ${inner} 0 1 0 ${round(innerBottom.x)} ${round(innerBottom.y)}`,
      `A ${inner} ${inner} 0 1 0 ${round(innerTop.x)} ${round(innerTop.y)}`,
      'Z',
    ].join(' ');
  }

  const outerFrom = polar(cx, cy, outer, start);
  const outerTo = polar(cx, cy, outer, end);
  const innerTo = polar(cx, cy, inner, end);
  const innerFrom = polar(cx, cy, inner, start);
  const largeArc = sweep > 180 ? 1 : 0;

  return [
    `M ${round(outerFrom.x)} ${round(outerFrom.y)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${round(outerTo.x)} ${round(outerTo.y)}`,
    `L ${round(innerTo.x)} ${round(innerTo.y)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${round(innerFrom.x)} ${round(innerFrom.y)}`,
    'Z',
  ].join(' ');
}

/**
 * Polyline through `points`.
 *
 * `smooth` uses a Catmull-Rom conversion, which stays inside the data's own hull — it
 * bends the line but never invents a peak between two samples. Charts that must read as
 * "this is exactly what happened" (a burndown) leave it off.
 */
export function linePath(points: readonly Point[], smooth = false): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
  if (!smooth || points.length === 2) {
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
  }

  let path = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[index + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    path += ` C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(p2.x)} ${round(p2.y)}`;
  }
  return path;
}

/** The same line, closed against `baseline` so it can be filled. */
export function areaPath(points: readonly Point[], baseline: number, smooth = false): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${linePath(points, smooth)} L ${round(last.x)} ${round(baseline)} L ${round(first.x)} ${round(baseline)} Z`;
}

/**
 * Maps a value to a y coordinate, 0 at the top of the box.
 *
 * A flat series (every value equal) is drawn through the middle rather than pinned to
 * the floor: "no change" should look like a line, not like "nothing happened".
 */
export function scaleY(value: number, max: number, height: number): number {
  if (max <= 0) return height;
  return height - (Math.max(0, value) / max) * height;
}

/**
 * A round ceiling for an axis: 1, 2, 2.5 or 5 × 10^n.
 *
 * Charts read better with an axis that ends on a number a human would choose; this is
 * the whole reason not to just use `Math.max(...values)`.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Evenly spaced axis ticks from 0 to `max`, inclusive. */
export function ticks(max: number, count = 4): number[] {
  const top = niceMax(max);
  return Array.from({ length: count + 1 }, (_, index) => (top / count) * index);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
