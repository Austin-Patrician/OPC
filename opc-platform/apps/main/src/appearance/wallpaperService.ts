import type { WallpaperAsset, WallpaperMediaKind } from '@opc/shared/domain';
import type { WallpaperImportResult } from '@opc/shared/ipc';
import { dialog, type BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WALLPAPER_MIME_TYPES } from './wallpaperProtocol';

export const MAX_WALLPAPER_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_WALLPAPER_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_POSTER_BYTES = 2 * 1024 * 1024;
const MANIFEST_NAME = 'manifest.json';

const VIDEO_EXTS = new Set(['.mp4', '.webm']);
const STATIC_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);

/**
 * Inspects a WebP file header/chunks (`RIFF....WEBP`) for `VP8X` animation bit (`0x02`)
 * or an `ANIM` chunk so animated WebPs use the streaming canvas decoder rather than `<img>`.
 */
export function detectAnimatedWebp(header: Uint8Array): boolean {
  if (header.byteLength < 16) return false;
  if (
    header[0] !== 0x52 || header[1] !== 0x49 || header[2] !== 0x46 || header[3] !== 0x46 || // RIFF
    header[8] !== 0x57 || header[9] !== 0x45 || header[10] !== 0x42 || header[11] !== 0x50 // WEBP
  ) {
    return false;
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let offset = 12;
  while (offset + 8 <= header.byteLength) {
    const tag = String.fromCharCode(
      header[offset]!,
      header[offset + 1]!,
      header[offset + 2]!,
      header[offset + 3]!,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (tag === 'ANIM') return true;
    if (tag === 'VP8X' && offset + 9 <= header.byteLength) {
      if ((header[offset + 8]! & 0x02) !== 0) return true;
    }
    const step = 8 + chunkSize + (chunkSize & 1);
    if (step <= 8) break;
    offset += step;
  }
  return false;
}

async function hashFilePrefix(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
  });
}

function readHeaderBytes(filePath: string, length = 4096): Uint8Array {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveMediaKind(ext: string, filePath: string): WallpaperMediaKind {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ext === '.gif') return 'animated-image';
  if (ext === '.webp') {
    try {
      return detectAnimatedWebp(readHeaderBytes(filePath)) ? 'animated-image' : 'image';
    } catch {
      return 'image';
    }
  }
  if (STATIC_IMAGE_EXTS.has(ext)) return 'image';
  return 'image';
}

/**
 * Manages user-selected wallpaper files on disk under `<userData>/wallpapers/`,
 * keeping localStorage free of multi-megabyte Base64 strings.
 */
export class WallpaperService {
  constructor(private readonly wallpapersDir: string) {}

  private ensureDir(): string {
    fs.mkdirSync(this.wallpapersDir, { recursive: true });
    return this.wallpapersDir;
  }

  private manifestPath(): string {
    return path.join(this.wallpapersDir, MANIFEST_NAME);
  }

