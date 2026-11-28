import { Buffer } from 'node:buffer';
import {
  compressImageForToolOutput,
  createWorkerImageProcessor,
  loadElectronNativeImage,
  type ImageProcessor,
  type NativeImageHandle,
} from '../work/imageProcessor';

export interface DesktopCaptureFrame {
  originX: number;
  originY: number;
  width: number;
  height: number;
  scaleFactor: number;
  app?: string;
  windowId?: string;
  capturedAt: number;
}

export interface VisualPointInput {
  nx?: number;
  ny?: number;
  x?: number;
  y?: number;
}

const MAX_GRID_IMAGE_BYTES = 240 * 1024;
const JPEG_QUALITIES = [80, 70, 58, 46] as const;

/** Tiny 3x5 bitmap glyphs for crisp grid labels (`0`-`9`) without native font deps. */
const DIGIT_FONT_3X5: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1000, value));
}

/**
 * Resolves either normalized `[0..1000]` coordinates relative to the last screenshot frame
 * or explicit logical screen coordinates `(x, y)` into OS logical pixel coordinates.
 */
export function resolveVisualCoordinates(
  frame: DesktopCaptureFrame | undefined,
  input: VisualPointInput,
): { x: number; y: number } | { error: string } {
  const hasNormalized =
    typeof input.nx === 'number' &&
    Number.isFinite(input.nx) &&
    typeof input.ny === 'number' &&
    Number.isFinite(input.ny);

  if (hasNormalized) {
    if (!frame || frame.width <= 0 || frame.height <= 0) {
      return {
        error: '缺少可用的桌面截图坐标系，请先调用 desktop_screenshot 再使用 nx/ny 归一化坐标。',
      };
    }
    const nx = clampNormalized(input.nx!);
    const ny = clampNormalized(input.ny!);
    return {
      x: Math.round(frame.originX + (nx / 1000) * frame.width),
      y: Math.round(frame.originY + (ny / 1000) * frame.height),
    };
  }

  if (
    typeof input.x === 'number' &&
    Number.isFinite(input.x) &&
    typeof input.y === 'number' &&
    Number.isFinite(input.y)
  ) {
    return {
      x: Math.round(input.x),
      y: Math.round(input.y),
    };
  }

  return { error: '请提供归一化坐标 (nx, ny: 0-1000) 或屏幕逻辑坐标 (x, y)。' };
}

function blendPixelBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  px: number,
  py: number,
  b: number,
  g: number,
  r: number,
  alpha: number,
): void {
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const idx = (py * width + px) * 4;
  if (idx + 3 >= bgra.length) return;
  const inv = 1 - alpha;
  bgra[idx] = Math.round(bgra[idx]! * inv + b * alpha);
  bgra[idx + 1] = Math.round(bgra[idx + 1]! * inv + g * alpha);
  bgra[idx + 2] = Math.round(bgra[idx + 2]! * inv + r * alpha);
  bgra[idx + 3] = 255;
}

function fillRectBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  b: number,
  g: number,
  r: number,
  alpha: number,
): void {
  const xStart = Math.max(0, rx);
  const yStart = Math.max(0, ry);
  const xEnd = Math.min(width, rx + rw);
  const yEnd = Math.min(height, ry + rh);
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      blendPixelBgra(bgra, width, height, x, y, b, g, r, alpha);
    }
  }
}

function drawLabelPillBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  text: string,
): void {
  const scale = 2;
  const charW = 3 * scale;
  const charH = 5 * scale;
  const gap = 2;
  const padX = 4;
  const padY = 3;
  const textW = text.length * charW + Math.max(0, text.length - 1) * gap;
  const boxW = textW + padX * 2;
  const boxH = charH + padY * 2;
  const boxX = Math.max(2, Math.min(width - boxW - 2, anchorX));
  const boxY = Math.max(2, Math.min(height - boxH - 2, anchorY));

  fillRectBgra(bgra, width, height, boxX, boxY, boxW, boxH, 24, 24, 24, 0.78);

  let cursorX = boxX + padX;
  const cursorY = boxY + padY;
  for (const ch of text) {
    const rows = DIGIT_FONT_3X5[ch];
    if (rows) {
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
        const row = rows[rowIdx]!;
        for (let colIdx = 0; colIdx < row.length; colIdx += 1) {
          if (row[colIdx] === '1') {
            fillRectBgra(
              bgra,
              width,
              height,
              cursorX + colIdx * scale,
              cursorY + rowIdx * scale,
              scale,
              scale,
              255,
              255,
              255,
              0.96,
            );
          }
        }
      }
    }
    cursorX += charW + gap;
  }
}

