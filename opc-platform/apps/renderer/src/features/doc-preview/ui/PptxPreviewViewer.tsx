import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { init } from 'pptx-preview';
import type PPTXPreviewer from 'pptx-preview/dist/previewer';
import { useTranslation } from 'react-i18next';

interface PptxPreviewViewerProps {
  docUrl: string;
  requestedPage?: { page: number; seq: number } | null;
  onPageStateChange?: (state: { current: number; total: number } | null) => void;
}

const DEFAULT_STAGE_WIDTH = 920;
const DEFAULT_STAGE_HEIGHT = 540;

export default function PptxPreviewViewer({
  docUrl,
  requestedPage,
  onPageStateChange,
}: PptxPreviewViewerProps) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PPTXPreviewer | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;

    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);
    setSlideCount(0);
    setSlideIndex(0);
    onPageStateChange?.(null);
    stage.replaceChildren();

    const width = Math.max(480, Math.min(DEFAULT_STAGE_WIDTH, (stage.parentElement?.clientWidth ?? 960) - 48));
    const height = Math.round((width * 9) / 16) || DEFAULT_STAGE_HEIGHT;
    const viewer = init(stage, { width, height, mode: 'slide' });
    viewer.wrapper.style.background = 'transparent';
    viewerRef.current = viewer;

    void fetch(docUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (buffer) => {
        if (!alive) return;
        await viewer.load(buffer);
        if (!alive) return;
        const count = viewer.slideCount || 0;
        setSlideCount(count);
        if (count > 0) {
          viewer.renderSingleSlide(0);
          setSlideIndex(0);
          onPageStateChange?.({ current: 1, total: count });
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
      viewerRef.current = null;
      onPageStateChange?.(null);
      try {
        viewer.destroy();
      } catch {
        // Ignore teardown errors from partial loads.
      }
      stage.replaceChildren();
    };
  }, [docUrl, onPageStateChange, t]);

  const goToSlide = useCallback(
    (nextIndex: number) => {
      const viewer = viewerRef.current;
      if (!viewer || slideCount <= 0) return;
      const clamped = Math.max(0, Math.min(slideCount - 1, nextIndex));
      viewer.renderSingleSlide(clamped);
      setSlideIndex(clamped);
      onPageStateChange?.({ current: clamped + 1, total: slideCount });
    },
    [onPageStateChange, slideCount],
  );

  useEffect(() => {
    if (!requestedPage || slideCount <= 0) return;
    goToSlide(requestedPage.page - 1);
  }, [goToSlide, requestedPage, slideCount]);

  useEffect(() => {
    if (slideCount <= 1) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToSlide(slideIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToSlide(slideIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goToSlide, slideCount, slideIndex]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-muted/80">
      <div className="relative min-h-0 flex-1 overflow-auto p-5">
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

        <div
          ref={stageRef}
          className="mx-auto flex subpixel-antialiased items-center justify-center text-neutral-900 [&_.pptx-preview-slide-wrapper]:rounded-md [&_.pptx-preview-slide-wrapper]:shadow-popover [&_.pptx-preview-slide-wrapper]:ring-1 [&_.pptx-preview-slide-wrapper]:ring-black/15"
          style={{
            WebkitFontSmoothing: 'subpixel-antialiased',
            fontFamily:
              "'Microsoft YaHei', 'PingFang SC', 'SimSun', 'Noto Sans SC Variable', 'Inter Variable', sans-serif",
          }}
        />
      </div>
    </div>
  );
}
