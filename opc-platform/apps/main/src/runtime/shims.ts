import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeKind } from '@opc/shared/domain';

/**
 * shim directories solve one specific problem: `bash` receives a shell string,
 * so a profile's interpreter only takes effect if `python` / `node` resolve to it
 * through PATH. The app owns these symlinks; the model cannot write into them
 * (the workspace is never on PATH).
 */

const ALIASES: Record<RuntimeKind, readonly string[]> = {
  node: ['node', 'nodejs'],
  python: ['python', 'python3'],
};

/** POSIX only: Windows `CreateProcess` cannot execute `.cmd` without a shell. */
const SUPPORTED = process.platform !== 'win32';

export function shimDirFor(userDataDir: string, profileId: string): string {
  return path.join(userDataDir, 'runtimes', profileId, 'bin');
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeScript(file: string, message: string): void {
  fs.writeFileSync(file, `#!/bin/sh\necho ${shQuote(message)} >&2\nexit 127\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

/**
 * Rewrites the profile's shim directory. `message` is for an unavailable profile:
 * the alias then fails with that text instead of silently reaching an unrelated
 * interpreter the user did not choose.
 */
export function writeShims(
  userDataDir: string,
  profileId: string,
  kind: RuntimeKind,
  binary: string | undefined,
  message?: string,
): string {
  const dir = shimDirFor(userDataDir, profileId);
  if (!SUPPORTED) return dir;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    for (const alias of ALIASES[kind]) {
      const target = path.join(dir, alias);
      if (binary && !message) {
        fs.symlinkSync(binary, target);
      } else {
        writeScript(target, message ?? `运行环境不可用：${profileId}`);
      }
    }
    return dir;
  } catch (error) {
    // A read-only userData or an antivirus lock must not break every tool call:
    // the caller falls back to binDirs / the ambient PATH.
    console.warn(`[OPC] 无法写入运行时 shim：${dir}`, error);
    return '';
  }
}

export function removeShims(userDataDir: string, profileId: string): void {
  try {
    fs.rmSync(shimDirFor(userDataDir, profileId), { recursive: true, force: true });
  } catch {
    // Best effort: an orphan directory is harmless.
  }
}
