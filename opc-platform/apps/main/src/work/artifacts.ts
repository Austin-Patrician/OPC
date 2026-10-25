import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Only raster images get a thumbnail; everything else stays a chip. */
export function isThumbnailable(relPath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/**
 * Reads one artifact from a task workspace as a data URL.
 *
 * `resolveWithin` keeps `../../` out; the extension whitelist keeps the IPC from
 * becoming a general file reader; oversized files are refused so a 50 MB asset
 * cannot be pushed through the bridge.
 */
export function readImageArtifact(
  workspaceRoot: string,
  relWorkspacePath: string,
  relPath: string,
): { ok: true; dataUrl: string; bytes: number } | { ok: false; error: string } {
  if (!isThumbnailable(relPath)) return { ok: false, error: '不是图片文件' };

  const taskDir = path.resolve(workspaceRoot, relWorkspacePath);
  const target = path.resolve(taskDir, relPath);
  if (target !== taskDir && !target.startsWith(`${taskDir}${path.sep}`)) {
    return { ok: false, error: '路径越界' };
  }

  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { ok: false, error: '文件不存在' };
  if (stat.size > MAX_THUMBNAIL_BYTES) return { ok: false, error: '图片过大，未生成缩略图' };

  const bytes = fs.readFileSync(target);
  const mime = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength };
}
