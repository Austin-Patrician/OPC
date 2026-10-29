import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BundledRuntime } from '@opc/shared/domain';

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
  file: string;
  expectedBytes?: number;
  sha256?: string;
}

/** What a cheap (no hashing) look at the asset directory found. */
export interface OcrAssetReport {
  state: 'ok' | 'incomplete';
  /** Relative paths, split by what would fix them. */
  missing: string[];
  wrongSize: string[];
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
 * `ocr_image` call. Hashing the models belongs to the settings page, which is
 * where a boss can actually see that something is wrong.
 */
export function assertOcrAssets(root: string): void {
  const report = inspectOcrAssets(root);
  const parts: string[] = [];
  if (report.missing.length > 0) parts.push(`缺失 ${report.missing.join('、')}`);
  if (report.wrongSize.length > 0) parts.push(`大小不符 ${report.wrongSize.join('、')}`);
  if (parts.length === 0) return;

  throw new Error(
    `OCR 资源不完整：${parts.join('；')}。运行 \`pnpm ocr:assets\` 后重试（打包时由 prebuild 自动校验）；已安装的应用请重新安装以恢复资源。`,
  );
}

/** The cheap check the tool uses on every call: no hashing, no window. */
export function inspectOcrAssets(root: string): OcrAssetReport {
  const missing: string[] = [];
  const wrongSize: string[] = [];
  for (const expectation of expectationsOf(root)) {
    const problem = checkAsset(root, expectation);
    if (problem === 'missing') missing.push(expectation.file);
    if (problem === 'size') wrongSize.push(expectation.file);
  }
  return { state: missing.length + wrongSize.length > 0 ? 'incomplete' : 'ok', missing, wrongSize };
}

/**
 * The runtime page's view: the same check, plus one hash pass.
 *
 * The hash is the only way to catch a model that was replaced without changing
 * size — the failure a plain size check cannot see. It is not a per-call cost:
 * this runs when 设置 → 运行时 opens.
 */
export async function inspectOcrRuntime(root: string): Promise<BundledRuntime> {
  const manifest = readManifest(root);
  let broken = 0;
  let missing = false;

  for (const expectation of expectationsOf(root)) {
    if (checkAsset(root, expectation)) {
      broken += 1;
      missing = true;
      continue;
    }
    if (expectation.sha256) {
      const digest = await sha256Of(path.join(root, expectation.file));
      if (digest !== expectation.sha256) broken += 1;
    }
  }

  return {
    id: 'ppocrv5',
    name: 'PP-OCRv5',
    engine: 'onnxruntime-web · WASM/WebGPU',
    version: manifest?.version ?? 'ppocrv5-mobile',
    // A wrong size means "fetch it again"; wrong bytes of the right size is a
    // different repair, and the page says so.
    state: broken === 0 ? 'ok' : missing ? 'incomplete' : 'corrupt',
    broken,
  };
}

/** Every file the manifest (or the built-in fallback) says the engine needs. */
function expectationsOf(root: string): Expectation[] {
  const manifest = readManifest(root);
  const list: Expectation[] = [];

  for (const [id, fallback] of Object.entries(OCR_MODEL_FILES)) {
    const entry = manifest?.models?.[id];
    list.push({
      file: path.posix.join('models', entry?.file ?? fallback),
      ...(entry?.bytes !== undefined ? { expectedBytes: entry.bytes } : {}),
      ...(entry?.sha256 ? { sha256: entry.sha256 } : {}),
    });
  }

  const ort = manifest?.ort;
  for (const file of ort ? Object.keys(ort) : ORT_FILES) {
    const sha256 = ort?.[file];
    list.push({
      file: path.posix.join('ort', file),
      ...(sha256 ? { sha256 } : {}),
    });
  }

  return list;
}

/** `null` when the file is there at the promised size. */
function checkAsset(root: string, expectation: Expectation): 'missing' | 'size' | null {
  const target = path.join(root, expectation.file);
  if (!existsSync(target)) return 'missing';
  const bytes = statSync(target).size;
  if (expectation.expectedBytes !== undefined && bytes !== expectation.expectedBytes) {
    return 'size';
  }
  return null;
}

async function sha256Of(file: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    // Unreadable is indistinguishable from wrong; it has already failed the size check.
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
