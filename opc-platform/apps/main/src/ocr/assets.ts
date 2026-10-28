import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BundledAsset, BundledRuntime } from '@opc/shared/domain';

export const OCR_MODEL_FILES = {
  detection: 'PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'PP-OCRv5_mobile_rec_infer.onnx',
  dictionary: 'ppocrv5_dict.txt',
} as const;

const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

interface OcrManifest {
  version?: string;
  models?: Record<string, { file?: string; bytes?: number; sha256?: string }>;
  /** ONNX Runtime binaries; the fetch script pins hashes but no sizes. */
  ort?: Record<string, string>;
}

/** One file the engine needs, with whatever the manifest promises about it. */
interface Expectation {
  id: string;
  file: string;
  expectedBytes?: number;
  sha256?: string;
}

/**
 * Models and the ONNX Runtime WASM binary are downloaded by
 * `scripts/fetch-ocr-assets.mjs` and shipped as `extraResources`, so they sit
 * next to the app rather than inside the asar.
 */
export function resolveOcrAssetsDir(input: {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  return input.packaged
    ? path.join(input.resourcesPath, 'ocr')
    : path.join(input.appPath, 'resources', 'ocr');
}

/**
 * Fail before spawning the OCR window, with a message that says what to run.
 *
 * Deliberately the cheap check (existence + size): this runs on every
 * `ocr_image` call. Hashing the models belongs to the settings page, which is where
 * a boss can actually see which file is wrong.
 */
export function assertOcrAssets(root: string): void {
  const broken = inspectOcrAssets(root).assets.filter(
    (asset) => asset.state === 'missing' || asset.state === 'size',
  );
  if (broken.length === 0) return;

  const detail = broken
    .map((asset) => (asset.state === 'size' ? `${asset.file}（大小不符）` : asset.file))
    .join('、');
  throw new Error(
    `OCR 资源缺失：${detail}。运行 \`pnpm ocr:assets\` 后重试（打包时由 prebuild 自动校验）；已安装的应用请在「设置 → 运行时 → 内置引擎」查看详情。`,
  );
}

/** The asset list as the disk reports it: no hashing, no window. */
export function inspectOcrAssets(root: string): {
  assets: BundledAsset[];
  bytes: number;
  state: BundledRuntime['state'];
} {
  const assets = expectationsOf(root).map((expectation) => statAsset(root, expectation));
  return {
    assets,
    bytes: assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0),
    state: stateOf(assets),
  };
}

/**
 * The runtime page's view of the OCR engine.
 *
 * `verify` hashes every file against the manifest, which is the only way to
 * catch a model that was replaced or corrupted without changing size — the
 * failure a plain size check cannot see.
 */
export async function inspectOcrRuntime(input: {
  root: string;
  warm: boolean;
  verify?: boolean;
}): Promise<BundledRuntime> {
  const manifest = readManifest(input.root);
  const assets: BundledAsset[] = [];

  for (const expectation of expectationsOf(input.root)) {
    const asset = statAsset(input.root, expectation);
    if (input.verify && asset.state === 'ok' && expectation.sha256) {
      const digest = await sha256Of(path.join(input.root, expectation.file));
      if (digest !== expectation.sha256) asset.state = 'corrupt';
    }
    assets.push(asset);
  }

  return {
    id: 'ppocrv5',
    name: 'PP-OCRv5',
    engine: 'onnxruntime-web · WASM/WebGPU',
    version: manifest?.version ?? 'ppocrv5-mobile',
    root: input.root,
    bytes: assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0),
    state: stateOf(assets),
    verified: input.verify === true,
    checkedAt: Date.now(),
    extension: 'opc.ocr',
    tool: 'ocr_image',
    warm: input.warm,
    assets,
  };
}

/** Every file the manifest (or the built-in fallback) says the engine needs. */
function expectationsOf(root: string): Expectation[] {
  const manifest = readManifest(root);
  const list: Expectation[] = [];

  for (const [id, fallback] of Object.entries(OCR_MODEL_FILES)) {
    const entry = manifest?.models?.[id];
    list.push({
      id: `model:${id}`,
      file: path.posix.join('models', entry?.file ?? fallback),
      ...(entry?.bytes !== undefined ? { expectedBytes: entry.bytes } : {}),
      ...(entry?.sha256 ? { sha256: entry.sha256 } : {}),
    });
  }

  const ort = manifest?.ort;
  for (const file of ort ? Object.keys(ort) : ORT_FILES) {
    const sha256 = ort?.[file];
    list.push({
      id: `ort:${file}`,
      file: path.posix.join('ort', file),
      ...(sha256 ? { sha256 } : {}),
    });
  }

  return list;
}

function statAsset(root: string, expectation: Expectation): BundledAsset {
  const target = path.join(root, expectation.file);
  if (!existsSync(target)) return { id: expectation.id, file: expectation.file, state: 'missing' };

  const bytes = statSync(target).size;
  const mismatch =
    expectation.expectedBytes !== undefined && bytes !== expectation.expectedBytes;
  return {
    id: expectation.id,
    file: expectation.file,
    bytes,
    ...(expectation.expectedBytes !== undefined ? { expectedBytes: expectation.expectedBytes } : {}),
    state: mismatch ? 'size' : 'ok',
  };
}

function stateOf(assets: readonly BundledAsset[]): BundledRuntime['state'] {
  // Truncated downloads (missing / wrong size) are fixed by fetching again;
  // a file of the right size with the wrong bytes is a different problem.
  if (assets.some((asset) => asset.state === 'missing' || asset.state === 'size')) {
    return 'incomplete';
  }
  if (assets.some((asset) => asset.state === 'corrupt')) return 'corrupt';
  return 'ok';
}

async function sha256Of(file: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    // Unreadable is indistinguishable from wrong, and the row already says missing.
    return '';
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
