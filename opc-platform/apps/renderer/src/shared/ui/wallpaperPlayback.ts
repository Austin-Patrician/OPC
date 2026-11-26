import type { WallpaperPowerState } from '@opc/shared/domain';

export const WALLPAPER_SCHEME = 'opc-wallpaper';
export const WALLPAPER_ORIGIN = `${WALLPAPER_SCHEME}://asset`;

export function wallpaperAssetUrl(filename: string): string {
  return `${WALLPAPER_ORIGIN}/${encodeURIComponent(filename)}`;
}

export interface WallpaperPlaybackInput {
  powerState: WallpaperPowerState;
  documentHidden: boolean;
  reducedMotion: boolean;
  pauseOnBlur: boolean;
  isOpaqueRoute: boolean;
}

export interface WallpaperPlaybackDecision {
  paused: boolean;
  deepSuspendEligible: boolean;
}

/**
 * Pure decision function for zero-waste animated/video wallpaper scheduling:
 * pauses decoding on blur (configurable), minimize, hide, lock/sleep, hidden tab,
 * reduced-motion preference, or opaque routes without visible wallpaper stage.
 */
export function computeWallpaperPlaybackState(
  input: WallpaperPlaybackInput,
): WallpaperPlaybackDecision {
  const { powerState, documentHidden, reducedMotion, pauseOnBlur, isOpaqueRoute } = input;
  const deepSuspendEligible =
    powerState.systemSuspended ||
    powerState.windowMinimized ||
    !powerState.windowVisible ||
    documentHidden;

  const paused =
    deepSuspendEligible ||
    reducedMotion ||
    isOpaqueRoute ||
    (pauseOnBlur && !powerState.windowFocused);

  return { paused, deepSuspendEligible };
}
