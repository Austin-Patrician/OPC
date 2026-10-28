import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const OCR_MODEL_FILES = {
  detection: 'PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'PP-OCRv5_mobile_rec_infer.onnx',
  dictionary: 'ppocrv5_dict.txt',
} as const;

const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

interface OcrManifest {
  version?: string;
  models?: Record<string, { file?: string; bytes?: number }>;
}

/**
 * Models and the ONNX Runtime WASM binary are downloaded by
 * `scripts/fetch-ocr-assets.mjs` and shipped as `extraResources`, so they sit
 * next to the app rather than inside the asar.
 */
export function resolveOcrAssetsDir(input: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'ocr') : path.join(input.appPath, 'resources', 'ocr');
}

/**
 * Fail before spawning the OCR window, with a message that says what to run.
 * The sizes come from the manifest when it exists; a truncated download is the
 * failure mode that actually happens.
 */
export function assertOcrAssets(root: string): void {
  const missing: string[] = [];
  const manifest = readManifest(root);

  for (const [id, fallback] of Object.entries(OCR_MODEL_FILES)) {
    const file = manifest?.models?.[id]?.file ?? fallback;
    const target = path.join(root, 'models', file);
    if (!existsSync(target)) {
      missing.push(`models/${file}`);
      continue;
    }
    const expected = manifest?.models?.[id]?.bytes;
    if (expected !== undefined && statSync(target).size !== expected) {
      missing.push(`models/${file}（大小不符）`);
    }
  }

  for (const file of ORT_FILES) {
    if (!existsSync(path.join(root, 'ort', file))) missing.push(`ort/${file}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `OCR 资源缺失：${missing.join('、')}。运行 \`pnpm ocr:assets\` 后重试（打包时由 prebuild 自动校验）。`,
    );
  }
}

function readManifest(root: string): OcrManifest | null {
  const file = path.join(root, 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as OcrManifest;
  } catch {
    return null;
  }
}
