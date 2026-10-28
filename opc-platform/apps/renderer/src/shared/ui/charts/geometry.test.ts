import { describe, expect, it } from 'vitest';
import { areaPath, arcPath, donutSlice, linePath, niceMax, polar, scaleY, ticks } from './geometry';

/**
 * The chart arithmetic. A wrong scale or a wrong arc is a lie told in a picture, and a
 * picture is harder to check than a table — so the numbers are asserted here.
 */

describe('polar', () => {
  it('starts at 12 o’clock and runs clockwise', () => {
    const top = polar(50, 50, 10, 0);
    expect(top.x).toBeCloseTo(50);
    expect(top.y).toBeCloseTo(40);

    const right = polar(50, 50, 10, 90);
    expect(right.x).toBeCloseTo(60);
    expect(right.y).toBeCloseTo(50);

    const bottom = polar(50, 50, 10, 180);
    expect(bottom.x).toBeCloseTo(50);
    expect(bottom.y).toBeCloseTo(60);
  });
});

describe('arcPath', () => {
  it('uses the large-arc flag only past half a turn', () => {
    expect(arcPath({ cx: 50, cy: 50, radius: 10, start: 0, end: 90 })).toContain('A 10 10 0 0 1');
    expect(arcPath({ cx: 50, cy: 50, radius: 10, start: 0, end: 270 })).toContain('A 10 10 0 1 1');
  });
});

describe('donutSlice', () => {
  it('draws a normal slice as one arc pair', () => {
    const path = donutSlice({ cx: 50, cy: 50, inner: 20, outer: 30, start: 0, end: 90 });
    expect(path.startsWith('M ')).toBe(true);
    // outer arc, inner edge, inner arc back, close.
    expect(path.match(/A /g)).toHaveLength(2);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('splits a full circle into two halves, because one arc would draw nothing', () => {
    const path = donutSlice({ cx: 50, cy: 50, inner: 20, outer: 30, start: 0, end: 360 });
    // Two arcs for the outer ring, two for the inner cut-out.
    expect(path.match(/A /g)).toHaveLength(4);
  });
});

describe('linePath', () => {
  const points = [
    { x: 0, y: 10 },
    { x: 10, y: 5 },
    { x: 20, y: 8 },
  ];

  it('is a polyline by default', () => {
    expect(linePath(points)).toBe('M 0 10 L 10 5 L 20 8');
  });

  it('becomes cubic segments when smoothed, still through every point', () => {
    const path = linePath(points, true);
    expect(path.startsWith('M 0 10')).toBe(true);
    expect(path.match(/C /g)).toHaveLength(2);
    expect(path.endsWith('20 8')).toBe(true);
  });

  it('handles the degenerate cases without throwing', () => {
    expect(linePath([])).toBe('');
    expect(linePath([{ x: 1, y: 2 }])).toBe('M 1 2');
    expect(linePath([{ x: 1, y: 2 }, { x: 3, y: 4 }], true)).toBe('M 1 2 L 3 4');
  });
});

describe('areaPath', () => {
  it('closes the line against the baseline', () => {
    const path = areaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 5 },
      ],
      20,
    );
    expect(path).toBe('M 0 10 L 10 5 L 10 20 L 0 20 Z');
  });
});

describe('scaleY', () => {
  it('puts the max at the top and zero at the bottom', () => {
    expect(scaleY(0, 10, 100)).toBe(100);
    expect(scaleY(10, 10, 100)).toBe(0);
    expect(scaleY(5, 10, 100)).toBe(50);
  });

  it('clamps negatives to the floor instead of drawing outside the box', () => {
    expect(scaleY(-5, 10, 100)).toBe(100);
  });

  it('does not divide by zero when the series is empty', () => {
    expect(scaleY(3, 0, 100)).toBe(100);
  });
});

describe('niceMax', () => {
  it('rounds up to a number a human would put on an axis', () => {
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.4)).toBe(2);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(12_345)).toBe(20_000);
  });

  it('never returns zero, so the scale is always usable', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe('ticks', () => {
  it('spans zero to the nice max in equal steps', () => {
    expect(ticks(7, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('always includes both ends', () => {
    const values = ticks(1, 2);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
  });
});
