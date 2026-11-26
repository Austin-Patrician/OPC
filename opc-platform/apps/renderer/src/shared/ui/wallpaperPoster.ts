import type { WallpaperAsset } from '@opc/shared/domain';
import { wallpaperAssetUrl } from './wallpaperPlayback';

export interface ExtractedWallpaperMeta {
  dataUrl: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

const MAX_POSTER_WIDTH = 1280;
const VIDEO_PROBE_TIMEOUT_MS = 8000;

function canvasToPosterDataUrl(
  source: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
): string {
  const scale = naturalWidth > MAX_POSTER_WIDTH ? MAX_POSTER_WIDTH / naturalWidth : 1;
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return '';
  ctx.drawImage(source, 0, 0, width, height);
  const webp = canvas.toDataURL('image/webp', 0.86);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.86);
}

function loadStaticImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败，文件可能已损坏或格式不兼容。'));
    img.src = url;
  });
}

function probeVideoFirstFrame(url: string): Promise<ExtractedWallpaperMeta> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const timer = window.setTimeout(() => {
      fail('视频解码超时，请尝试常用的 H.264 MP4 或 VP9 WebM 编码。');
    }, VIDEO_PROBE_TIMEOUT_MS);

    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => {
      fail('当前视频编码不受内核支持或文件已损坏（建议使用 H.264 MP4 或 VP9 WebM）。');
    };
    video.onloadeddata = () => {
      if (settled) return;
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        fail('未能读取到有效的视频画面尺寸。');
        return;
      }
      try {
        const dataUrl = canvasToPosterDataUrl(video, video.videoWidth, video.videoHeight);
        const durationSec =
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
        settled = true;
        const result: ExtractedWallpaperMeta = {
          dataUrl,
          width: video.videoWidth,
          height: video.videoHeight,
          ...(durationSec !== undefined ? { durationSec } : {}),
        };
        cleanup();
        resolve(result);
      } catch {
        fail('无法截取视频首帧预览图。');
      }
    };
    video.src = url;
  });
}

/**
 * Extracts original dimensions, duration (for video), and a compact WebP first-frame
 * poster so cold starts & deep power suspends stay instant and zero-flicker.
 */
export async function extractWallpaperPosterAndMeta(
  asset: WallpaperAsset,
): Promise<ExtractedWallpaperMeta> {
  const url = wallpaperAssetUrl(asset.filename);
  if (asset.mediaKind === 'video') {
    return probeVideoFirstFrame(url);
  }
  const img = await loadStaticImage(url);
  if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
    throw new Error('未能读取图片尺寸。');
  }
  let dataUrl = '';
  if (asset.mediaKind === 'animated-image') {
    try {
      dataUrl = canvasToPosterDataUrl(img, img.naturalWidth, img.naturalHeight);
    } catch {
      // Keep decoded dimensions even if poster export is unavailable in this environment.
      dataUrl = '';
    }
  }
  return {
    dataUrl,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}
