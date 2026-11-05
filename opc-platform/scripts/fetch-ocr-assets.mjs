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
 *
 * **Proxy.** This is not an Electron process, so none of the app's three proxy
 * exits apply to it: a machine that reaches the internet only through a proxy
 * would fail here while the app worked. `ocr-proxy.mjs` reads `HTTPS_PROXY` (or
 * the OS setting) and this file re-execs itself once with `--use-env-proxy`,
 * because Node's built-in `fetch` ignores proxy variables without it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REEXEC_MARKER,
  decideRoute,
  describeRoute,
  envProxy,
  parseScutilProxy,
  parseWindowsOverride,
  parseWindowsProxyServer,
  proxyEnvironment,
} from './ocr-proxy.mjs';

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

/**
 * The OS-level proxy, which is what "跟随系统" means in the app's settings.
 *
 * Read here rather than imported from `apps/main`: that module talks to Electron
 * (session, safeStorage) and cannot run under a plain Node process at install
 * time. Reading the setting directly keeps the two answers the same — the app
 * hands the same route to Chromium's session.
 */
function systemProxyOf() {
  try {
    if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const out = execText('reg', ['query', key]);
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null;
      const server = parseWindowsProxyServer(valueOf(out, 'ProxyServer'));
      if (!server) return null;
      const noProxy = parseWindowsOverride(valueOf(out, 'ProxyOverride'));
      return { ...server, ...(noProxy ? { noProxy } : {}) };
    }
    if (process.platform === 'darwin') return parseScutilProxy(execText('scutil', ['--proxy']));
  } catch {
    // A missing `reg`/`scutil`, a locked policy store, a denied read: all mean
    // "no system proxy I can see", which is exactly the direct-connect case.
  }
  return null;
}

function execText(command, args) {
  return String(spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '');
}

/** `ProxyServer    REG_SZ    127.0.0.1:7897` → `127.0.0.1:7897`. */
function valueOf(regOutput, name) {
  const match = new RegExp(`^\\s*${name}\\s+REG_[A-Z_]+\\s+(.+)$`, 'im').exec(regOutput);
  return match?.[1]?.trim();
}

/**
 * Switches this process onto the proxy route before any download starts.
 *
 * Node's `fetch` only honours proxy variables when the process was *started*
 * with `--use-env-proxy`, so this cannot be a runtime setting: it re-execs once
 * with the flag and the route in the environment. Node versions without the flag
 * fall through to a direct attempt, which is the old behaviour, plus one warning.
 */
function useProxyIfNeeded() {
  // `--check` makes no request: spawning a child to hash three files is waste.
  if (checkOnly) return;
  if (process.env[REEXEC_MARKER]) return;

  const { route, reason } = decideRoute({ system: envProxy() ? null : systemProxyOf() });
  if (!route) {
    process.stdout.write(`[ocr] ${reason}\n`);
    return;
  }

  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
    process.stderr.write(
      `[ocr] 检出代理 ${describeRoute(route.url)}，但当前 Node（${process.version}）不支持 --use-env-proxy，下载仍会直连。` +
        '请升级 Node 或设置 HTTPS_PROXY 后重试。\n',
    );
    return;
  }

  // Node's built-in fetch speaks HTTP/HTTPS proxies only. Saying so is better
  // than handing it a SOCKS URL and printing "fetch failed" three times.
  if (/^socks/i.test(route.url)) {
    process.stderr.write(
      `[ocr] 只有 SOCKS 代理 ${describeRoute(route.url)}，Node 内置 fetch 不支持；请把该代理的 HTTP 端口写进 HTTPS_PROXY，或直接下载模型。\n`,
    );
    return;
  }

  process.stdout.write(`[ocr] 通过代理下载：${describeRoute(route.url)}（${reason}）\n`);
  // `--disable-warning` is newer than the flag we actually need; ask rather than
  // risk "bad option" on an older runtime.
  const quiet = process.allowedNodeEnvironmentFlags.has('--disable-warning')
    ? ['--disable-warning=ExperimentalWarning']
    : [];
  const child = spawnSync(
    process.execPath,
    [...quiet, '--use-env-proxy', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ...proxyEnvironment(route), [REEXEC_MARKER]: '1' } },
  );
  process.exit(child.status ?? 1);
}

useProxyIfNeeded();

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function matches(file, expected) {
  return existsSync(file) && statSync(file).size === expected.bytes && sha256(file) === expected.sha256;
}

/**
 * Fetches `url` into `target`, following redirects by hand.
 *
 * `redirect: 'follow'` is the obvious version, but it is the one thing that does
 * not survive the proxy: huggingface.co answers 302 to a signed CDN URL, and
 * undici's `EnvHttpProxyAgent` drops the connection on that second hop
 * (ECONNRESET, "socket disconnected before secure TLS connection was
 * established") even though both hosts answer 200 when asked directly. Following
 * the hop ourselves also makes the error name the host that failed — "fetch
 * failed" on a two-hop download says nothing about which half is broken.
 */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;

async function download(url, target) {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let response;
    try {
      response = await fetch(current, { redirect: 'manual' });
    } catch (error) {
      const cause = error instanceof Error ? (error.cause?.message ?? error.message) : String(error);
      throw new Error(`${new URL(current).host}：${cause}`, { cause: error });
    }

    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`${response.status} 但没有 Location`);
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const temp = `${target}.part`;
    writeFileSync(temp, buffer);
    renameSync(temp, target);
    return;
  }
  throw new Error(`跳转超过 ${MAX_HOPS} 次：${new URL(url).host}`);
}

/**
 * Retries per source. The proxy path is not always healthy first time — a fresh
 * CONNECT gets reset now and then and succeeds on the next attempt (measured on
 * a consumer proxy: ~1 in 5). A 21 MB download is worth three tries per source
 * before giving up.
 */
const ATTEMPTS_PER_BASE = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureModel(model) {
  const target = join(modelsDir, model.file);
  if (matches(target, model)) return 'cached';
  for (const base of MODEL_BASES) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_BASE; attempt += 1) {
      try {
        const url = `${base}/${model.path}`;
        process.stdout.write(
          `[ocr] downloading ${model.file} from ${new URL(url).host}` +
            `${attempt > 1 ? `（重试 ${attempt - 1}）` : ''}\n`,
        );
        await download(url, target);
        if (!matches(target, model)) {
          throw new Error(`checksum mismatch (expected ${model.sha256})`);
        }
        return 'downloaded';
      } catch (error) {
        process.stderr.write(`[ocr] ${model.file}: ${error instanceof Error ? error.message : error}\n`);
        if (attempt < ATTEMPTS_PER_BASE) await sleep(attempt * 1000);
      }
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
