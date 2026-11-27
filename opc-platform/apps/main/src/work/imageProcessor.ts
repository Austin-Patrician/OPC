import { Buffer } from 'node:buffer';

export interface ImageLimits {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxBytes: number;
}

export interface PreparedImage {
  readonly data: string;
  readonly mimeType: string;
  readonly resized?: {
    readonly from: { readonly width: number; readonly height: number };
    readonly to: { readonly width: number; readonly height: number };
  };
  readonly convertedFrom?: string;
}

export interface ImageProcessor {
  prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
}

export interface NativeImageHandle {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): NativeImageHandle;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

export interface NativeImageBackend {
  createFromBuffer(buffer: Uint8Array): NativeImageHandle;
}

export interface WorkerImageProcessorOptions {
  /** Maximum width/height before scaling down. Default 1280px. */
  maxDimension?: number;
  /** Maximum base64 byte budget for compressed output. Default 240 KiB. */
  maxBase64Bytes?: number;
  /** Threshold under which small crisp inline images pass through untouched. Default 120 KiB base64. */
  passthroughMaxBase64Bytes?: number;
  /** JPEG quality ladder tried in descending order. */
  jpegQualities?: readonly number[];
  /** Minimum dimension floor while stepping down 0.75x. Default 320px. */
  minDimension?: number;
  /** Optional injected backend for deterministic unit testing. */
  backend?: NativeImageBackend | null;
}

export const DEFAULT_READ_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
};

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_MAX_BASE64_BYTES = 240 * 1024;
const DEFAULT_PASSTHROUGH_BASE64_BYTES = 120 * 1024;
const DEFAULT_JPEG_QUALITIES = [82, 72, 60, 48] as const;
const DEFAULT_MIN_DIMENSION = 320;

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function fitDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

let cachedElectronBackend: Promise<NativeImageBackend | null> | null = null;

/** Lazily loads Electron's `nativeImage` inside Electron runtimes and returns null in plain Node/Vitest. */
export async function loadElectronNativeImage(): Promise<NativeImageBackend | null> {
  if (!process.versions.electron) return null;
  if (!cachedElectronBackend) {
    cachedElectronBackend = import('electron')
      .then((mod) => {
        const candidate = (mod as { nativeImage?: NativeImageBackend }).nativeImage;
        return candidate && typeof candidate.createFromBuffer === 'function' ? candidate : null;
      })
      .catch(() => null);
  }
  return cachedElectronBackend;
}

/**
 * Downscales and compresses large screenshots/renders before `read` stores them in
 * `pi-durable` entry history, avoiding multi-megabyte lossless PNG bloat across turns.
 */
export function createWorkerImageProcessor(options: WorkerImageProcessorOptions = {}): ImageProcessor {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxBase64Bytes = options.maxBase64Bytes ?? DEFAULT_MAX_BASE64_BYTES;
  const passthroughMaxBase64Bytes = options.passthroughMaxBase64Bytes ?? DEFAULT_PASSTHROUGH_BASE64_BYTES;
  const jpegQualities = options.jpegQualities ?? DEFAULT_JPEG_QUALITIES;
  const minDimension = options.minDimension ?? DEFAULT_MIN_DIMENSION;

  return {
    async prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> {
      const normalizedMime = mimeType.toLowerCase();
      const inline = INLINE_IMAGE_TYPES.has(normalizedMime);
      const effectiveMaxWidth = Math.max(1, Math.min(limits.maxWidth, maxDimension));
      const effectiveMaxHeight = Math.max(1, Math.min(limits.maxHeight, maxDimension));
      const effectiveMaxBytes = Math.max(1, Math.min(limits.maxBytes, maxBase64Bytes));
      const passthroughCap = Math.min(effectiveMaxBytes, passthroughMaxBase64Bytes);

      const backend =
        options.backend !== undefined ? options.backend : await loadElectronNativeImage();

      if (backend) {
        try {
          const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const image = backend.createFromBuffer(buffer);
          if (!image.isEmpty()) {
            const { width, height } = image.getSize();
            if (width > 0 && height > 0) {
              if (
                inline &&
                width <= effectiveMaxWidth &&
                height <= effectiveMaxHeight &&
                base64Length(bytes.byteLength) <= passthroughCap
              ) {
                return { data: buffer.toString('base64'), mimeType: normalizedMime };
              }

              let target = fitDimensions(width, height, effectiveMaxWidth, effectiveMaxHeight);
              const from = { width, height };

              for (;;) {
                const resized = target.width !== width || target.height !== height;
                const working = resized
                  ? image.resize({ width: target.width, height: target.height, quality: 'good' })
                  : image;

                if (normalizedMime === 'image/png') {
                  const pngBuf = working.toPNG();
                  if (base64Length(pngBuf.byteLength) <= passthroughCap) {
                    return {
                      data: pngBuf.toString('base64'),
                      mimeType: 'image/png',
                      ...(resized ? { resized: { from, to: target } } : {}),
                    };
                  }
                }

                for (const quality of jpegQualities) {
                  const jpgBuf = working.toJPEG(quality);
                  if (base64Length(jpgBuf.byteLength) <= effectiveMaxBytes) {
                    return {
                      data: jpgBuf.toString('base64'),
                      mimeType: 'image/jpeg',
                      ...(normalizedMime !== 'image/jpeg' ? { convertedFrom: normalizedMime } : {}),
                      ...(resized ? { resized: { from, to: target } } : {}),
                    };
                  }
                }

                const canShrinkFurther = target.width > minDimension || target.height > minDimension;
                if (!canShrinkFurther) {
                  return undefined;
                }
                const nextWidth = Math.max(1, Math.floor(target.width * 0.75));
                const nextHeight = Math.max(1, Math.floor(target.height * 0.75));
                if (nextWidth === target.width && nextHeight === target.height) {
                  return undefined;
                }
                target = { width: nextWidth, height: nextHeight };
              }
            }
          }
        } catch {
          // Fall back to passthrough checks when native decoding fails.
        }
      }

      if (inline && base64Length(bytes.byteLength) <= limits.maxBytes) {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { data: buffer.toString('base64'), mimeType: normalizedMime };
      }
      return undefined;
    },
  };
}

/** Compresses raw image bytes for inline tool outputs such as `browser_screenshot`. */
export async function compressImageForToolOutput(
  bytes: Uint8Array,
  mimeType: string,
  processor?: ImageProcessor,
): Promise<{ data: string; mimeType: string } | null> {
  const effectiveProcessor = processor ?? createWorkerImageProcessor();
  const prepared = await effectiveProcessor.prepare(bytes, mimeType, DEFAULT_READ_IMAGE_LIMITS);
  if (!prepared) return null;
  return { data: prepared.data, mimeType: prepared.mimeType };
}
