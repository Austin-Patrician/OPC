import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { init } from 'pptx-preview';
import type PPTXPreviewer from 'pptx-preview/dist/previewer';
import { useTranslation } from 'react-i18next';
import {
  applySlideDomFixes,
  normalizeParsedPptx,
  type PptxLike,
  type PptxSlideLike,
} from '../model/pptxNormalizer';
import {
  clampPage,
  computeFitZoom,
  computeScaledBox,
  computeVisibleWindow,
  pickActivePage,
  type SlideSize,
} from '../model/slideLayout';

interface PptxPreviewViewerProps {
  docUrl: string;
  zoom: number;
  showThumbnails: boolean;
  fitTrigger: number;
  requestedPage?: { page: number; seq: number } | null;
  onZoomChange?: (nextZoom: number) => void;
  onPageStateChange?: (state: { current: number; total: number } | null) => void;
}

const DEFAULT_STAGE_WIDTH = 920;
const DEFAULT_STAGE_HEIGHT = 518;
const PAGE_BUFFER = 2;
const THUMB_BUFFER = 4;
const THUMB_CSS_WIDTH = 96;
const SIDEBAR_WIDTH_PX = 144;
const MANUAL_JUMP_LOCK_MS = 450;

const SLIDE_FONT_FAMILY =
  "'Microsoft YaHei', 'PingFang SC', 'SimSun', 'Noto Sans SC Variable', 'Inter Variable', sans-serif";

/**
 * Renders a single parsed slide into an arbitrary DOM container without invoking
 * `PPTXPreviewer.renderSingleSlide()`, so module-global `removeSlide` cleanup
 * events never tear down thumbnails or adjacent slides.
 */
function renderSlideInto(
  viewer: PPTXPreviewer,
  slideIndex: number,
  container: HTMLElement,
): void {
  container.replaceChildren();
  const htmlRender = viewer.htmlRender;
  const prevWrapper = htmlRender.wrapper;
  htmlRender.wrapper = container;
  try {
    htmlRender.renderSlide(slideIndex);
  } finally {
    htmlRender.wrapper = prevWrapper;
  }
  const slideEl = container.firstElementChild as HTMLElement | null;
  if (slideEl) {
    slideEl.style.margin = '0';
    slideEl.style.position = 'relative';
    slideEl.style.top = '0';
    const slideModel = viewer.pptx?.slides?.[slideIndex] as unknown as PptxSlideLike | undefined;
    applySlideDomFixes(slideModel, slideEl);
  }
}

