import type { OcrBridge, OcrRequest, OcrResponse } from '@opc/shared/ocr';

/**
 * Host page of the hidden OCR window. It owns the worker (so a crashed engine can
 * be replaced) and relays between the preload bridge and that worker.
 */

declare const window: Window & { opcOcr?: OcrBridge };

const bridge = window.opcOcr;
if (!bridge) throw new Error('OCR preload 未注入');

const inflight = new Set<number>();
let worker = createWorker();

function createWorker(): Worker {
  const instance = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  instance.addEventListener('message', (event: MessageEvent<OcrResponse>) => {
    const response = event.data;
    inflight.delete(response.id);
    bridge?.respond(response);
  });

  instance.addEventListener('error', (event: ErrorEvent) => {
    const message = event.message || 'OCR worker 异常退出';
    for (const id of inflight) bridge?.respond({ id, ok: false, error: message });
    inflight.clear();
    // Next request gets a fresh worker; the WASM heap died with this one.
    instance.terminate();
    worker = createWorker();
  });

  return instance;
}

bridge.onRequest((request: OcrRequest) => {
  inflight.add(request.id);
  worker.postMessage(request);
});

bridge.ready();
