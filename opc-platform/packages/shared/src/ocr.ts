/**
 * OCR runs in a dedicated hidden renderer (WebGPU / WASM), not in the main
 * process: ONNX Runtime's web build has no native binary, so every platform ships
 * the same code and the main process never blocks on inference.
 *
 * These types are the wire format between the main-process tool and that window.
 */

/** `text` keeps reading order only; `lines` keeps per-line boxes and confidence. */
export type OcrDetail = 'text' | 'lines';

/**
 * What the boss decided in 设置 → 运行时. `ocr_image` reads this at call time, so
 * a change applies to the next picture rather than the next restart.
 */
export interface OcrSettings {
  /** Off means `ocr_image` is not installed for anyone. */
  enabled: boolean;
  /** Default shape of the answer; the tool's `detail` argument can override it. */
  detail: OcrDetail;
}

export interface OcrLine {
  text: string;
  /** Bounding box in the original image's pixels. */
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  /** Average recognition confidence (0-1). */
  confidence: number;
  /** Image size, so callers can scale boxes when they resize the picture. */
  width: number;
  height: number;
  /** Which execution provider actually ran: `webgpu` or `wasm`. */
  engine: string;
  elapsedMs: number;
}

export interface OcrRequest {
  id: number;
  /** The encoded image, exactly as read from disk; the page decodes it. */
  bytes: Uint8Array;
}

export type OcrResponse =
  | { id: number; ok: true; result: OcrResult }
  | { id: number; ok: false; error: string };

/** The subset of the OCR window's preload bridge the renderer uses. */
export interface OcrBridge {
  /** Tell main the worker is loaded and can accept requests. */
  ready(): void;
  /** Subscribe to main's requests; returns an unsubscribe function. */
  onRequest(handler: (request: OcrRequest) => void): () => void;
  /** Settle one request. */
  respond(response: OcrResponse): void;
}
