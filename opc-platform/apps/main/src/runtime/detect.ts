import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeKind, RuntimeProfile } from '@opc/shared/domain';

/**
 * Finding interpreters without spawning anything.
 *
 * A GUI app on macOS starts with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * so `which node` inside Electron misses Homebrew, nvm, Volta and pyenv even when
 * the user's shell finds them. Detection therefore combines the process PATH with
 * the directories those managers actually write to.
 */

const VERSION_TIMEOUT_MS = 3_000;

export interface VersionProbe {
  ok: boolean;
  version?: string;
  detail?: string;
}

const WINDOWS_EXTENSIONS = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

export function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function versionParts(name: string): number[] {
  return name
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersionsDesc(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDesc);
  } catch {
    return [];
  }
}

/** nvm / fnm installations are plain directories, newest first. */
function versionManagerDirs(home: string): string[] {
  return [
    ...readDirs(path.join(home, '.nvm', 'versions', 'node')).map((name) =>
      path.join(home, '.nvm', 'versions', 'node', name, 'bin'),
    ),
    ...readDirs(path.join(home, '.local', 'share', 'fnm', 'node-versions')).map((name) =>
      path.join(home, '.local', 'share', 'fnm', 'node-versions', name, 'installation', 'bin'),
    ),
    ...readDirs(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions')).map(
      (name) =>
        path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions', name, 'installation', 'bin'),
    ),
  ];
}

/**
 * Directories worth searching, in priority order: first the environment the app
 * inherited, then version managers, then the usual system prefixes.
 */
export function runtimeSearchDirs(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = os.homedir();
  const result: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const expanded = value.startsWith('~') ? path.join(home, value.slice(1)) : value;
    if (!expanded || result.includes(expanded)) return;
    result.push(expanded);
  };

  const inherited = platform === 'win32' ? (baseEnv.Path ?? baseEnv.PATH) : baseEnv.PATH;
  for (const dir of (inherited ?? '').split(path.delimiter)) add(dir);

  for (const dir of versionManagerDirs(home)) add(dir);

  for (const dir of [
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.pyenv', 'shims'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'Library', 'pnpm'),
  ]) {
    add(dir);
  }

  if (platform === 'darwin') {
    add('/opt/homebrew/bin');
    add('/opt/homebrew/opt/python/libexec/bin');
  }
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');

  return result;
}

function windowsCandidates(name: string): string[] {
  if (path.extname(name)) return [name];
  return WINDOWS_EXTENSIONS.map((extension) => `${name}${extension}`);
}

/** First executable called `name` in `dirs`; absolute paths are returned as-is. */
export function findExecutable(
  name: string,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!name) return undefined;
  if (path.isAbsolute(name)) return isExecutableFile(name) ? name : undefined;

  const candidates = platform === 'win32' ? windowsCandidates(name) : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = path.join(dir, candidate);
      if (isExecutableFile(file)) return file;
    }
  }
  return undefined;
}

/** Resolves the argv head `bash` / `execFile` would pick, using the child's PATH. */
export function resolveExecutable(head: string, env: NodeJS.ProcessEnv): string {
  if (!head || path.isAbsolute(head)) return head;
  const pathValue = process.platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH;
  const dirs = (pathValue ?? '').split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return head;
  return findExecutable(head, dirs) ?? head;
}

/** Where a built-in profile's interpreter lives; custom profiles use their own path. */
export function resolveBuiltinBinary(
  profile: RuntimeProfile,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (profile.id === 'node-bundled') return process.execPath;
  if (profile.id === 'node-system') return findExecutable('node', dirs, platform);
  if (profile.id === 'python-system') {
    return (
      findExecutable('python3', dirs, platform) ?? findExecutable('python', dirs, platform)
    );
  }
  return profile.binary ? profile.binary : undefined;
}

export function realBinaryPath(file: string): string {
  return safeRealpath(file);
}

function normalizeVersion(kind: RuntimeKind, raw: string): string {
  const line = raw
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return '';
  if (kind === 'node') return line.replace(/^v/i, '').trim();
  return line.replace(/^python\s+/i, '').trim();
}

/**
 * `--version` with a hard timeout. A broken interpreter must not freeze the
 * settings page, so every failure becomes a readable detail instead of a throw.
 */
export function probeVersion(binary: string, kind: RuntimeKind): Promise<VersionProbe> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (binary === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

    execFile(
      binary,
      ['--version'],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`;
        const version = normalizeVersion(kind, output);
        if (error && !version) {
          const timedOut = Boolean((error as { killed?: boolean }).killed);
          resolve({
            ok: false,
            detail: timedOut ? '版本检测超时（3s）' : error.message,
          });
          return;
        }
        if (!version) {
          resolve({ ok: false, detail: '解释器没有返回版本号' });
          return;
        }
        resolve({ ok: true, version });
      },
    );
  });
}