  private writeManifest(asset: WallpaperAsset): void {
    this.ensureDir();
    const tmp = path.join(this.wallpapersDir, `.tmp-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(asset, null, 2), 'utf8');
    fs.renameSync(tmp, this.manifestPath());
  }

  private cleanupOtherFiles(keepNames: ReadonlySet<string>): void {
    if (!fs.existsSync(this.wallpapersDir)) return;
    for (const entry of fs.readdirSync(this.wallpapersDir)) {
      if (entry === MANIFEST_NAME || keepNames.has(entry)) continue;
      if (entry.startsWith('wp-') || entry.startsWith('poster-') || entry.startsWith('.tmp-')) {
        try {
          fs.rmSync(path.join(this.wallpapersDir, entry), { force: true });
        } catch {
          // Best-effort cleanup of stale wallpaper files.
        }
      }
    }
  }

  getCurrent(): WallpaperAsset | null {
    const manifest = this.manifestPath();
    if (!fs.existsSync(manifest)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as WallpaperAsset;
      if (!parsed || typeof parsed.filename !== 'string') return null;
      const assetPath = path.join(this.wallpapersDir, path.basename(parsed.filename));
      if (!fs.existsSync(assetPath)) {
        fs.rmSync(manifest, { force: true });
        return null;
      }
      if (parsed.posterFilename) {
        const posterPath = path.join(this.wallpapersDir, path.basename(parsed.posterFilename));
        if (!fs.existsSync(posterPath)) {
          delete parsed.posterFilename;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async importFromPath(sourcePath: string): Promise<WallpaperImportResult> {
    const resolved = path.resolve(sourcePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, error: '所选文件不存在或无法读取。' };
    }
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, error: '请选择有效的非空图片或视频文件。' };
    }

    const ext = path.extname(resolved).toLowerCase();
    const mimeType = WALLPAPER_MIME_TYPES[ext];
    if (!mimeType) {
      return { ok: false, error: '仅支持 PNG、JPG、WebP、AVIF、GIF、MP4、WebM 格式。' };
    }

    const isVideo = VIDEO_EXTS.has(ext);
    const maxBytes = isVideo ? MAX_WALLPAPER_VIDEO_BYTES : MAX_WALLPAPER_IMAGE_BYTES;
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: isVideo ? '视频文件不能超过 150 MB。' : '图片/动图文件不能超过 40 MB。',
      };
    }

    this.ensureDir();
    const digest = await hashFilePrefix(resolved);
    const filename = `wp-${digest}${ext}`;
    const destPath = path.join(this.wallpapersDir, filename);
    const tempPath = path.join(this.wallpapersDir, `.tmp-${crypto.randomUUID()}${ext}`);

    try {
      await fs.promises.copyFile(resolved, tempPath);
      if (fs.existsSync(destPath)) {
        fs.rmSync(tempPath, { force: true });
      } else {
        fs.renameSync(tempPath, destPath);
      }
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      return {
        ok: false,
        error: `壁纸导入失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const mediaKind = resolveMediaKind(ext, destPath);
    const asset: WallpaperAsset = {
      filename,
      originalName: path.basename(resolved),
      mediaKind,
      mimeType,
      bytes: stat.size,
      importedAt: Date.now(),
    };

    this.writeManifest(asset);
    this.cleanupOtherFiles(new Set([filename]));
    return { ok: true, asset };
  }

  async choose(parentWindow?: BrowserWindow | null): Promise<WallpaperImportResult> {
    const options: Electron.OpenDialogOptions = {
      title: '选择背景媒体（图片 / GIF / 视频）',
      properties: ['openFile'],
      filters: [
        {
          name: '背景媒体',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'mp4', 'webm'],
        },
      ],
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return this.importFromPath(result.filePaths[0]!);
  }

  savePoster(input: {
    filename: string;
    dataUrl: string;
    width?: number;
    height?: number;
    durationSec?: number;
  }): WallpaperAsset | null {
    const current = this.getCurrent();
    if (!current || current.filename !== input.filename) return current;

    let nextPoster = current.posterFilename;
    const match = /^data:(image\/webp|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl);
    if (match) {
      const ext = match[1] === 'image/jpeg' ? '.jpg' : '.webp';
      const bytes = Buffer.from(match[2]!, 'base64');
      if (bytes.byteLength > 0 && bytes.byteLength <= MAX_POSTER_BYTES) {
        const stem = current.filename.replace(/\.[^.]+$/, '');
        const posterFilename = `poster-${stem.replace(/^wp-/, '')}${ext}`;
        const tmp = path.join(this.wallpapersDir, `.tmp-${crypto.randomUUID()}${ext}`);
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, path.join(this.wallpapersDir, posterFilename));
        nextPoster = posterFilename;
      }
    }

    const updated: WallpaperAsset = {
      ...current,
      ...(nextPoster ? { posterFilename: nextPoster } : {}),
      ...(typeof input.width === 'number' && input.width > 0 ? { width: Math.round(input.width) } : {}),
      ...(typeof input.height === 'number' && input.height > 0 ? { height: Math.round(input.height) } : {}),
      ...(typeof input.durationSec === 'number' && input.durationSec > 0
        ? { durationSec: Number(input.durationSec.toFixed(1)) }
        : {}),
    };

    this.writeManifest(updated);
    const keep = new Set([updated.filename]);
    if (updated.posterFilename) keep.add(updated.posterFilename);
    this.cleanupOtherFiles(keep);
    return updated;
  }

  clear(): { ok: boolean } {
    if (!fs.existsSync(this.wallpapersDir)) return { ok: true };
    try {
      fs.rmSync(this.manifestPath(), { force: true });
      this.cleanupOtherFiles(new Set());
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}
