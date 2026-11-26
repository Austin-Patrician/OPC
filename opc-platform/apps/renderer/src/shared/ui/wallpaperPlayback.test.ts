import type { WallpaperPowerState } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { computeWallpaperPlaybackState, wallpaperAssetUrl } from './wallpaperPlayback';

const activePower: WallpaperPowerState = {
  windowVisible: true,
  windowFocused: true,
  windowMinimized: false,
  systemSuspended: false,
  onBattery: false,
};

describe('wallpaperPlayback', () => {
  it('生成安全的定制协议 URL', () => {
    expect(wallpaperAssetUrl('wp-abc.mp4')).toBe('opc-wallpaper://asset/wp-abc.mp4');
  });

  it('在正常前台且处于可见路由时保持播放', () => {
    expect(
      computeWallpaperPlaybackState({
        powerState: activePower,
        documentHidden: false,
        reducedMotion: false,
        pauseOnBlur: true,
        isOpaqueRoute: false,
      }),
    ).toEqual({ paused: false, deepSuspendEligible: false });
  });

  it('在失焦（pauseOnBlur=true）、切到非背景路由或开启减少动效时暂停解码而不强制释放视频', () => {
    expect(
      computeWallpaperPlaybackState({
        powerState: { ...activePower, windowFocused: false },
        documentHidden: false,
        reducedMotion: false,
        pauseOnBlur: true,
        isOpaqueRoute: false,
      }),
    ).toEqual({ paused: true, deepSuspendEligible: false });

    expect(
      computeWallpaperPlaybackState({
        powerState: { ...activePower, windowFocused: false },
        documentHidden: false,
        reducedMotion: false,
        pauseOnBlur: false,
        isOpaqueRoute: false,
      }),
    ).toEqual({ paused: false, deepSuspendEligible: false });

    expect(
      computeWallpaperPlaybackState({
        powerState: activePower,
        documentHidden: false,
        reducedMotion: true,
        pauseOnBlur: false,
        isOpaqueRoute: false,
      }),
    ).toEqual({ paused: true, deepSuspendEligible: false });

    expect(
      computeWallpaperPlaybackState({
        powerState: activePower,
        documentHidden: false,
        reducedMotion: false,
        pauseOnBlur: false,
        isOpaqueRoute: true,
      }),
    ).toEqual({ paused: true, deepSuspendEligible: false });
  });

  it('在最小化、隐藏窗口、页面隐藏或系统休眠时触发深度休眠标记（支持 30s 释放显存）', () => {
    for (const patch of [
      { windowMinimized: true },
      { windowVisible: false },
      { systemSuspended: true },
    ]) {
      expect(
        computeWallpaperPlaybackState({
          powerState: { ...activePower, ...patch },
          documentHidden: false,
          reducedMotion: false,
          pauseOnBlur: false,
          isOpaqueRoute: false,
        }),
      ).toEqual({ paused: true, deepSuspendEligible: true });
    }

    expect(
      computeWallpaperPlaybackState({
        powerState: activePower,
        documentHidden: true,
        reducedMotion: false,
        pauseOnBlur: false,
        isOpaqueRoute: false,
      }),
    ).toEqual({ paused: true, deepSuspendEligible: true });
  });
});
