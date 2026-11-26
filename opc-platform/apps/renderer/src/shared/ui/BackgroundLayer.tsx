import { useEffect, useRef, useState } from 'react';
import type { WallpaperPowerState } from '@opc/shared/domain';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import type { BackgroundPref } from '@/shared/theme/types';
import { AnimatedImageCanvas } from './AnimatedImageCanvas';
import { computeWallpaperPlaybackState, wallpaperAssetUrl } from './wallpaperPlayback';
import { extractWallpaperPosterAndMeta } from './wallpaperPoster';

const DEEP_SUSPEND_RELEASE_MS = 30_000;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const DEFAULT_POWER_STATE: WallpaperPowerState = {
  windowVisible: true,
  windowFocused: true,
  windowMinimized: false,
  systemSuspended: false,
  onBattery: false,
};

/**
 * High-fidelity, low-memory wallpaper stage anchored below the shell:
 * - Static images render directly from `opc-wallpaper://`
 * - GIF / animated WebP decode frame-by-frame via WebCodecs `ImageDecoder`
 * - MP4 / WebM run on hardware video decode with instant poster pre-paint and 30s VRAM release on hide/minimize
 */
export function BackgroundLayer({
  background,
  isOpaqueRoute = false,
}: {
  background: BackgroundPref;
  isOpaqueRoute?: boolean;
}) {
  const asset = background.kind === 'custom' ? background.asset : null;
  const assetFilename = asset?.filename ?? null;
  const [powerState, setPowerState] = useState<WallpaperPowerState>(DEFAULT_POWER_STATE);
  const [documentHidden, setDocumentHidden] = useState(() =>
    typeof document !== 'undefined' ? document.hidden : false,
  );
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(REDUCED_MOTION_QUERY).matches : false,
  );
  const [mediaReady, setMediaReady] = useState(false);
  const [videoReleased, setVideoReleased] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setMediaReady(false);
    setVideoReleased(false);
  }, [assetFilename]);

  // Subscribe to main-process window/power events & document visibility / reduced motion.
  useEffect(() => {
    if (!assetFilename) return undefined;
    const bridge = window.opc?.wallpaper;
    if (bridge) {
      void bridge.getPowerState().then(setPowerState).catch(() => undefined);
    }
    const unsubPower = bridge?.onPowerState(setPowerState);
    const onVisChange = () => setDocumentHidden(document.hidden);
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onMotionChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);

    document.addEventListener('visibilitychange', onVisChange);
    mq.addEventListener('change', onMotionChange);
    return () => {
      unsubPower?.();
      document.removeEventListener('visibilitychange', onVisChange);
      mq.removeEventListener('change', onMotionChange);
    };
  }, [assetFilename]);

  // Lazily extract & cache poster/dimensions once if missing (for existing imports or restart sync).
  useEffect(() => {
    if (!asset) return undefined;
    const needsPoster =
      (asset.mediaKind === 'video' || asset.mediaKind === 'animated-image') && !asset.posterFilename;
    const needsDimensions = !asset.width || !asset.height;
    if (!needsPoster && !needsDimensions) return undefined;

    let canceled = false;
    void extractWallpaperPosterAndMeta(asset)
      .then(async (meta) => {
        if (canceled) return;
        const updated = await window.opc?.wallpaper.savePoster({
          filename: asset.filename,
          dataUrl: meta.dataUrl,
          ...(meta.width !== undefined ? { width: meta.width } : {}),
          ...(meta.height !== undefined ? { height: meta.height } : {}),
          ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
        });
        if (!canceled && updated) {
          useUiPrefs.getState().updateBackground({ asset: updated });
        }
      })
      .catch(() => undefined);

    return () => {
      canceled = true;
    };
  }, [asset]);

  const { paused, deepSuspendEligible } = computeWallpaperPlaybackState({
    powerState,
    documentHidden,
    reducedMotion,
    pauseOnBlur: background.pauseOnBlur,
    isOpaqueRoute,
  });

  // Release GPU video decoder pipeline after 30s hidden/minimized while keeping static poster ready.
  useEffect(() => {
    if (!asset || asset.mediaKind !== 'video') {
      setVideoReleased(false);
      return undefined;
    }
    if (!deepSuspendEligible) {
      setVideoReleased(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setVideoReleased(true);
    }, DEEP_SUSPEND_RELEASE_MS);
    return () => window.clearTimeout(timer);
  }, [asset, deepSuspendEligible]);

  // Keep HTMLVideoElement playback synchronized with pause/resume without remounting on short blurs.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !asset || asset.mediaKind !== 'video' || videoReleased) return;
    if (paused) {
      video.pause();
    } else {
      void video.play().catch(() => undefined);
    }
  }, [asset, paused, videoReleased]);

  if (!asset) return null;

  const assetUrl = wallpaperAssetUrl(asset.filename);
  const posterUrl = asset.posterFilename ? wallpaperAssetUrl(asset.posterFilename) : undefined;
  const mediaScale = background.blurPx > 0 ? '1.03' : '1';

  return (
    <div aria-hidden className="wallpaper-stage pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div
        className="wallpaper-media-frame absolute inset-0"
        style={{ '--wallpaper-scale': mediaScale } as React.CSSProperties}
      >
        {/* Static poster stays underneath so cold start, blur pause, and video teardown have 0ms black flash. */}
        {posterUrl ? (
          <img
            src={posterUrl}
            alt=""
            crossOrigin="anonymous"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        ) : null}

        {asset.mediaKind === 'image' ? (
          <img
            src={assetUrl}
            alt=""
            crossOrigin="anonymous"
            decoding="async"
            onLoad={() => setMediaReady(true)}
            className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${
              mediaReady ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : asset.mediaKind === 'animated-image' ? (
          <AnimatedImageCanvas
            src={assetUrl}
            mimeType={asset.mimeType}
            posterSrc={posterUrl}
            paused={paused}
            onReady={() => setMediaReady(true)}
            className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${
              mediaReady ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : !videoReleased ? (
          <video
            ref={videoRef}
            src={assetUrl}
            poster={posterUrl}
            crossOrigin="anonymous"
            muted
            loop
            playsInline
            autoPlay={!paused}
            disablePictureInPicture
            preload="metadata"
            onCanPlay={() => setMediaReady(true)}
            className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${
              mediaReady ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : null}
      </div>

      {/* Pure optical scrim + subtle top/bottom edge vignette preserving original vibrancy. */}
      <div className="wallpaper-scrim absolute inset-0" />
      <div className="wallpaper-vignette absolute inset-0" />
    </div>
  );
}