export default function PptxPreviewViewer({
  docUrl,
  zoom,
  showThumbnails,
  fitTrigger,
  requestedPage,
  onZoomChange,
  onPageStateChange,
}: PptxPreviewViewerProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbScrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const ratiosRef = useRef<Map<number, number>>(new Map());
  const currentPageRef = useRef(1);
  const manualJumpLockUntilRef = useRef(0);
  const initialFitAppliedRef = useRef(false);
  const showThumbnailsRef = useRef(showThumbnails);

  useEffect(() => {
    showThumbnailsRef.current = showThumbnails;
  }, [showThumbnails]);

  const [viewer, setViewer] = useState<PPTXPreviewer | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [baseSize, setBaseSize] = useState<SlideSize>({
    width: DEFAULT_STAGE_WIDTH,
    height: DEFAULT_STAGE_HEIGHT,
  });
  const [visibleWindow, setVisibleWindow] = useState<{ start: number; end: number }>({
    start: 1,
    end: 4,
  });
  const [thumbWindow, setThumbWindow] = useState<{ start: number; end: number }>({
    start: 1,
    end: 12,
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    const controller = new AbortController();
    const scratchHost = document.createElement('div');
    let alive = true;
    let instance: PPTXPreviewer;

    initialFitAppliedRef.current = false;
    ratiosRef.current.clear();
    manualJumpLockUntilRef.current = 0;

    setLoading(true);
    setError(null);
    setViewer(null);
    setSlideCount(0);
    setBaseSize({ width: DEFAULT_STAGE_WIDTH, height: DEFAULT_STAGE_HEIGHT });
    setCurrentPage(1);
    setVisibleWindow({ start: 1, end: 4 });
    setThumbWindow({ start: 1, end: 12 });
    onPageStateChange?.(null);

    try {
      instance = init(scratchHost, { width: DEFAULT_STAGE_WIDTH, mode: 'list' });
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message || t('docPreview.loadFailed'));
      setLoading(false);
      return undefined;
    }

    const activeInstance = instance;

    void fetch(docUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (buffer) => {
        if (!alive) return;
        await activeInstance.load(buffer);
        if (!alive) return;

        normalizeParsedPptx(activeInstance.pptx as unknown as PptxLike);

        const port = activeInstance.htmlRender?.renderPort;
        const deckWidth =
          port?.width && port.width > 0
            ? port.width
            : activeInstance.pptx?.width > 0
              ? activeInstance.pptx.width
              : DEFAULT_STAGE_WIDTH;
        const deckHeight =
          port?.height && port.height > 0
            ? port.height
            : activeInstance.pptx?.height > 0 && activeInstance.pptx?.width > 0
              ? (deckWidth * activeInstance.pptx.height) / activeInstance.pptx.width
              : DEFAULT_STAGE_HEIGHT;
        const count = activeInstance.slideCount || 0;

        setBaseSize({ width: deckWidth, height: deckHeight });
        setViewer(activeInstance);
        setSlideCount(count);
        setCurrentPage(1);
        setVisibleWindow({ start: 1, end: Math.min(Math.max(1, count), 4) });
        setThumbWindow({ start: 1, end: Math.min(Math.max(1, count), 12) });

        if (count > 0) {
          onPageStateChange?.({ current: 1, total: count });

          if (!initialFitAppliedRef.current && onZoomChange) {
            initialFitAppliedRef.current = true;
            const containerWidth = scrollRef.current?.clientWidth ?? 0;
            if (containerWidth > 120) {
              const sidebarOffset =
                showThumbnailsRef.current && !thumbScrollRef.current ? SIDEBAR_WIDTH_PX : 0;
              const fit = computeFitZoom(containerWidth - sidebarOffset, deckWidth, {
                minZoom: 0.5,
                maxZoom: 1,
              });
              if (fit !== null && fit < 1) {
                onZoomChange(fit);
              }
            }
          }
        }
      })
      .catch((caught: unknown) => {
        if (!alive || controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message || t('docPreview.loadFailed'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
      setViewer(null);
      onPageStateChange?.(null);
      try {
        activeInstance.destroy();
      } catch {
        // Ignore teardown errors from partial loads.
      }
      scratchHost.replaceChildren();
    };
  }, [docUrl, onPageStateChange, onZoomChange, t]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || slideCount <= 0) return undefined;

    ratiosRef.current.clear();
    const visibleSet = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageAttr = entry.target.getAttribute('data-pptx-page');
          const pageNo = pageAttr ? Number(pageAttr) : NaN;
          if (!Number.isFinite(pageNo)) continue;
          if (entry.isIntersecting) {
            visibleSet.add(pageNo);
            ratiosRef.current.set(pageNo, entry.intersectionRatio);
          } else {
            visibleSet.delete(pageNo);
            ratiosRef.current.delete(pageNo);
          }
        }

        const nextWindow = computeVisibleWindow(visibleSet, slideCount, PAGE_BUFFER);
        if (nextWindow) {
          setVisibleWindow(nextWindow);
        }

        if (performance.now() >= manualJumpLockUntilRef.current) {
          const active = pickActivePage(ratiosRef.current);
          if (active !== null && active !== currentPageRef.current) {
            setCurrentPage(active);
            onPageStateChange?.({ current: active, total: slideCount });
          }
        }
      },
      { root, rootMargin: '240px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    for (const el of pageRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [onPageStateChange, showThumbnails, slideCount, zoom]);

  useEffect(() => {
    if (!showThumbnails || slideCount <= 0) return undefined;
    const root = thumbScrollRef.current;
    if (!root) return undefined;

    const visibleThumbs = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const attr = entry.target.getAttribute('data-pptx-thumb');
          const pageNo = attr ? Number(attr) : NaN;
          if (!Number.isFinite(pageNo)) continue;
          if (entry.isIntersecting) visibleThumbs.add(pageNo);
          else visibleThumbs.delete(pageNo);
        }
        const nextWindow = computeVisibleWindow(visibleThumbs, slideCount, THUMB_BUFFER);
        if (nextWindow) {
          setThumbWindow(nextWindow);
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0.01 },
    );

    for (const el of thumbRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [showThumbnails, slideCount]);

  useEffect(() => {
    if (!showThumbnails) return;
    thumbRefs.current.get(currentPage)?.scrollIntoView({ block: 'nearest' });
  }, [currentPage, showThumbnails]);

  const registerPageRef = useCallback((pageNo: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNo, el);
    else pageRefs.current.delete(pageNo);
  }, []);

  const registerThumbRef = useCallback((pageNo: number, el: HTMLButtonElement | null) => {
    if (el) thumbRefs.current.set(pageNo, el);
    else thumbRefs.current.delete(pageNo);
  }, []);

  const jumpToPage = useCallback(
    (targetPage: number) => {
      if (slideCount <= 0) return;
      const clamped = clampPage(targetPage, slideCount);
      const prev = currentPageRef.current;
      manualJumpLockUntilRef.current = performance.now() + MANUAL_JUMP_LOCK_MS;
      setCurrentPage(clamped);
      onPageStateChange?.({ current: clamped, total: slideCount });
      setVisibleWindow({
        start: Math.max(1, clamped - PAGE_BUFFER),
        end: Math.min(slideCount, clamped + PAGE_BUFFER),
      });
      const el = pageRefs.current.get(clamped);
      el?.scrollIntoView({
        behavior: Math.abs(clamped - prev) <= 3 ? 'smooth' : 'auto',
        block: 'start',
      });
    },
    [onPageStateChange, slideCount],
  );

  useEffect(() => {
    if (!requestedPage || slideCount <= 0) return;
    jumpToPage(requestedPage.page);
  }, [jumpToPage, requestedPage, slideCount]);

  useEffect(() => {
    if (fitTrigger <= 0 || !onZoomChange || slideCount <= 0) return;
    const container = scrollRef.current;
    if (!container || container.clientWidth <= 120) return;
    const nextZoom = computeFitZoom(container.clientWidth, baseSize.width);
    if (nextZoom !== null) {
      onZoomChange(nextZoom);
    }
  }, [baseSize.width, fitTrigger, onZoomChange, slideCount]);

  useEffect(() => {
    if (slideCount <= 1) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        jumpToPage(currentPageRef.current - 1);
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        jumpToPage(currentPageRef.current + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [jumpToPage, slideCount]);

  const pageNumbers = useMemo(
    () => Array.from({ length: slideCount }, (_, index) => index + 1),
    [slideCount],
  );
  const thumbBox = useMemo(() => computeScaledBox(baseSize, THUMB_CSS_WIDTH), [baseSize]);
  const slideBox = useMemo(
    () => computeScaledBox(baseSize, baseSize.width * zoom),
    [baseSize, zoom],
  );

  return (
    <div className="relative flex h-full min-h-0">
      {showThumbnails && slideCount > 0 ? (
        <aside
          ref={thumbScrollRef}
          aria-label={t('docPreview.pageThumbnails')}
          className="flex w-36 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line bg-surface-muted/65 px-2.5 py-3"
        >
          {pageNumbers.map((pageNo) => {
            const active = pageNo === currentPage;
            const inWindow = pageNo >= thumbWindow.start && pageNo <= thumbWindow.end;
            return (
              <button
                key={pageNo}
                type="button"
                data-pptx-thumb={pageNo}
                ref={(el) => registerThumbRef(pageNo, el)}
                onClick={() => jumpToPage(pageNo)}
                aria-current={active ? 'page' : undefined}
                className={`group flex w-full shrink-0 flex-col items-center gap-1.5 rounded-lg p-1.5 transition ${
                  active ? 'bg-accent-soft/60' : 'hover:bg-surface-hover/80'
                }`}
              >
                <div
                  style={{ width: `${thumbBox.width}px`, height: `${thumbBox.height}px` }}
                  className={`flex items-center justify-center overflow-hidden rounded bg-white shadow-sm transition ${
                    active
                      ? 'ring-2 ring-accent'
                      : 'ring-1 ring-black/10 group-hover:ring-black/25'
                  }`}
                >
                  {inWindow && viewer ? (
                    <PptxSlideFrame
                      viewer={viewer}
                      slideIndex={pageNo - 1}
                      baseSize={baseSize}
                      targetWidth={THUMB_CSS_WIDTH}
                      interactive={false}
                    />
                  ) : (
                    <span className="font-mono text-[10px] text-neutral-400">{pageNo}</span>
                  )}
                </div>
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    active ? 'font-semibold text-accent-ink' : 'text-ink-tertiary'
                  }`}
                >
                  {pageNo}
                </span>
              </button>
            );
          })}
        </aside>
      ) : null}

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-surface-muted/75 px-5 py-5"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-tertiary">
            <LoaderCircle size={16} className="animate-spin" />
            <span>{t('docPreview.loading')}</span>
          </div>
        ) : null}

        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-danger">
            {error}
          </div>
        ) : null}

        {viewer && slideCount > 0 ? (
          <div className="mx-auto flex flex-col items-center gap-4 pb-8">
            {pageNumbers.map((pageNo) => {
              const active = pageNo >= visibleWindow.start && pageNo <= visibleWindow.end;
              return (
                <div
                  key={pageNo}
                  data-pptx-page={pageNo}
                  ref={(el) => registerPageRef(pageNo, el)}
                  style={{
                    width: `${slideBox.width}px`,
                    height: `${slideBox.height}px`,
                  }}
                  className="relative shrink-0 overflow-hidden rounded bg-white shadow-card ring-1 ring-black/10"
                >
                  {active ? (
                    <PptxSlideFrame
                      viewer={viewer}
                      slideIndex={pageNo - 1}
                      baseSize={baseSize}
                      targetWidth={baseSize.width * zoom}
                      interactive
                    />
                  ) : (
                    <div
                      style={{ height: `${slideBox.height}px` }}
                      className="flex w-full items-center justify-center font-mono text-[11px] text-neutral-400"
                    >
                      {pageNo}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PptxSlideFrame({
  viewer,
  slideIndex,
  baseSize,
  targetWidth,
  interactive,
}: {
  viewer: PPTXPreviewer;
  slideIndex: number;
  baseSize: SlideSize;
  targetWidth: number;
  interactive: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scaled = computeScaledBox(baseSize, targetWidth);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    try {
      renderSlideInto(viewer, slideIndex, host);
    } catch (caught) {
      console.warn(`[pptx] 第 ${slideIndex + 1} 页渲染失败`, caught);
    }

    return () => {
      host.replaceChildren();
    };
  }, [slideIndex, viewer]);

  return (
    <div
      aria-hidden={interactive ? undefined : true}
      style={{
        width: `${scaled.width}px`,
        height: `${scaled.height}px`,
      }}
      className={`relative overflow-hidden bg-white text-neutral-900 subpixel-antialiased ${
        interactive ? 'select-text' : 'pointer-events-none select-none'
      }`}
    >
      <div
        ref={hostRef}
        style={{
          width: `${baseSize.width}px`,
          height: `${baseSize.height}px`,
          transform: `scale(${scaled.scale})`,
          transformOrigin: 'top left',
          WebkitFontSmoothing: 'subpixel-antialiased',
          fontFamily: SLIDE_FONT_FAMILY,
        }}
      />
    </div>
  );
}
