import { describe, expect, it } from 'vitest';
import type { BuddyOverlayState } from '@opc/shared/ipc';
import {
  BUDDY_WINDOW_DIMENSIONS,
  computeAnchoredBuddyBounds,
  computeDraggedBuddyBounds,
  computePeekBuddyBounds,
  computeResizedBuddyBounds,
  shouldShowBuddyOverlay,
} from './buddyWindowService';

const PRIMARY_WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };
const SECONDARY_LEFT_WORK_AREA = { x: -1920, y: 0, width: 1920, height: 1080 };

function baseState(overrides: Partial<BuddyOverlayState> = {}): BuddyOverlayState {
  return {
    enabled: true,
    desktopFloat: true,
    alwaysOnTop: true,
    size: 'md',
    dock: 'floating',
    bubbles: true,
    screenPosition: null,
    hidden: false,
    isOnChatPage: true,
    theme: 'light',
    locale: 'zh-CN',
    ...overrides,
  };
}

describe('buddyWindowService layout & visibility helpers', () => {
  it('anchors the bear cleanly at the bottom-right corner of mainWindow', () => {
    const main = { x: 100, y: 80, width: 1200, height: 760 };
    const dims = BUDDY_WINDOW_DIMENSIONS.md;
    const anchored = computeAnchoredBuddyBounds(main, 'md', PRIMARY_WORK_AREA);

    expect(anchored.width).toBe(dims.width);
    expect(anchored.height).toBe(dims.height);
    // Bear right edge inside buddy bounds sits 24px left of mainWindow right edge.
    const bearRight = anchored.x + (dims.width + dims.bearSize) / 2;
    const bearBottom = anchored.y + dims.height - dims.bottomPad;
    expect(bearRight).toBe(main.x + main.width - 24);
    expect(bearBottom).toBe(main.y + main.height - 24);
  });

  it('tracks multi-monitor negative coordinates and preserves exact dimensions during drag', () => {
    const startWin = { x: 80, y: 400, width: 268, height: 288 };
    const dragged = computeDraggedBuddyBounds(
      startWin,
      { x: 200, y: 500 },
      { x: -600, y: 420 },
      'md',
      SECONDARY_LEFT_WORK_AREA,
    );

    expect(dragged).toEqual({
      x: -720,
      y: 320,
      width: 268,
      height: 288,
    });
  });

  it('clamps off-screen drag coordinates so at least 72px of the bear body stays reachable', () => {
    const startWin = { x: 1200, y: 500, width: 268, height: 288 };
    const draggedFarRight = computeDraggedBuddyBounds(
      startWin,
      { x: 1300, y: 600 },
      { x: 2500, y: 1800 },
      'md',
      PRIMARY_WORK_AREA,
    );

    const dims = BUDDY_WINDOW_DIMENSIONS.md;
    const bearLeftX = draggedFarRight.x + (dims.width - dims.bearSize) / 2;
    const bearTopY = draggedFarRight.y + dims.height - dims.bottomPad - dims.bearSize;
    expect(bearLeftX).toBe(PRIMARY_WORK_AREA.x + PRIMARY_WORK_AREA.width - 72);
    expect(bearTopY).toBe(PRIMARY_WORK_AREA.y + PRIMARY_WORK_AREA.height - 72);
  });

  it('positions side-peek flush against the right edge of the work area and preserves vertical anchor on resize', () => {
    const peek = computePeekBuddyBounds(
      { x: 900, y: 420, width: 268, height: 288 },
      'md',
      PRIMARY_WORK_AREA,
    );
    expect(peek.x).toBe(PRIMARY_WORK_AREA.x + PRIMARY_WORK_AREA.width - BUDDY_WINDOW_DIMENSIONS.md.width);

    const resized = computeResizedBuddyBounds(
      { x: 600, y: 400, width: 268, height: 288 },
      'lg',
      PRIMARY_WORK_AREA,
    );
    expect(resized.width).toBe(BUDDY_WINDOW_DIMENSIONS.lg.width);
    expect(resized.height).toBe(BUDDY_WINDOW_DIMENSIONS.lg.height);
    // Bottom-center remains stable (600 + 134 = 734 -> 734 - 144 = 590; 400 + 288 = 688 -> 688 - 328 = 360).
    expect(resized.x).toBe(590);
    expect(resized.y).toBe(360);
  });

  it('controls overlay visibility across welcome-canvas hiding vs dragged-out free float', () => {
    expect(shouldShowBuddyOverlay(null, true)).toBe(false);
    expect(shouldShowBuddyOverlay(baseState({ enabled: false }), true)).toBe(false);
    expect(shouldShowBuddyOverlay(baseState({ desktopFloat: false }), true)).toBe(false);
    expect(shouldShowBuddyOverlay(baseState(), false)).toBe(false);
    expect(shouldShowBuddyOverlay(baseState({ hidden: true, screenPosition: null }), true)).toBe(false);
    expect(shouldShowBuddyOverlay(baseState({ hidden: true, screenPosition: { x: 40, y: 40 } }), true)).toBe(true);
    expect(shouldShowBuddyOverlay(baseState(), true)).toBe(true);
  });
});
