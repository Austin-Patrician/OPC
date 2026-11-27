export interface SlideSize {
  width: number;
  height: number;
}

export interface ScaledSlideBox {
  width: number;
  height: number;
  scale: number;
}

export interface PageWindow {
  start: number;
  end: number;
}

/** Clamps a requested 1-based page number cleanly within `[1, total]`. */
export function clampPage(target: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  const maxPage = Math.max(1, Math.floor(total));
  if (!Number.isFinite(target)) return 1;
  return Math.max(1, Math.min(maxPage, Math.floor(target)));
}

/**
 * Computes CSS dimensions and uniform transform scale for a slide box targeting
 * a specific CSS width while preserving the deck's aspect ratio.
 */
export function computeScaledBox(base: SlideSize, targetWidth: number): ScaledSlideBox {
  const safeBaseWidth = Number.isFinite(base.width) && base.width > 0 ? base.width : 1;
  const safeBaseHeight = Number.isFinite(base.height) && base.height > 0 ? base.height : 1;
  const safeTargetWidth = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth : 1;
  const scale = safeTargetWidth / safeBaseWidth;
  return {
    width: Math.max(1, Math.round(safeTargetWidth)),
    height: Math.max(1, Math.round(safeBaseHeight * scale)),
    scale,
  };
}

/**
 * Computes a 2-decimal fit-to-width zoom factor clamped within `[minZoom, maxZoom]`,
 * returning `null` when either dimension cannot yield a valid positive zoom.
 */
export function computeFitZoom(
  containerWidth: number,
  baseWidth: number,
  options?: {
    minZoom?: number;
    maxZoom?: number;
    horizontalPadding?: number;
  },
): number | null {
  const minZoom = options?.minZoom ?? 0.5;
  const maxZoom = options?.maxZoom ?? 2.5;
  const horizontalPadding = options?.horizontalPadding ?? 48;

  if (!Number.isFinite(containerWidth) || !Number.isFinite(baseWidth) || baseWidth <= 0) {
    return null;
  }
  const availableWidth = containerWidth - horizontalPadding;
  if (availableWidth <= 0) return null;

  const rawZoom = Number((availableWidth / baseWidth).toFixed(2));
  return Math.max(minZoom, Math.min(maxZoom, rawZoom));
}

/**
 * Computes a buffered `[start, end]` lazy-mount range from currently intersecting
 * 1-based page indices, returning `null` when nothing is visible.
 */
export function computeVisibleWindow(
  visiblePages: Iterable<number>,
  totalPages: number,
  buffer: number,
): PageWindow | null {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return null;
  const maxPage = Math.floor(totalPages);
  const safeBuffer = Math.max(0, Math.floor(buffer));

  let min = Infinity;
  let max = -Infinity;
  for (const raw of visiblePages) {
    if (!Number.isFinite(raw)) continue;
    const page = Math.floor(raw);
    if (page < 1 || page > maxPage) continue;
    if (page < min) min = page;
    if (page > max) max = page;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {
    start: Math.max(1, min - safeBuffer),
    end: Math.min(maxPage, max + safeBuffer),
  };
}

/**
 * Picks the 1-based page with the highest visible intersection ratio (> 0),
 * breaking ties in favour of the lowest page number.
 */
export function pickActivePage(ratios: ReadonlyMap<number, number>): number | null {
  let bestPage: number | null = null;
  let bestRatio = 0;

  for (const [page, ratio] of ratios.entries()) {
    if (!Number.isFinite(page) || !Number.isFinite(ratio) || ratio <= 0) continue;
    if (
      bestPage === null ||
      ratio > bestRatio + 1e-6 ||
      (Math.abs(ratio - bestRatio) <= 1e-6 && page < bestPage)
    ) {
      bestPage = page;
      bestRatio = ratio;
    }
  }

  return bestPage;
}