/**
 * Draws a 10x10 normalized `0..1000` coordinate grid and edge tick labels directly
 * onto an uncompressed BGRA bitmap buffer.
 */
export function drawNormalizedGridOnBgraBuffer(
  bgra: Uint8Array,
  width: number,
  height: number,
): void {
  if (width < 40 || height < 40 || bgra.length < width * height * 4) return;

  for (let step = 1; step < 10; step += 1) {
    const unit = step * 100;
    const label = String(unit);
    const gx = Math.round((step / 10) * width);
    const gy = Math.round((step / 10) * height);

    // Subtle alternating blue-accent line for grid columns/rows
    for (let y = 0; y < height; y += 1) {
      blendPixelBgra(bgra, width, height, gx, y, 245, 130, 55, 0.42);
    }
    for (let x = 0; x < width; x += 1) {
      blendPixelBgra(bgra, width, height, x, gy, 245, 130, 55, 0.42);
    }

    drawLabelPillBgra(bgra, width, height, gx + 3, 4, label);
    drawLabelPillBgra(bgra, width, height, 4, gy + 3, label);
  }
}

interface ElectronBitmapHandle extends NativeImageHandle {
  toBitmap?(): Buffer;
}

interface ElectronBitmapBackend {
  createFromBuffer(buffer: Uint8Array): ElectronBitmapHandle;
  createFromBitmap?(buffer: Buffer, options: { width: number; height: number }): ElectronBitmapHandle;
}

function base64Size(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * Compresses a desktop screenshot PNG into a compact JPEG/PNG for multimodal models,
 * optionally drawing a `0-1000` normalized coordinate grid when Electron `nativeImage` bitmap APIs exist.
 */
export async function prepareDesktopScreenshot(
  pngBytes: Uint8Array,
  options: { annotateGrid?: boolean; imageProcessor?: ImageProcessor } = {},
): Promise<{ data: string; mimeType: string; imageWidth?: number; imageHeight?: number } | null> {
  const annotateGrid = options.annotateGrid !== false;
  const processor = options.imageProcessor ?? createWorkerImageProcessor();

  if (annotateGrid) {
    const backend = (await loadElectronNativeImage()) as ElectronBitmapBackend | null;
    if (backend && typeof backend.createFromBitmap === 'function') {
      try {
        const buffer = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
        const source = backend.createFromBuffer(buffer);
        if (!source.isEmpty()) {
          const orig = source.getSize();
          if (orig.width > 0 && orig.height > 0) {
            const scale = Math.min(1, 1280 / orig.width, 1280 / orig.height);
            const targetW = Math.max(1, Math.round(orig.width * scale));
            const targetH = Math.max(1, Math.round(orig.height * scale));
            const resized =
              targetW !== orig.width || targetH !== orig.height
                ? (source.resize({ width: targetW, height: targetH, quality: 'good' }) as ElectronBitmapHandle)
                : source;

            if (typeof resized.toBitmap === 'function') {
              const bitmap = Buffer.from(resized.toBitmap());
              const size = resized.getSize();
              drawNormalizedGridOnBgraBuffer(bitmap, size.width, size.height);
              const annotated = backend.createFromBitmap(bitmap, {
                width: size.width,
                height: size.height,
              });
              for (const quality of JPEG_QUALITIES) {
                const jpeg = annotated.toJPEG(quality);
                if (base64Size(jpeg.byteLength) <= MAX_GRID_IMAGE_BYTES) {
                  return {
                    data: jpeg.toString('base64'),
                    mimeType: 'image/jpeg',
                    imageWidth: size.width,
                    imageHeight: size.height,
                  };
                }
              }
            }
          }
        }
      } catch {
        // Fall through to standard image compression fallback below.
      }
    }
  }

  const compressed = await compressImageForToolOutput(pngBytes, 'image/png', processor);
  if (!compressed) return null;
  return compressed;
}
