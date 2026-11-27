import { describe, expect, it } from 'vitest';
import {
  clampPage,
  computeFitZoom,
  computeScaledBox,
  computeVisibleWindow,
  pickActivePage,
} from './slideLayout';

describe('slideLayout helpers', () => {
  it('clamps page targets safely within [1, total]', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
    expect(clampPage(3.9, 5)).toBe(3);
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(4, 0)).toBe(1);
    expect(clampPage(Number.NaN, 5)).toBe(1);
  });

  it('scales 16:9 and 4:3 slides to thumbnail and zoom widths accurately', () => {
    expect(computeScaledBox({ width: 920, height: 517.5 }, 96)).toEqual({
      width: 96,
      height: 54,
      scale: 96 / 920,
    });
    expect(computeScaledBox({ width: 920, height: 690 }, 96)).toEqual({
      width: 96,
      height: 72,
      scale: 96 / 920,
    });
    expect(computeScaledBox({ width: 920, height: 518 }, 920 * 1.5)).toEqual({
      width: 1380,
      height: 777,
      scale: 1.5,
    });
    expect(computeScaledBox({ width: 920, height: 518 }, 920 * 0.5)).toEqual({
      width: 460,
      height: 259,
      scale: 0.5,
    });
  });

  it('computes clamped fit-to-width zoom across narrow and wide viewports', () => {
    expect(computeFitZoom(508, 920)).toBe(0.5);
    expect(computeFitZoom(300, 920)).toBe(0.5);
    expect(computeFitZoom(784, 920)).toBe(0.8);
    expect(computeFitZoom(5000, 920)).toBe(2.5);
    expect(computeFitZoom(48, 920)).toBeNull();
    expect(computeFitZoom(800, 0)).toBeNull();
  });

  it('computes buffered lazy-render windows from intersecting slides', () => {
    expect(computeVisibleWindow([], 5, 2)).toBeNull();
    expect(computeVisibleWindow([1], 5, 2)).toEqual({ start: 1, end: 3 });
    expect(computeVisibleWindow([3, 4], 8, 2)).toEqual({ start: 1, end: 6 });
    expect(computeVisibleWindow([8], 8, 2)).toEqual({ start: 6, end: 8 });
  });

  it('picks the most visible slide and breaks ties in favour of the earlier page', () => {
    expect(pickActivePage(new Map())).toBeNull();
    expect(
      pickActivePage(
        new Map([
          [1, 0.2],
          [2, 0.85],
          [3, 0.15],
        ]),
      ),
    ).toBe(2);
    expect(
      pickActivePage(
        new Map([
          [4, 0.6],
          [3, 0.6],
        ]),
      ),
    ).toBe(3);
  });
});
