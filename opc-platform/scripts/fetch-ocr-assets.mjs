#!/usr/bin/env node
/**
 * OCR assets are data, not source: the ONNX models are ~21 MB and the ONNX
 * Runtime WebAssembly binary is ~23 MB. They are downloaded once into
 * `resources/ocr/` (git-ignored) and shipped through electron-builder's
 * `extraResources`, so the packaged app never touches the network to recognise
 * an image.
 *
 *   node scripts/fetch-ocr-assets.mjs          # download/copy what is missing
 *   node scripts/fetch-ocr-assets.mjs --check  # verify only, exit 1 when incomplete
 *
 * Download failures are reported but exit 0 by default: `postinstall` must not
 * break an offline install. `pnpm build` runs `--check`, so a missing model is
 * caught before packaging instead of at the first OCR call.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ocrRoot = join(root, 'resources', 'ocr');
const modelsDir = join(ocrRoot, 'models');
const ortDir = join(ocrRoot, 'ort');
const manifestPath = join(ocrRoot, 'manifest.json');

const MODEL_VERSION = 'ppocrv5-mobile';

/** PP-OCRv5 mobile: Chinese + English + Japanese in one recognition model. */
const MODELS = [
  {
    id: 'detection',
    file: 'PP-OCRv5_mobile_det_infer.onnx',
    bytes: 4748769,
    sha256: 'd7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924',
    path: 'detection/PP-OCRv5_mobile_det_infer.onnx',
  },
  {
    id: 'recognition',
    file: 'PP-OCRv5_mobile_rec_infer.onnx',
    bytes: 16559278,
    sha256: 'd253c3cbee6e507828a5271a30ab0ec8ae7c2a99d0cc8e6f844fe380809d22b3',
    path: 'recognition/PP-OCRv5_mobile_rec_infer.onnx',
  },
  {
    id: 'dictionary',
    file: 'ppocrv5_dict.txt',
    bytes: 74014,
    sha256: '9dfc80c50b6cb07399a47a7cf25d11db475fb4ad0e1fc96b2eff6467c8166ff3',
    path: 'recognition/ppocrv5_dict.txt',
  },
];

/** Mirrors from the same repository; the second one is used when the first fails. */
const MODEL_BASES = [
  'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main',
  'https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/raw/main',
];

/** Must match the peer dependency range of `ppu-paddle-ocr`. */
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

const checkOnly = process.argv.includes('--check');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function matches(file, expected) {
  return existsSync(file) && statSync(file).size === expected.bytes && sha256(file) === expected.sha256;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const temp = `${target}.part`;
  writeFileSync(temp, buffer);
  renameSync(temp, target);
}

async function ensureModel(model) {
  const target = join(modelsDir, model.file);
  if (matches(target, model)) return 'cached';
  for (const base of MODEL_BASES) {
    try {
      const url = `${base}/${model.path}`;
      process.stdout.write(`[ocr] downloading ${model.file} from ${new URL(url).host}\n`);
      await download(url, target);
      if (!matches(target, model)) {
        throw new Error(`checksum mismatch (expected ${model.sha256})`);
      }
      return 'downloaded';
    } catch (error) {
      process.stderr.write(`[ocr] ${model.file}: ${error instanceof Error ? error.message : error}\n`);
    }
  }
  throw new Error(`无法获取 ${model.file}`);
}

function ensureOrt() {
  const sourceDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const copied = [];
  for (const name of ORT_FILES) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) throw new Error(`onnxruntime-web 缺少 ${name}（先运行 pnpm install）`);
    const target = join(ortDir, name);
    const sourceHash = sha256(source);
    if (!existsSync(target) || sha256(target) !== sourceHash) {
      copyFileSync(source, target);
      copied.push(name);
    }
  }
  return copied;
}

function writeManifest(ortHashes) {
  const manifest = {
    version: MODEL_VERSION,
    engine: 'onnxruntime-web',
    models: Object.fromEntries(
      MODELS.map((model) => [
        model.id,
        { file: model.file, bytes: model.bytes, sha256: model.sha256 },
      ]),
    ),
    ort: ortHashes,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function verify() {
  const problems = [];
  for (const model of MODELS) {
    if (!matches(join(modelsDir, model.file), model)) problems.push(model.file);
  }
  const sourceDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  for (const name of ORT_FILES) {
    const target = join(ortDir, name);
    const source = join(sourceDir, name);
    if (!existsSync(target)) problems.push(`ort/${name}`);
    else if (existsSync(source) && sha256(target) !== sha256(source)) problems.push(`ort/${name} (stale)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `OCR 资源不完整：${problems.join('、')}\n运行 \`node scripts/fetch-ocr-assets.mjs\` 补齐后再打包。`,
    );
  }
}

async function main() {
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(ortDir, { recursive: true });

  if (checkOnly) {
    verify();
    process.stdout.write('[ocr] assets ok\n');
    return;
  }

  const outcome = {};
  for (const model of MODELS) {
    try {
      outcome[model.id] = await ensureModel(model);
    } catch (error) {
      process.stderr.write(
        `[ocr] 跳过 ${model.file}：${error instanceof Error ? error.message : error}\n`,
      );
    }
  }

  let ort = null;
  try {
    ort = ensureOrt();
  } catch (error) {
    process.stderr.write(`[ocr] ONNX Runtime 资源未复制：${error instanceof Error ? error.message : error}\n`);
  }

  if (ort) {
    writeManifest(Object.fromEntries(ORT_FILES.map((name) => [name, sha256(join(ortDir, name))])));
  }
  process.stdout.write(`[ocr] ${JSON.stringify(outcome)} ort=${ort ? ort.join(',') || 'cached' : 'skipped'}\n`);
}

main().catch((error) => {
  process.stderr.write(`[ocr] ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = checkOnly ? 1 : 0;
});
