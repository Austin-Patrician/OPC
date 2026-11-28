import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  drawNormalizedGridOnBgraBuffer,
  prepareDesktopScreenshot,
  resolveVisualCoordinates,
  type DesktopCaptureFrame,
} from './vision';
import { createWorkerImageProcessor } from '../work/imageProcessor';

describe('desktop visual coordinate mapping', () => {
  const frame: DesktopCaptureFrame = {
    originX: 1512,
    originY: 100,
    width: 1000,
    height: 800,
    scaleFactor: 2,
    app: 'WeChat',
    capturedAt: 1,
  };

  it('converts 0-1000 normalized coordinates to logical screen coordinates', () => {
    expect(resolveVisualCoordinates(frame, { nx: 500, ny: 250 })).toEqual({
      x: 2012,
      y: 300,
    });
  });

  it('clamps out-of-range normalized coordinates cleanly', () => {
    expect(resolveVisualCoordinates(frame, { nx: -40, ny: 1200 })).toEqual({
      x: 1512,
      y: 900,
    });
  });

  it('fails closed when normalized coordinates are passed without a prior screenshot frame', () => {
    const missing = resolveVisualCoordinates(undefined, { nx: 500, ny: 500 });
    expect('error' in missing).toBe(true);
  });

  it('accepts direct logical screen coordinates even without a cached frame', () => {
    expect(resolveVisualCoordinates(undefined, { x: 420.6, y: 815.2 })).toEqual({
      x: 421,
      y: 815,
    });
  });
});

describe('desktop screenshot grid overlay & compression fallback', () => {
  it('draws 10x10 grid lines and labels onto BGRA buffers without overflowing', () => {
    const width = 200;
    const height = 200;
    const buf = new Uint8Array(width * height * 4).fill(255);
    drawNormalizedGridOnBgraBuffer(buf, width, height);

    // Column at 10% (x = 20) should be tinted away from pure white (255,255,255)
    const gridIdx = (100 * width + 20) * 4;
    expect(buf[gridIdx + 2]).toBeLessThan(255);
  });

  it('falls back cleanly via ImageProcessor in non-Electron Node environments', async () => {
    const tinyPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const processor = createWorkerImageProcessor({ backend: null });
    const prepared = await prepareDesktopScreenshot(tinyPng, {
      annotateGrid: true,
      imageProcessor: processor,
    });
    expect(prepared).toEqual({
      data: tinyPng.toString('base64'),
      mimeType: 'image/png',
    });
  });
});
