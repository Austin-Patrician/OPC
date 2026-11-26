import { useEffect, useRef, useState } from 'react';

interface DecodedFrameLike {
  displayWidth: number;
  displayHeight: number;
  /** Duration in microseconds when provided by container metadata. */
  duration?: number | null;
  close(): void;
}

interface ImageDecoderLike {
  readonly tracks: {
    selectedTrack?: { frameCount?: number } | null;
  };
  decode(options?: { frameIndex?: number }): Promise<{ image: DecodedFrameLike }>;
  close(): void;
}

interface ImageDecoderCtorLike {
  new (init: {
    data: ReadableStream<Uint8Array>;
    type: string;
    preferAnimation?: boolean;
  }): ImageDecoderLike;
}

function getImageDecoderCtor(): ImageDecoderCtorLike | null {
  const candidate = (globalThis as { ImageDecoder?: unknown }).ImageDecoder;
  return typeof candidate === 'function' ? (candidate as ImageDecoderCtorLike) : null;
}

function computeBackingDimensions(naturalWidth: number, naturalHeight: number): { w: number; h: number } {
  const viewportCap =
    typeof window !== 'undefined'
      ? Math.min(2560, Math.max(1280, Math.ceil(window.innerWidth * Math.min(window.devicePixelRatio || 1, 2))))
      : 1920;
  if (naturalWidth <= viewportCap) {
    return { w: Math.max(1, naturalWidth), h: Math.max(1, naturalHeight) };
  }
  const ratio = viewportCap / naturalWidth;
  return {
    w: viewportCap,
    h: Math.max(1, Math.round(naturalHeight * ratio)),
  };
}

/**
 * High-fidelity streaming animated GIF / WebP player built on WebCodecs `ImageDecoder`.
 * Each decoded frame is drawn directly to `<canvas>` and immediately released via
 * `frame.close()`, keeping resident memory bounded to 1-2 frames instead of buffering
 * hundreds of decompressed RGBA bitmaps in `<img>`.
 */
export function AnimatedImageCanvas({
  src,
  mimeType,
  posterSrc,
  paused,
  className = '',
  onReady,
}: {
  src: string;
  mimeType: string;
  posterSrc?: string;
  paused: boolean;
  className?: string;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const resumeLoopRef = useRef<(() => void) | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [fallbackToImg, setFallbackToImg] = useState(false);

  useEffect(() => {
    setFallbackToImg(false);
    const DecoderCtor = getImageDecoderCtor();
    if (!DecoderCtor) {
      setFallbackToImg(true);
      return undefined;
    }

    const abort = new AbortController();
    let decoder: ImageDecoderLike | null = null;
    let timerId: number | null = null;
    let rafId: number | null = null;
    let canceled = false;
    let frameIndex = 0;
    let scheduled = false;

    const clearTimers = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      scheduled = false;
    };

    const drawFrame = (frame: DecodedFrameLike): boolean => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return false;
      }
      const { w, h } = computeBackingDimensions(frame.displayWidth, frame.displayHeight);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        frame.close();
        return false;
      }
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
      frame.close();
      return true;
    };

    const scheduleNext = (delayMs: number) => {
      if (canceled || pausedRef.current || !decoder || scheduled) return;
      const trackCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (trackCount === 1) return;
      scheduled = true;
      timerId = window.setTimeout(() => {
        timerId = null;
        if (canceled || pausedRef.current) {
          scheduled = false;
          return;
        }
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          scheduled = false;
          void advanceFrame();
        });
      }, delayMs);
    };

    const advanceFrame = async () => {
      if (canceled || !decoder || pausedRef.current) return;
      const trackCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
      const nextIndex = trackCount > 0 ? (frameIndex + 1) % trackCount : frameIndex + 1;
      try {
        const decoded = await decoder.decode({ frameIndex: nextIndex });
        if (canceled) {
          decoded.image.close();
          return;
        }
        frameIndex = nextIndex;
        const durationMs =
          typeof decoded.image.duration === 'number' && decoded.image.duration > 0
            ? Math.max(20, Math.round(decoded.image.duration / 1000))
            : 80;
        drawFrame(decoded.image);
        scheduleNext(durationMs);
      } catch (err) {
        if (canceled) return;
        if (err instanceof RangeError && nextIndex > 0) {
          frameIndex = 0;
          try {
            const wrapped = await decoder.decode({ frameIndex: 0 });
            if (canceled) {
              wrapped.image.close();
              return;
            }
            const durationMs =
              typeof wrapped.image.duration === 'number' && wrapped.image.duration > 0
                ? Math.max(20, Math.round(wrapped.image.duration / 1000))
                : 80;
            drawFrame(wrapped.image);
            scheduleNext(durationMs);
            return;
          } catch {
            // Fall through to img fallback if even frame 0 cannot re-decode.
          }
        }
        if ((err as { name?: string })?.name !== 'AbortError') {
          setFallbackToImg(true);
        }
      }
    };

    resumeLoopRef.current = () => {
      scheduleNext(40);
    };

    void (async () => {
      try {
        const response = await fetch(src, { signal: abort.signal });
        if (!response.ok || !response.body) {
          if (!canceled) setFallbackToImg(true);
          return;
        }
        decoder = new DecoderCtor({
          data: response.body,
          type: mimeType,
          preferAnimation: true,
        });
        const first = await decoder.decode({ frameIndex: 0 });
        if (canceled) {
          first.image.close();
          return;
        }
        const firstDelay =
          typeof first.image.duration === 'number' && first.image.duration > 0
            ? Math.max(20, Math.round(first.image.duration / 1000))
            : 80;
        drawFrame(first.image);
        onReadyRef.current?.();
        if (!pausedRef.current) {
          scheduleNext(firstDelay);
        }
      } catch (err) {
        if (!canceled && (err as { name?: string })?.name !== 'AbortError') {
          setFallbackToImg(true);
        }
      }
    })();

    return () => {
      canceled = true;
      resumeLoopRef.current = null;
      clearTimers();
      abort.abort();
      try {
        decoder?.close();
      } catch {
        // Ignore close errors after abort.
      }
      decoder = null;
    };
  }, [mimeType, src]);

  useEffect(() => {
    if (!paused) {
      resumeLoopRef.current?.();
    }
  }, [paused]);

  if (fallbackToImg) {
    return (
      <img
        src={paused && posterSrc ? posterSrc : src}
        alt=""
        decoding="async"
        onLoad={() => onReadyRef.current?.()}
        className={className}
      />
    );
  }

  return <canvas ref={canvasRef} className={className} />;
}
