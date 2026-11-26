import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'opc-doc://pdfjs/pdf.worker.min.mjs';

/** Align PDF points (1/72") to real desktop CSS pixels (1/96"), matching Chrome PDFium 100%. */
const PDF_TO_CSS_UNITS = 96 / 72;
const PAGE_BUFFER = 2;
const THUMB_BUFFER = 4;
const THUMB_CSS_WIDTH = 96;
/** Hard backing-store cap (~64 MB RGBA per page canvas) so zoom never exhausts GPU memory. */
const MAX_PAGE_CANVAS_PIXELS = 16_000_000;

interface PdfPreviewViewerProps {
  docUrl: string;
  zoom: number;
  showThumbnails: boolean;
  fitTrigger: number;
  requestedPage?: { page: number; seq: number } | null;
  onZoomChange?: (nextZoom: number) => void;
  onPageStateChange?: (state: { current: number; total: number } | null) => void;
}

interface PageSize {
  width: number;
  height: number;
}

export default function PdfPreviewViewer({
  docUrl,
  zoom,
  showThumbnails,
  fitTrigger,
  requestedPage,
  onZoomChange,
  onPageStateChange,
}: PdfPreviewViewerProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbScrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const currentPageRef = useRef(1);
  const initialFitAppliedRef = useRef(false);
  const showThumbnailsRef = useRef(showThumbnails);

  useEffect(() => {
    showThumbnailsRef.current = showThumbnails;
  }, [showThumbnails]);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [baseSize, setBaseSize] = useState<PageSize>({ width: 595, height: 842 });
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [visibleWindow, setVisibleWindow] = useState<{ start: number; end: number }>({
    start: 1,
    end: 3,
  });
  const [thumbWindow, setThumbWindow] = useState<{ start: number; end: number }>({
    start: 1,
    end: 10,
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    let alive = true;
    let activeTask: PDFDocumentLoadingTask | null = null;
    let activeDoc: PDFDocumentProxy | null = null;
    initialFitAppliedRef.current = false;

    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setPageSizes({});
    setCurrentPage(1);
    setVisibleWindow({ start: 1, end: 3 });
    setThumbWindow({ start: 1, end: 10 });
    onPageStateChange?.(null);

    const task = pdfjsLib.getDocument({
      url: docUrl,
      cMapUrl: 'opc-doc://pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'opc-doc://pdfjs/standard_fonts/',
      wasmUrl: 'opc-doc://pdfjs/wasm/',
      rangeChunkSize: 65_536,
      useSystemFonts: true,
    });
    activeTask = task;

    void task.promise
      .then(async (doc) => {
        if (!alive) {
          await doc.cleanup(false).catch(() => undefined);
          await task.destroy().catch(() => undefined);
          return;
        }
        activeDoc = doc;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        onPageStateChange?.({ current: 1, total: doc.numPages });

        if (doc.numPages > 0) {
          const firstPage = await doc.getPage(1);
          if (alive) {
            const vp = firstPage.getViewport({ scale: 1 });
            setBaseSize({ width: vp.width, height: vp.height });
            setPageSizes({ 1: { width: vp.width, height: vp.height } });

            // Only scale down wide/landscape documents on initial load so portrait A4 sits at crisp 100%.
            if (!initialFitAppliedRef.current && onZoomChange) {
              initialFitAppliedRef.current = true;
              const containerWidth = scrollRef.current?.clientWidth ?? 0;
              if (containerWidth > 120) {
                const sidebarOffset =
                  showThumbnailsRef.current && !thumbScrollRef.current ? 144 : 0;
                const availWidth = containerWidth - sidebarOffset - 48;
                const naturalCssW = vp.width * PDF_TO_CSS_UNITS;
                if (availWidth > 120 && naturalCssW > availWidth) {
                  const fit = Math.max(0.5, Math.min(1, Number((availWidth / naturalCssW).toFixed(2))));
                  onZoomChange(fit);
                }
              }
            }
          }
          firstPage.cleanup();
        }
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message || t('docPreview.loadFailed'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      setPdfDoc(null);
      onPageStateChange?.(null);
      const docToDestroy = activeDoc;
      const taskToDestroy = activeTask;
      activeDoc = null;
      activeTask = null;
      void (async () => {
        if (docToDestroy) {
          await docToDestroy.cleanup(false).catch(() => undefined);
        }
        if (taskToDestroy) {
          await taskToDestroy.destroy().catch(() => undefined);
        }
      })();
    };
  }, [docUrl, onPageStateChange, onZoomChange, t]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || numPages <= 0) return undefined;

    const visibleSet = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageAttr = entry.target.getAttribute('data-pdf-page');
          const pageNo = pageAttr ? Number(pageAttr) : NaN;
          if (!Number.isFinite(pageNo)) continue;
          if (entry.isIntersecting) visibleSet.add(pageNo);
          else visibleSet.delete(pageNo);
        }
        if (visibleSet.size > 0) {
          const sorted = [...visibleSet].sort((a, b) => a - b);
          const first = sorted[0]!;
          const last = sorted[sorted.length - 1]!;
          setVisibleWindow({
            start: Math.max(1, first - PAGE_BUFFER),
            end: Math.min(numPages, last + PAGE_BUFFER),
          });
          setCurrentPage(first);
          onPageStateChange?.({ current: first, total: numPages });
        }
      },
      { root, rootMargin: '240px 0px', threshold: 0.05 },
    );

    for (const el of pageRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [numPages, onPageStateChange, showThumbnails, zoom]);

  useEffect(() => {
    if (!showThumbnails || numPages <= 0) return undefined;
    const root = thumbScrollRef.current;
    if (!root) return undefined;

    const visibleThumbs = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const attr = entry.target.getAttribute('data-pdf-thumb');
          const pageNo = attr ? Number(attr) : NaN;
          if (!Number.isFinite(pageNo)) continue;
          if (entry.isIntersecting) visibleThumbs.add(pageNo);
          else visibleThumbs.delete(pageNo);
        }
        if (visibleThumbs.size > 0) {
          const sorted = [...visibleThumbs].sort((a, b) => a - b);
          setThumbWindow({
            start: Math.max(1, sorted[0]! - THUMB_BUFFER),
            end: Math.min(numPages, sorted[sorted.length - 1]! + THUMB_BUFFER),
          });
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0.01 },
    );

    for (const el of thumbRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [numPages, showThumbnails]);

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

  const reportPageSize = useCallback((pageNo: number, size: PageSize) => {
    setPageSizes((prev) => {
      const existing = prev[pageNo];
      if (existing && existing.width === size.width && existing.height === size.height) {
        return prev;
      }
      return { ...prev, [pageNo]: size };
    });
  }, []);

  const jumpToPage = useCallback(
    (targetPage: number) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, Math.floor(targetPage)));
      const prev = currentPageRef.current;
      setCurrentPage(clamped);
      onPageStateChange?.({ current: clamped, total: numPages });
      setVisibleWindow({
        start: Math.max(1, clamped - PAGE_BUFFER),
        end: Math.min(numPages, clamped + PAGE_BUFFER),
      });
      const el = pageRefs.current.get(clamped);
      el?.scrollIntoView({
        behavior: Math.abs(clamped - prev) <= 3 ? 'smooth' : 'auto',
        block: 'start',
      });
    },
    [numPages, onPageStateChange],
  );

  useEffect(() => {
    if (!requestedPage || numPages <= 0) return;
    jumpToPage(requestedPage.page);
  }, [jumpToPage, numPages, requestedPage]);

  useEffect(() => {
    if (fitTrigger <= 0 || !onZoomChange || numPages <= 0) return;
    const container = scrollRef.current;
    if (!container || container.clientWidth <= 120) return;
    const activeSize = pageSizes[currentPageRef.current] ?? baseSize;
    const naturalCssW = activeSize.width * PDF_TO_CSS_UNITS;
    if (naturalCssW <= 0) return;
    const nextZoom = Math.max(
      0.5,
      Math.min(2.5, Number(((container.clientWidth - 48) / naturalCssW).toFixed(2))),
    );
    onZoomChange(nextZoom);
  }, [baseSize, fitTrigger, numPages, onZoomChange, pageSizes]);

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, index) => index + 1),
    [numPages],
  );

  return (
    <div className="relative flex h-full min-h-0">
      {showThumbnails && numPages > 0 ? (
        <aside
          ref={thumbScrollRef}
          aria-label={t('docPreview.pageThumbnails')}
          className="flex w-36 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line bg-surface-muted/65 px-2.5 py-3"
        >
          {pageNumbers.map((pageNo) => {
            const active = pageNo === currentPage;
            const size = pageSizes[pageNo] ?? baseSize;
            const thumbHeight = Math.max(64, Math.round((THUMB_CSS_WIDTH * size.height) / Math.max(1, size.width)));
            const inWindow = pageNo >= thumbWindow.start && pageNo <= thumbWindow.end;
            return (
              <button
                key={pageNo}
                type="button"
                data-pdf-thumb={pageNo}
                ref={(el) => registerThumbRef(pageNo, el)}
                onClick={() => jumpToPage(pageNo)}
                aria-current={active ? 'page' : undefined}
                className={`group flex w-full shrink-0 flex-col items-center gap-1.5 rounded-lg p-1.5 transition ${
                  active
                    ? 'bg-accent-soft/60'
                    : 'hover:bg-surface-hover/80'
                }`}
              >
                <div
                  style={{ width: `${THUMB_CSS_WIDTH}px`, height: `${thumbHeight}px` }}
                  className={`flex items-center justify-center overflow-hidden rounded bg-white shadow-sm transition ${
                    active
                      ? 'ring-2 ring-accent'
                      : 'ring-1 ring-black/10 group-hover:ring-black/25'
                  }`}
                >
                  {inWindow && pdfDoc ? (
                    <PdfThumbnailCanvas pdfDoc={pdfDoc} pageNo={pageNo} width={THUMB_CSS_WIDTH} />
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

        {pdfDoc && numPages > 0 ? (
          <div className="mx-auto flex flex-col items-center gap-4">
            {pageNumbers.map((pageNo) => {
              const size = pageSizes[pageNo] ?? baseSize;
              const cssWidth = Math.round(size.width * PDF_TO_CSS_UNITS * zoom);
              const cssHeight = Math.round(size.height * PDF_TO_CSS_UNITS * zoom);
              const active = pageNo >= visibleWindow.start && pageNo <= visibleWindow.end;
              return (
                <div
                  key={pageNo}
                  data-pdf-page={pageNo}
                  ref={(el) => registerPageRef(pageNo, el)}
                  style={{ width: `${cssWidth}px`, minHeight: `${cssHeight}px` }}
                  className="relative shrink-0 overflow-hidden rounded bg-white shadow-card ring-1 ring-black/10"
                >
                  {active ? (
                    <PdfPageCanvas
                      pdfDoc={pdfDoc}
                      pageNo={pageNo}
                      zoom={zoom}
                      onMeasure={reportPageSize}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center font-mono text-[11px] text-neutral-400">
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

function PdfPageCanvas({
  pdfDoc,
  pageNo,
  zoom,
  onMeasure,
}: {
  pdfDoc: PDFDocumentProxy;
  pageNo: number;
  zoom: number;
  onMeasure: (pageNo: number, size: PageSize) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let activePage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;

    void pdfDoc
      .getPage(pageNo)
      .then((page) => {
        if (cancelled) {
          page.cleanup();
          return;
        }
        activePage = page;
        const unitViewport = page.getViewport({ scale: 1 });
        onMeasure(pageNo, { width: unitViewport.width, height: unitViewport.height });

        const cssViewport = page.getViewport({ scale: zoom * PDF_TO_CSS_UNITS });
        const cssWidth = Math.max(1, Math.round(cssViewport.width));
        const cssHeight = Math.max(1, Math.round(cssViewport.height));

        // Maintain >=2x supersampling even on 100%/125%/150% Windows displays with exact ratio
        // alignment so Chromium never applies blurry bilinear resampling to glyph stems.
        const dpr = window.devicePixelRatio || 1;
        const desiredScale = dpr <= 1.5 ? Math.max(2, dpr * 2) : Math.min(3, dpr);
        const maxSafeScale = Math.sqrt(MAX_PAGE_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight));
        const outputScale = Math.max(1, Math.min(desiredScale, maxSafeScale));

        canvas.width = Math.max(1, Math.round(cssWidth * outputScale));
        canvas.height = Math.max(1, Math.round(cssHeight * outputScale));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const scaleX = canvas.width / Math.max(1, cssViewport.width);
        const scaleY = canvas.height / Math.max(1, cssViewport.height);
        const canvasContext = canvas.getContext('2d', { alpha: false }) ?? undefined;

        renderTask = page.render({
          canvas,
          ...(canvasContext ? { canvasContext } : {}),
          viewport: cssViewport,
          transform: [scaleX, 0, 0, scaleY, 0, 0],
          background: '#ffffff',
        });
        return renderTask.promise;
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'name' in error &&
          (error as { name?: string }).name === 'RenderingCancelledException'
        ) {
          return;
        }
        if (!cancelled) {
          console.warn(`[pdf] 第 ${pageNo} 页渲染失败`, error);
        }
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      activePage?.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [onMeasure, pageNo, pdfDoc, zoom]);

  return <canvas ref={canvasRef} className="block bg-white" />;
}

function PdfThumbnailCanvas({
  pdfDoc,
  pageNo,
  width,
}: {
  pdfDoc: PDFDocumentProxy;
  pageNo: number;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void pdfDoc
      .getPage(pageNo)
      .then((page) => {
        if (cancelled) return;
        const unitVp = page.getViewport({ scale: 1 });
        const cssScale = width / Math.max(1, unitVp.width);
        const cssVp = page.getViewport({ scale: cssScale });
        const cssW = Math.max(1, width);
        const cssH = Math.max(1, Math.round(cssVp.height));
        const outputScale = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));

        canvas.width = Math.max(1, Math.round(cssW * outputScale));
        canvas.height = Math.max(1, Math.round(cssH * outputScale));
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const canvasContext = canvas.getContext('2d', { alpha: false }) ?? undefined;
        renderTask = page.render({
          canvas,
          ...(canvasContext ? { canvasContext } : {}),
          viewport: cssVp,
          transform: [
            canvas.width / Math.max(1, cssVp.width),
            0,
            0,
            canvas.height / Math.max(1, cssVp.height),
            0,
            0,
          ],
          background: '#ffffff',
        });
        return renderTask.promise;
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'name' in error &&
          (error as { name?: string }).name === 'RenderingCancelledException'
        ) {
          return;
        }
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [pageNo, pdfDoc, width]);

  return <canvas ref={canvasRef} className="block bg-white" />;
}
