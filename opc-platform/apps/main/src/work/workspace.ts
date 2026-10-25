import fs from 'node:fs';
import path from 'node:path';

/**
 * Filesystem guard for agent work.
 *
 * Every read/write goes through `resolveWithin`, so a path that escapes the
 * workspace (`../..`, absolute paths, symlinks pointing out) is rejected instead
 * of silently written. This is the first line of defence until per-employee
 * containers land.
 */
export function resolveWithin(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`拒绝绝对路径: ${relativePath}`);
  }

  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`路径越界: ${relativePath}`);
  }
  return target;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a UTF-8 file inside `rootDir`, creating parent folders as needed. */
export function writeFileWithin(rootDir: string, relativePath: string, content: string): string {
  const target = resolveWithin(rootDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export interface WorkspaceFile {
  relPath: string;
  absolutePath: string;
  bytes: number;
}

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

/** Flat list of regular files in a workspace (bounded, so a runaway agent cannot flood). */
export function listWorkspaceFiles(rootDir: string, limit = 50): WorkspaceFile[] {
  const results: WorkspaceFile[] = [];

  const walk = (dir: string) => {
    if (results.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      if (IGNORED.has(entry.name)) continue;

      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = fs.statSync(absolutePath);
      results.push({
        relPath: path.relative(rootDir, absolutePath),
        absolutePath,
        bytes: stat.size,
      });
    }
  };

  walk(rootDir);
  return results;
}
