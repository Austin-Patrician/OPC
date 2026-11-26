import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { parseByteRange, resolveWallpaperAssetPath, WALLPAPER_CORS_HEADERS } from './wallpaperProtocol';
import { detectAnimatedWebp, WallpaperService } from './wallpaperService';

describe('wallpaperProtocol helpers', () => {
  it('导出允许跨域与 canvas 导出首帧的 CORS 响应头', () => {
    expect(WALLPAPER_CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
    expect(WALLPAPER_CORS_HEADERS['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(WALLPAPER_CORS_HEADERS['Access-Control-Expose-Headers']).toContain('Content-Range');
  });

  it('正确解析完整、部分、后缀范围并拒绝越界 Range', () => {
    expect(parseByteRange(null, 1000)).toBeNull();
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ invalid: false, start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ invalid: false, start: 500, end: 999 });
    expect(parseByteRange('bytes=500-5000', 1000)).toEqual({ invalid: false, start: 500, end: 999 });
    expect(parseByteRange('bytes=-128', 1000)).toEqual({ invalid: false, start: 872, end: 999 });
    expect(parseByteRange('bytes=1200-1300', 1000)).toEqual({ invalid: true });
    expect(parseByteRange('bytes=200-100', 1000)).toEqual({ invalid: true });
    expect(parseByteRange('items=0-10', 1000)).toEqual({ invalid: true });
  });

  it('拦截路径穿越与非法后缀，仅允许安全壁纸文件', () => {
    const dir = path.resolve('C:\\tmp\\wallpapers');
    expect(resolveWallpaperAssetPath(dir, '/wp-abc123.mp4')).toBe(
      path.resolve(dir, 'wp-abc123.mp4'),
    );
    expect(resolveWallpaperAssetPath(dir, '/poster-abc123.webp')).toBe(
      path.resolve(dir, 'poster-abc123.webp'),
    );
    expect(resolveWallpaperAssetPath(dir, '/../secret.png')).toBeNull();
    expect(resolveWallpaperAssetPath(dir, '/sub/dir.png')).toBeNull();
    expect(resolveWallpaperAssetPath(dir, '/wp-abc.exe')).toBeNull();
  });
});

describe('detectAnimatedWebp', () => {
  it('区分静态 VP8 与带 VP8X 动画位的动态 WebP', () => {
    const staticWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x00, 0, 0, 0,
    ]);
    const animatedWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x02, 0, 0, 0,
    ]);
    expect(detectAnimatedWebp(staticWebp)).toBe(false);
    expect(detectAnimatedWebp(animatedWebp)).toBe(true);
  });
});

describe('WallpaperService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-wallpaper-'));
    tempDirs.push(dir);
    return dir;
  };

  it('导入 PNG / GIF / MP4、识别类型、保存 Poster 并自动清理旧文件', async () => {
    const root = makeTemp();
    const wallpapersDir = path.join(root, 'wallpapers');
    const sourcePng = path.join(root, 'scene.png');
    const sourceMp4 = path.join(root, 'loop.mp4');
    fs.writeFileSync(sourcePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.writeFileSync(sourceMp4, Buffer.from('fake-mp4-stream-payload'));

    const service = new WallpaperService(wallpapersDir);

    const pngRes = await service.importFromPath(sourcePng);
    expect(pngRes.ok).toBe(true);
    expect(pngRes.asset?.mediaKind).toBe('image');
    const oldFilename = pngRes.asset!.filename;
    expect(fs.existsSync(path.join(wallpapersDir, oldFilename))).toBe(true);

    const mp4Res = await service.importFromPath(sourceMp4);
    expect(mp4Res.ok).toBe(true);
    expect(mp4Res.asset?.mediaKind).toBe('video');
    expect(fs.existsSync(path.join(wallpapersDir, oldFilename))).toBe(false);

    const fakeWebpBase64 = Buffer.from('poster-bytes').toString('base64');
    const updated = service.savePoster({
      filename: mp4Res.asset!.filename,
      dataUrl: `data:image/webp;base64,${fakeWebpBase64}`,
      width: 1920,
      height: 1080,
      durationSec: 12.4,
    });
    expect(updated?.posterFilename).toMatch(/^poster-.*\.webp$/);
    expect(updated?.width).toBe(1920);
    expect(updated?.durationSec).toBe(12.4);
    expect(service.getCurrent()?.posterFilename).toBe(updated?.posterFilename);

    expect(service.clear()).toEqual({ ok: true });
    expect(service.getCurrent()).toBeNull();
    expect(fs.readdirSync(wallpapersDir)).toEqual([]);
  });

  it('拒绝不支持的扩展名', async () => {
    const root = makeTemp();
    const service = new WallpaperService(path.join(root, 'wallpapers'));
    const badFile = path.join(root, 'bad.txt');
    fs.writeFileSync(badFile, 'hello');

    const res = await service.importFromPath(badFile);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('仅支持');
  });
});
