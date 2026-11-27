import { describe, expect, it } from 'vitest';
import {
  compressImageForToolOutput,
  createWorkerImageProcessor,
  DEFAULT_READ_IMAGE_LIMITS,
  type NativeImageBackend,
  type NativeImageHandle,
} from './imageProcessor';

function makeMockBackend(options: {
  width: number;
  height: number;
  pngSizeAt?: (w: number, h: number) => number;
  jpgSizeAt?: (w: number, h: number, quality: number) => number;
}): { backend: NativeImageBackend; calls: Array<{ op: string; width: number; height: number; quality?: number }> } {
  const calls: Array<{ op: string; width: number; height: number; quality?: number }> = [];

  const makeHandle = (width: number, height: number): NativeImageHandle => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: nextW, height: nextH }) => {
      calls.push({ op: 'resize', width: nextW, height: nextH });
      return makeHandle(nextW, nextH);
    },
    toPNG: () => {
      calls.push({ op: 'toPNG', width, height });
      const size = options.pngSizeAt ? options.pngSizeAt(width, height) : width * height;
      return Buffer.alloc(size, 0x41);
    },
    toJPEG: (quality: number) => {
      calls.push({ op: 'toJPEG', width, height, quality });
      const size = options.jpgSizeAt ? options.jpgSizeAt(width, height, quality) : Math.round((width * height * quality) / 1000);
      return Buffer.alloc(size, 0x42);
    },
  });

  return {
    backend: {
      createFromBuffer: () => makeHandle(options.width, options.height),
    },
    calls,
  };
}

describe('createWorkerImageProcessor', () => {
  it('尺寸在 1280px 内且 base64 <= 120KB 的小 PNG 原样直通不降质', async () => {
    const { backend, calls } = makeMockBackend({ width: 800, height: 600 });
    const processor = createWorkerImageProcessor({ backend });
    const raw = Buffer.alloc(60 * 1024, 0x01); // base64 = 80KB <= 120KB

    const result = await processor.prepare(raw, 'image/png', DEFAULT_READ_IMAGE_LIMITS);
    expect(result).toBeDefined();
    expect(result?.mimeType).toBe('image/png');
    expect(result?.convertedFrom).toBeUndefined();
    expect(result?.resized).toBeUndefined();
    expect(result?.data).toBe(raw.toString('base64'));
    expect(calls).toHaveLength(0);
  });

  it('1920x1080 大 PNG 缩放到 1280x720 并转为 JPEG，体积显著缩小且附带坐标映射信息', async () => {
    const { backend, calls } = makeMockBackend({
      width: 1920,
      height: 1080,
      pngSizeAt: () => 1_200_000,
      jpgSizeAt: (_w, _h, q) => (q >= 82 ? 120_000 : 80_000),
    });
    const processor = createWorkerImageProcessor({ backend });
    const raw = Buffer.alloc(1_500_000, 0x02);

    const result = await processor.prepare(raw, 'image/png', DEFAULT_READ_IMAGE_LIMITS);
    expect(result).toBeDefined();
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.convertedFrom).toBe('image/png');
    expect(result?.resized).toEqual({
      from: { width: 1920, height: 1080 },
      to: { width: 1280, height: 720 },
    });
    expect(result!.data.length).toBeLessThanOrEqual(240 * 1024);
    expect(calls.some((c) => c.op === 'resize' && c.width === 1280 && c.height === 720)).toBe(true);
  });

  it('超高信息密度图片在质量降档后仍超限时，按 0.75x 阶梯缩小尺寸直到满足预算', async () => {
    const { backend, calls } = makeMockBackend({
      width: 1280,
      height: 720,
      pngSizeAt: () => 900_000,
      // At 1280x720 all qualities exceed 240KB base64 (>180KB raw); once resized below 1000px it fits at quality 72.
      jpgSizeAt: (w, _h, q) => (w >= 1000 ? 220_000 : q >= 82 ? 200_000 : 120_000),
    });
    const processor = createWorkerImageProcessor({ backend });
    const raw = Buffer.alloc(800_000, 0x03);

    const result = await processor.prepare(raw, 'image/png', DEFAULT_READ_IMAGE_LIMITS);
    expect(result).toBeDefined();
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.resized).toEqual({
      from: { width: 1280, height: 720 },
      to: { width: 960, height: 540 },
    });
    expect(calls.some((c) => c.op === 'toJPEG' && c.width === 960 && c.quality === 72)).toBe(true);
  });

  it('无原生图像后端（非 Electron Node 环境）时，支持格式在硬限制内安全透传，不支持格式返回 undefined', async () => {
    const processor = createWorkerImageProcessor({ backend: null });
    const smallPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const inlineRes = await processor.prepare(smallPng, 'image/png', DEFAULT_READ_IMAGE_LIMITS);
    expect(inlineRes).toEqual({
      data: smallPng.toString('base64'),
      mimeType: 'image/png',
    });

    const bmpRes = await processor.prepare(smallPng, 'image/bmp', DEFAULT_READ_IMAGE_LIMITS);
    expect(bmpRes).toBeUndefined();

    const compressed = await compressImageForToolOutput(smallPng, 'image/png', processor);
    expect(compressed).toEqual({
      data: smallPng.toString('base64'),
      mimeType: 'image/png',
    });
  });
});
