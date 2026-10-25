/**
 * The system-owned acceptance checker.
 *
 * It lives outside the employee's workspace so the employee cannot edit its own
 * grader: the file is written to `checks/<taskId>/verify.mjs` and executed with
 * the workspace as cwd. It starts the deliverable, performs a real HTTP request,
 * asserts the body, and exits non-zero with evidence when it fails.
 */
export const VERIFY_HTTP_OK = String.raw`
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const workspace = process.cwd();
const entry = process.env.OPC_ENTRY || 'server.js';
const expected = process.env.OPC_EXPECT || 'ok';
const timeoutMs = Number(process.env.OPC_TIMEOUT_MS || 8000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

const port = await freePort();
const child = spawn(process.execPath, [path.join(workspace, entry)], {
  cwd: workspace,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => (childOutput += chunk));
child.stderr.on('data', (chunk) => (childOutput += chunk));

let body = null;
let lastError = null;
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  try {
    body = await get(port);
    break;
  } catch (error) {
    lastError = error;
    await sleep(150);
  }
}

child.kill('SIGTERM');

if (body === null) {
  console.error('FAIL 无法连接服务: ' + (lastError ? lastError.message : 'unknown'));
  if (childOutput) console.error('--- 子进程输出 ---\n' + childOutput);
  process.exit(1);
}

const text = String(body).trim();
console.log('GET / -> ' + JSON.stringify(text));

if (text !== expected) {
  console.error('FAIL 期望 body=' + JSON.stringify(expected) + '，实际=' + JSON.stringify(text));
  process.exit(2);
}

console.log('PASS http-ok');
process.exit(0);
`;

/**
 * Image acceptance: "the deliverable is served as an image with 200, everything
 * else is the LLM's call". Serves the workspace over loopback, fetches the first
 * image file, and asserts status 200 plus an `image/*` content type.
 */
/**
 * Manager sign-off gate: the reviewer must leave a machine-readable verdict.
 * `pass` accepts the subordinate's work; `revise` sends it back with a reason.
 */
export const VERIFY_REVIEW_VERDICT = String.raw`
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'verdict.json');
if (!fs.existsSync(file)) {
  console.error('缺少 verdict.json');
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error('verdict.json 不是合法 JSON：' + String(error));
  process.exit(1);
}
const verdict = parsed && parsed.verdict;
if (verdict !== 'pass' && verdict !== 'revise') {
  console.error('verdict 必须是 pass 或 revise，实际：' + String(verdict));
  process.exit(1);
}
console.log(JSON.stringify({ verdict, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }));
`;

export const VERIFY_IMAGE_200 = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const dir = process.cwd();
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const files = fs.readdirSync(dir).filter((name) => IMAGE.test(name));

if (files.length === 0) {
  console.error('FAIL 工作区没有图片文件（png/jpg/webp/gif）');
  process.exit(1);
}

const target = files[0];
const mime = (name) => {
  const ext = path.extname(name).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
};

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const server = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').slice(1));
  const file = path.join(dir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': mime(name) });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const response = await fetch('http://127.0.0.1:' + port + '/' + encodeURIComponent(target));
const body = await response.arrayBuffer();
server.close();

const type = response.headers.get('content-type') ?? '';
console.log('GET /' + target + ' -> ' + response.status + ' ' + type + ' ' + body.byteLength + 'B');

if (response.status !== 200) {
  console.error('FAIL 期望 200，实际 ' + response.status);
  process.exit(2);
}
if (!type.startsWith('image/')) {
  console.error('FAIL 期望 image/* 内容类型，实际 ' + type);
  process.exit(3);
}
console.log('PASS image-200');
process.exit(0);
`;

/** Default task shipped with the slice: one file in, one HTTP assertion out. */
export const DEMO_TASK = {
  title: '写一个 hello world HTTP 服务',
  brief:
    '用 Node 内置 http 模块实现一个服务：GET / 返回纯文本 ok；监听 process.env.PORT（默认 3000）；不要引入任何依赖。',
  deliverableSpec: 'server.js：可直接 `node server.js` 启动，GET / 返回 "ok"',
  acceptanceCommand: ['node', '{checks}/verify.mjs'],
  acceptanceTemplate: 'http-ok' as const,
  estTokens: 6000,
};
