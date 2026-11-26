import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.msi',
  '.msix',
  '.appx',
  '.bat',
  '.cmd',
  '.com',
  '.ps1',
  '.psm1',
  '.psd1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.scr',
  '.pif',
  '.cpl',
  '.hta',
  '.lnk',
  '.reg',
  '.sh',
  '.bash',
  '.zsh',
  '.command',
  '.app',
  '.pkg',
  '.dmg',
  '.run',
  '.appimage',
  '.dll',
  '.so',
  '.dylib',
]);

export interface LocalPathResolution {
  ok: boolean;
  path?: string;
  isDirectory?: boolean;
  error?: string;
}

export interface LocalPathActionResult {
  ok: boolean;
  blockedExecutable?: boolean;
  error?: string;
}

/** Validates user-triggered external URLs (`http:`, `https:`, `mailto:` only). */
export function isSafeExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.protocol === 'mailto:') {
    return parsed.pathname.trim().includes('@');
  }
  return Boolean(parsed.hostname);
}

/** Strips trailing `:line` or `:line:col` editor suffix without disturbing `C:\` drive colons. */
export function stripLineColumnSuffix(rawPath: string): string {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(rawPath);
  if (!match?.[1]) return rawPath;
  const base = match[1];
  if (base.length <= 2 || base.endsWith('/') || base.endsWith('\\')) return rawPath;
  return base;
}

function isUncOrDevicePath(value: string): boolean {
  return (
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    /^\\\\[.?]\\/.test(value)
  );
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('`') && trimmed.endsWith('`')))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Safely parses user-clicked local paths (`file://`, absolute local path, `~/` home, or
 * known base-dir relative paths), blocking UNC shares and confirming disk presence.
 */
export function resolveLocalPathForAction(
  rawInput: string,
  options: {
    homeDir?: string;
    baseDirs?: readonly string[];
    existsSync?: (target: string) => boolean;
    statSync?: (target: string) => fs.Stats | undefined;
  } = {},
): LocalPathResolution {
  const homeDir = options.homeDir ?? os.homedir();
  const existsSync = options.existsSync ?? ((target: string) => fs.existsSync(target));
  const statSync =
    options.statSync ?? ((target: string) => fs.statSync(target, { throwIfNoEntry: false }));

  const cleaned = stripOuterQuotes(rawInput);
  if (!cleaned || /[\r\n\0]/.test(cleaned)) {
    return { ok: false, error: '路径无效' };
  }

  let candidate = cleaned;
  if (/^file:\/\//i.test(candidate)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return { ok: false, error: '无效的 file:// 路径' };
    }
    if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') {
      return { ok: false, error: '不支持打开远程共享路径' };
    }
    try {
      candidate = fileURLToPath(parsed);
    } catch {
      return { ok: false, error: '无法解析该文件路径' };
    }
  }

  if (isUncOrDevicePath(candidate)) {
    return { ok: false, error: '出于安全考虑，不支持网络共享或设备路径' };
  }

  candidate = expandHome(stripLineColumnSuffix(candidate), homeDir);
  if (!candidate || isUncOrDevicePath(candidate)) {
    return { ok: false, error: '路径格式无效' };
  }

  const normalizedCandidates: string[] = [];
  if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    normalizedCandidates.push(path.resolve(candidate));
  } else {
    for (const baseDir of options.baseDirs ?? []) {
      if (!baseDir) continue;
      const baseResolved = path.resolve(baseDir);
      const joined = path.resolve(baseResolved, candidate);
      if (
        joined === baseResolved ||
        joined.startsWith(`${baseResolved}${path.sep}`)
      ) {
        normalizedCandidates.push(joined);
      }
    }
  }

  for (const target of normalizedCandidates) {
    if (!existsSync(target)) continue;
    const stat = statSync(target);
    if (!stat) continue;
    return {
      ok: true,
      path: target,
      isDirectory: stat.isDirectory(),
    };
  }

  return { ok: false, error: '本机未找到该文件或目录' };
}

export function isBlockedExecutablePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(ext && BLOCKED_EXECUTABLE_EXTENSIONS.has(ext));
}

export async function runSafeOpenLocalPath(
  rawInput: string,
  deps: {
    homeDir?: string;
    baseDirs?: readonly string[];
    existsSync?: (target: string) => boolean;
    statSync?: (target: string) => fs.Stats | undefined;
    openPath: (absPath: string) => Promise<string>;
  },
): Promise<LocalPathActionResult> {
  const resolved = resolveLocalPathForAction(rawInput, deps);
  if (!resolved.ok || !resolved.path) {
    return { ok: false, error: resolved.error ?? '无法解析该路径' };
  }
  if (!resolved.isDirectory && isBlockedExecutablePath(resolved.path)) {
    return {
      ok: false,
      blockedExecutable: true,
      error: '出于安全考虑，不允许直接执行程序或脚本，请改用「在文件夹中定位」',
    };
  }
  const openError = await deps.openPath(resolved.path);
  return openError ? { ok: false, error: openError } : { ok: true };
}

export function runSafeRevealLocalPath(
  rawInput: string,
  deps: {
    homeDir?: string;
    baseDirs?: readonly string[];
    existsSync?: (target: string) => boolean;
    statSync?: (target: string) => fs.Stats | undefined;
    showItemInFolder: (absPath: string) => void;
  },
): LocalPathActionResult {
  const resolved = resolveLocalPathForAction(rawInput, deps);
  if (!resolved.ok || !resolved.path) {
    return { ok: false, error: resolved.error ?? '无法解析该路径' };
  }
  deps.showItemInFolder(resolved.path);
  return { ok: true };
}
