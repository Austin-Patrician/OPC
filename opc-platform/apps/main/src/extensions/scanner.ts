import fs from 'node:fs';
import path from 'node:path';

/**
 * Disk discovery for Pi coding-agent extensions.
 *
 * Pi auto-loads extensions from `~/.pi/agent/extensions/` (global) and
 * `.pi/extensions/` (project), one level deep, plus whatever `settings.json`
 * lists under `extensions`. This module reproduces exactly that layout and
 * nothing else: it only reads files, never imports them. Importing runs the
 * extension's code, which is the caller's decision to make, not the scanner's.
 *
 * Directory layouts, in Pi's precedence order:
 *   <root>/name.ts                       single file
 *   <root>/name/index.ts                 directory entry
 *   <root>/name/package.json#pi.extensions   manifest (first entry wins)
 */

const ENTRY_NAMES = ['index.ts', 'index.mts', 'index.cts', 'index.js', 'index.mjs', 'index.cjs'];
const MODULE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

export type PiExtensionScope = 'global' | 'project';

export interface ScannedExtension {
  /** Absolute path of the entry file (or of the directory, when a manifest has no entry). */
  id: string;
  name: string;
  description: string;
  version: string;
  scope: PiExtensionScope;
  /** Directory that owns the extension: where its `node_modules` would live. */
  dir: string;
  /** Absolute path of the module to import. */
  entry: string;
  /** Newest mtime of the entry, its manifest and its directory; drives cache invalidation. */
  mtime: number;
}

export interface ScanOptions {
  homeDir: string;
  projectDir: string;
  /** Defaults to the real filesystem; tests inject an in-memory one. */
  readDir?: (dir: string) => fs.Dirent[];
  readText?: (file: string) => string | undefined;
  stat?: (target: string) => { isFile(): boolean; isDirectory(): boolean; mtimeMs: number } | undefined;
}

export interface ScanResult {
  roots: string[];
  entries: ScannedExtension[];
}

const isModuleFile = (name: string) => MODULE_EXTENSIONS.has(path.extname(name).toLowerCase());

const toPosix = (value: string) => value.replace(/\\/g, '/');

/** `foo-bar` → `foo-bar`; keeps names readable in policy lists. */
export const extensionSlug = (name: string) => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'extension';
};

export function piExtensionRoots(homeDir: string, projectDir: string): { scope: PiExtensionScope; dir: string }[] {
  return [
    { scope: 'global', dir: path.join(homeDir, '.pi', 'agent', 'extensions') },
    { scope: 'project', dir: path.join(projectDir, '.pi', 'extensions') },
  ];
}

export function scanPiExtensions(options: ScanOptions): ScanResult {
  const readDir = options.readDir ?? defaultReadDir;
  const readText = options.readText ?? defaultReadText;
  const stat = options.stat ?? defaultStat;

  const roots = piExtensionRoots(options.homeDir, options.projectDir);
  const entries = new Map<string, ScannedExtension>();

  for (const root of roots) {
    for (const found of readRoot(root.dir, root.scope, { readDir, readText, stat })) {
      entries.set(found.id, found);
    }
  }

  // `settings.json` can point at a file or a directory anywhere on disk. Pi
  // reads it only after project trust; OPC has its own trust gate, so the paths
  // are listed but not loaded until the user enables them.
  for (const declared of declaredPaths(options.homeDir, readText)) {
    const found = describe(declared, 'global', path.dirname(declared), { readDir, readText, stat });
    if (found) entries.set(found.id, found);
  }

  return {
    roots: roots.map((root) => root.dir),
    entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function declaredPaths(homeDir: string, readText: (file: string) => string | undefined): string[] {
  const settingsFile = path.join(homeDir, '.pi', 'agent', 'settings.json');
  const raw = readText(settingsFile);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { extensions?: unknown };
    if (!Array.isArray(parsed.extensions)) return [];
    return parsed.extensions
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => expandHome(value.trim(), homeDir))
      .filter((value) => path.isAbsolute(value));
  } catch {
    return [];
  }
}

function expandHome(value: string, homeDir: string) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

function readRoot(
  root: string,
  scope: PiExtensionScope,
  io: Required<Pick<ScanOptions, 'readDir' | 'readText' | 'stat'>>,
): ScannedExtension[] {
  const found: ScannedExtension[] = [];
  for (const dirent of io.readDir(root)) {
    if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
    const target = path.join(root, dirent.name);
    const candidate = describe(target, scope, root, io);
    if (candidate) found.push(candidate);
  }
  return found;
}

/** Resolve one file or directory into an extension, or `undefined` when it is not one. */
function describe(
  target: string,
  scope: PiExtensionScope,
  root: string,
  io: Required<Pick<ScanOptions, 'readDir' | 'readText' | 'stat'>>,
): ScannedExtension | undefined {
  const info = io.stat(target);
  if (!info) return undefined;

  if (info.isFile()) {
    if (!isModuleFile(target)) return undefined;
    return {
      id: toPosix(target),
      name: path.basename(target, path.extname(target)),
      description: '',
      version: '',
      scope,
      dir: path.dirname(target),
      entry: target,
      mtime: info.mtimeMs,
    };
  }

  if (!info.isDirectory()) return undefined;

  const manifestPath = path.join(target, 'package.json');
  const manifest = readManifest(io.readText(manifestPath));
  if (manifest) {
    const entry = resolveManifestEntry(target, manifest);
    if (entry) {
      return {
        id: toPosix(target),
        name: manifest.name ?? path.basename(target),
        description: manifest.description ?? '',
        version: manifest.version ?? '',
        scope,
        dir: target,
        entry,
        mtime: newest(info.mtimeMs, io.stat(manifestPath)?.mtimeMs, io.stat(entry)?.mtimeMs),
      };
    }
  }

  for (const name of ENTRY_NAMES) {
    const entry = path.join(target, name);
    const entryInfo = io.stat(entry);
    if (!entryInfo?.isFile()) continue;
    return {
      id: toPosix(target),
      name: manifest?.name ?? path.basename(target),
      description: manifest?.description ?? '',
      version: manifest?.version ?? '',
      scope,
      dir: target,
      entry,
      mtime: newest(info.mtimeMs, entryInfo.mtimeMs, io.stat(manifestPath)?.mtimeMs),
    };
  }

  // Manifest that only lists globs we cannot resolve without walking the tree.
  if (manifest?.extensions?.[0]) {
    return {
      id: toPosix(target),
      name: manifest.name ?? path.basename(target),
      description: manifest.description ?? '',
      version: manifest.version ?? '',
      scope,
      dir: root,
      entry: target,
      mtime: info.mtimeMs,
    };
  }

  return undefined;
}

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  extensions: string[];
}

function readManifest(raw: string | undefined): Manifest | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pi = (parsed.pi ?? {}) as { extensions?: unknown };
    const list = Array.isArray(pi.extensions)
      ? pi.extensions.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      extensions: list,
    };
  } catch {
    return undefined;
  }
}

function resolveManifestEntry(dir: string, manifest: Manifest): string | undefined {
  // Only plain relative paths; globs and exclusions need Pi's full resolver.
  const first = manifest.extensions.find((value) => !/[*?[\]!]/.test(value));
  if (!first) return undefined;
  const entry = path.resolve(dir, first);
  return isModuleFile(entry) ? entry : undefined;
}

const newest = (...values: (number | undefined)[]) =>
  values.reduce<number>((max, value) => (typeof value === 'number' && value > max ? value : max), 0);

function defaultReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function defaultReadText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultStat(target: string) {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}
