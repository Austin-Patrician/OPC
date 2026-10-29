import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOcrAssets, inspectOcrAssets, inspectOcrRuntime, OCR_MODEL_FILES } from './assets';

/**
 * The shipped OCR assets are the one thing a tool call depends on that the *user*
 * can break (a partial copy, a replaced file). These tests pin the difference
 * between "not downloaded yet" and "the wrong bytes", because the runtime page
 * turns each into a different sentence.
 */

let dir: string;

const DET = Buffer.from('detection-model');
const REC = Buffer.from('recognition-model-which-is-longer');
const DICT = Buffer.from('characters');
const ORT_MJS = Buffer.from('ort-mjs');
const ORT_WASM = Buffer.from('ort-wasm');

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

const manifest = {
  version: 'ppocrv5-mobile',
  models: {
    detection: {
      file: OCR_MODEL_FILES.detection,
      bytes: DET.byteLength,
      sha256: sha(DET),
    },
    recognition: {
      file: OCR_MODEL_FILES.recognition,
      bytes: REC.byteLength,
      sha256: sha(REC),
    },
    dictionary: {
      file: OCR_MODEL_FILES.dictionary,
      bytes: DICT.byteLength,
      sha256: sha(DICT),
    },
  },
  ort: {
    'ort-wasm-simd-threaded.jsep.mjs': sha(ORT_MJS),
    'ort-wasm-simd-threaded.jsep.wasm': sha(ORT_WASM),
  },
};

function makeAssets(overrides: Partial<Record<string, Buffer | null>> = {}): string {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-ocr-'));
  mkdirSync(path.join(dir, 'models'), { recursive: true });
  mkdirSync(path.join(dir, 'ort'), { recursive: true });

  const files: Record<string, Buffer> = {
    [`models/${OCR_MODEL_FILES.detection}`]: DET,
    [`models/${OCR_MODEL_FILES.recognition}`]: REC,
    [`models/${OCR_MODEL_FILES.dictionary}`]: DICT,
    'ort/ort-wasm-simd-threaded.jsep.mjs': ORT_MJS,
    'ort/ort-wasm-simd-threaded.jsep.wasm': ORT_WASM,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const override = overrides[relative];
    if (override === null) continue;
    writeFileSync(path.join(dir, relative), override ?? contents);
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('OCR assets', () => {
  it('reports a complete engine with its version', async () => {
    const root = makeAssets();

    const report = inspectOcrAssets(root);
    expect(report).toEqual({ state: 'ok', missing: [], wrongSize: [] });
    expect(() => assertOcrAssets(root)).not.toThrow();

    // The page hashes on open, without being asked.
    const runtime = await inspectOcrRuntime(root);
    expect(runtime).toMatchObject({
      id: 'ppocrv5',
      name: 'PP-OCRv5',
      version: 'ppocrv5-mobile',
      state: 'ok',
      broken: 0,
    });
  });

  it('names the missing file and the one that is the wrong size', async () => {
    const root = makeAssets({ [`models/${OCR_MODEL_FILES.recognition}`]: null });
    writeFileSync(path.join(root, 'models', OCR_MODEL_FILES.detection), DET.subarray(0, 4));

    const report = inspectOcrAssets(root);
    expect(report.state).toBe('incomplete');
    expect(report.missing).toEqual([`models/${OCR_MODEL_FILES.recognition}`]);
    expect(report.wrongSize).toEqual([`models/${OCR_MODEL_FILES.detection}`]);

    // A re-fetch fixes both, and the message has to say which is which.
    expect(() => assertOcrAssets(root)).toThrow(/缺失 models\/PP-OCRv5_mobile_rec_infer\.onnx/);
    expect(() => assertOcrAssets(root)).toThrow(/大小不符 models\/PP-OCRv5_mobile_det_infer\.onnx/);

    const runtime = await inspectOcrRuntime(root);
    expect(runtime).toMatchObject({ state: 'incomplete', broken: 2 });
  });

  it('catches a same-size file whose bytes changed', async () => {
    const root = makeAssets({ [`models/${OCR_MODEL_FILES.detection}`]: Buffer.alloc(DET.byteLength, 7) });

    // A size check cannot see this; the page's hash pass is the only thing that can.
    expect(inspectOcrAssets(root).state).toBe('ok');
    expect(() => assertOcrAssets(root)).not.toThrow();

    const runtime = await inspectOcrRuntime(root);
    expect(runtime).toMatchObject({ state: 'corrupt', broken: 1 });
  });

  it('falls back to the built-in file list when the manifest is gone', async () => {
    const root = makeAssets();
    rmSync(path.join(root, 'manifest.json'));

    const runtime = await inspectOcrRuntime(root);
    expect(runtime.state).toBe('ok');
    expect(runtime.version).toBe('ppocrv5-mobile');
  });
});
