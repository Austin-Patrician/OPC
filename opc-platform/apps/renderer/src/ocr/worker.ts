import * as ort from 'onnxruntime-web';
import type { PaddleOcrResult, PaddleOptions } from 'ppu-paddle-ocr/web';
import type { OcrLine, OcrRequest, OcrResponse } from '@opc/shared/ocr';

/**
 * OCR worker. Everything heavy (WASM heap, WebGPU device, model sessions) lives
 * here so neither the app UI nor the main process stalls.
 *
 * Models and the ORT binary are served from the app's own `opc-ocr://` origin by
 * the main process; nothing is fetched from the internet.
 */

const ORIGIN = 'opc-ocr://app';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 12_000;

// Must be set before `ppu-paddle-ocr/web` is imported: that module otherwise
// points ORT at a CDN.
ort.env.wasm.wasmPaths = `${ORIGIN}/ort/`;
// No SharedArrayBuffer in this window (it is not cross-origin isolated).
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

interface OcrEngineService {
  initialize(): Promise<void>;
  recognize(image: ArrayBuffer, options?: { flatten?: false }): Promise<PaddleOcrResult>;
  destroy(): Promise<void>;
  options?: { session?: { executionProviders?: string[] } };
}

let engine: Promise<{ service: OcrEngineService; provider: string }> | null = null;

async function initEngine(): Promise<{ service: OcrEngineService; provider: string }> {
  const { PaddleOcrService } = await import('ppu-paddle-ocr/web');
  const options = {
    model: {
      detection: `${ORIGIN}/models/PP-OCRv5_mobile_det_infer.onnx`,
      recognition: `${ORIGIN}/models/PP-OCRv5_mobile_rec_infer.onnx`,
      charactersDictionary: `${ORIGIN}/models/ppocrv5_dict.txt`,
    },
    recognition: {
      // Drop detector noise (icons, borders) instead of feeding it to recognition.
      minimumConfidence: 0.5,
      // ppu 6.6.1's batched recognition garbles some crops (a whole line reads as
      // "[Tbr", the last character disappears). One crop per inference is exact.
      recBatchSize: 1,
      // Each box on its own: merged lines can join distant columns.
      strategy: 'per-box',
    },
    // Ask for WebGPU explicitly: probing it first is racy on a cold GPU process
    // (the first requestAdapter() can return null). ORT falls back to wasm itself
    // when the WebGPU session cannot be created.
    session: { graphOptimizationLevel: 'all', executionProviders: ['webgpu', 'wasm'] },
  };
  // Their `RecognitionOptions.charactersDictionary` is required in the type but
  // filled from `model.charactersDictionary` during `initialize()`.
  const service = new PaddleOcrService(options as unknown as PaddleOptions) as unknown as OcrEngineService;

  await service.initialize();
  const providers = service.options?.session?.executionProviders ?? [];
  const provider = providers.includes('webgpu') ? 'webgpu' : 'wasm';
  return { service, provider };
}

function engineOrInit(): Promise<{ service: OcrEngineService; provider: string }> {
  engine ??= initEngine().catch((error: unknown) => {
    // Let the next call retry a cold start instead of caching the failure forever.
    engine = null;
    throw error;
  });
  return engine;
}

async function handle(request: OcrRequest): Promise<OcrResponse> {
  const started = Date.now();
  try {
    const { bytes } = request;
    if (bytes.byteLength === 0) throw new Error('图片内容为空');
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`图片过大（${formatBytes(bytes.byteLength)}），单张上限 ${formatBytes(MAX_BYTES)}`);
    }

    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const bitmap = await createImageBitmap(new Blob([buffer]));
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    if (width <= 0 || height <= 0) throw new Error('图片尺寸无效');
    if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
      throw new Error(`图片尺寸过大（${width}×${height}），单边上限 ${MAX_SIDE}px、总像素上限 4000 万`);
    }

    const { service, provider } = await engineOrInit();
    const result = await service.recognize(buffer, { flatten: false });

    const lines: OcrLine[] = result.lines
      .flat()
      .filter((line) => line.text.trim().length > 0)
      .map((line) => ({
        text: line.text,
        box: { x: line.box.x, y: line.box.y, width: line.box.width, height: line.box.height },
        confidence: line.confidence,
      }));

    return {
      id: request.id,
      ok: true,
      result: {
        text: result.text,
        lines,
        confidence: result.confidence,
        width,
        height,
        engine: provider,
        elapsedMs: Date.now() - started,
      },
    };
  } catch (error) {
    return { id: request.id, ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return `OCR 失败：${String(error)}`;
  const message = error.message || error.name;
  if (/out of memory|allocation failed/i.test(message)) return 'OCR 内存不足：图片过大或系统可用内存太低';
  if (/no available backend|webgpu|wasm/i.test(message)) return `OCR 引擎不可用：${message}`;
  return `OCR 失败：${message}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<OcrRequest>) => void): void;
  postMessage(message: OcrResponse): void;
};

scope.addEventListener('message', (event) => {
  void handle(event.data).then((response) => scope.postMessage(response));
});
