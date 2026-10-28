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
 * shows exactly that distinction.
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
  it('reports a complete runtime, and hashes only when asked', async () => {
    const root = makeAssets();

    const sized = await inspectOcrRuntime({ root, warm: false });
    expect(sized.state).toBe('ok');
    expect(sized.verified).toBe(false);
    expect(sized.assets).toHaveLength(5);
    expect(sized.bytes).toBe(DET.byteLength + REC.byteLength + DICT.byteLength + ORT_MJS.byteLength + ORT_WASM.byteLength);

    const hashed = await inspectOcrRuntime({ root, warm: true, verify: true });
    expect(hashed.state).toBe('ok');
    expect(hashed.verified).toBe(true);
    expect(hashed.warm).toBe(true);
    expect(hashed.assets.every((asset) => asset.state === 'ok')).toBe(true);
    expect(hashed.tool).toBe('ocr_image');
    expect(hashed.extension).toBe('opc.ocr');
  });

  it('tells a missing file apart from a truncated one', async () => {
    const root = makeAssets({ [`models/${OCR_MODEL_FILES.recognition}`]: null });

    const missing = inspectOcrAssets(root);
    expect(missing.state).toBe('incomplete');
    expect(missing.assets.find((asset) => asset.file.endsWith(OCR_MODEL_FILES.recognition))?.state).toBe(
      'missing',
    );
    expect(() => assertOcrAssets(root)).toThrow(/PP-OCRv5_mobile_rec_infer\.onnx/);

    rmSync(path.join(root, 'models', OCR_MODEL_FILES.recognition), { force: true });
    writeFileSync(path.join(root, 'models', OCR_MODEL_FILES.recognition), REC.subarray(0, 4));

    const truncated = inspectOcrAssets(root);
    expect(truncated.state).toBe('incomplete');
    expect(
      truncated.assets.find((asset) => asset.file.endsWith(OCR_MODEL_FILES.recognition)),
    ).toMatchObject({ state: 'size', expectedBytes: REC.byteLength, bytes: 4 });
    // The message must say *why*, not just which file.
    expect(() => assertOcrAssets(root)).toThrow(/大小不符/);
  });

  it('catches a same-size file whose bytes changed, only with verify', async () => {
    const root = makeAssets({ [`models/${OCR_MODEL_FILES.detection}`]: Buffer.alloc(DET.byteLength, 7) });

    // A size check cannot see this: that is the whole reason the button exists.
    expect(inspectOcrAssets(root).state).toBe('ok');
    expect(() => assertOcrAssets(root)).not.toThrow();

    const verified = await inspectOcrRuntime({ root, warm: false, verify: true });
    expect(verified.state).toBe('corrupt');
    expect(
      verified.assets.find((asset) => asset.file.endsWith(OCR_MODEL_FILES.detection))?.state,
    ).toBe('corrupt');
  });

  it('falls back to the built-in file list when the manifest is gone', async () => {
    const root = makeAssets();
    rmSync(path.join(root, 'manifest.json'));

    const runtime = await inspectOcrRuntime({ root, warm: false });
    expect(runtime.state).toBe('ok');
    expect(runtime.version).toBe('ppocrv5-mobile');
    expect(runtime.assets.map((asset) => asset.file)).toContain(
      `models/${OCR_MODEL_FILES.detection}`,
    );
  });
});
