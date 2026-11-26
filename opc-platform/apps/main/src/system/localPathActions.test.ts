import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBlockedExecutablePath,
  isSafeExternalUrl,
  resolveLocalPathForAction,
  runSafeOpenLocalPath,
  runSafeRevealLocalPath,
  stripLineColumnSuffix,
} from './localPathActions';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-path-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('localPathActions', () => {
  it('validates allowed external protocols cleanly', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
    expect(isSafeExternalUrl('mailto:alice@example.com?subject=Hi')).toBe(true);
    expect(isSafeExternalUrl('mailto:invalid')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/foo.txt')).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:foo')).toBe(false);
  });

  it('strips :line and :line:col suffixes without touching drive letters', () => {
    expect(stripLineColumnSuffix('E:\\code\\App.tsx:42:10')).toBe('E:\\code\\App.tsx');
    expect(stripLineColumnSuffix('/Users/alice/main.ts:18')).toBe('/Users/alice/main.ts');
    expect(stripLineColumnSuffix('C:\\')).toBe('C:\\');
  });

  it('blocks UNC network share paths and remote file:// URLs', () => {
    expect(resolveLocalPathForAction('\\\\attacker\\share\\file.txt')).toEqual({
      ok: false,
      error: '出于安全考虑，不支持网络共享或设备路径',
    });
    expect(resolveLocalPathForAction('file://attacker-host/share/file.txt')).toEqual({
      ok: false,
      error: '不支持打开远程共享路径',
    });
  });

  it('resolves existing local files, relative baseDirs, and blocks executables on open', async () => {
    const dir = makeTempDir();
    const docPath = path.join(dir, 'summary.md');
    const exePath = path.join(dir, 'installer.exe');
    const scriptPath = path.join(dir, 'run.ps1');
    fs.writeFileSync(docPath, '# hello', 'utf8');
    fs.writeFileSync(exePath, 'binary', 'utf8');
    fs.writeFileSync(scriptPath, 'Write-Host 1', 'utf8');

    const openSpy = vi.fn(async () => '');
    const revealSpy = vi.fn();

    // Open regular document by relative path + :line suffix
    const relOpen = await runSafeOpenLocalPath('./summary.md:12', {
      baseDirs: [dir],
      openPath: openSpy,
    });
    expect(relOpen).toEqual({ ok: true });
    expect(openSpy).toHaveBeenCalledWith(docPath);

    // Block .exe and .ps1 direct execution
    expect(isBlockedExecutablePath(exePath)).toBe(true);
    const exeOpen = await runSafeOpenLocalPath(exePath, { openPath: openSpy });
    expect(exeOpen.ok).toBe(false);
    expect(exeOpen.blockedExecutable).toBe(true);

    const scriptOpen = await runSafeOpenLocalPath(scriptPath, { openPath: openSpy });
    expect(scriptOpen.ok).toBe(false);
    expect(scriptOpen.blockedExecutable).toBe(true);

    // Reveal still works safely even for executable artifacts (never runs them)
    const revealed = runSafeRevealLocalPath(exePath, { showItemInFolder: revealSpy });
    expect(revealed).toEqual({ ok: true });
    expect(revealSpy).toHaveBeenCalledWith(exePath);

    // Non-existent path returns clear error
    const missing = await runSafeOpenLocalPath(path.join(dir, 'missing.pdf'), {
      openPath: openSpy,
    });
    expect(missing).toEqual({ ok: false, error: '本机未找到该文件或目录' });
  });
});
