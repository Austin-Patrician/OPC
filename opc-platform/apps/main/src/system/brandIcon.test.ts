import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_PRODUCT_NAME,
  APP_USER_MODEL_ID,
  ensureWindowsDevStartMenuShortcut,
  resolveBrandIconPath,
} from './brandIcon';

describe('resolveBrandIconPath', () => {
  it('prefers resources/brand when packaged and repo build/icon in dev', () => {
    const prodPath = path.join('C:', 'App', 'resources', 'brand', 'icon.ico');
    expect(
      resolveBrandIconPath('ico', {
        mainDir: path.join('C:', 'App', 'resources', 'app.asar', 'out', 'main'),
        appPath: path.join('C:', 'App', 'resources', 'app.asar'),
        resourcesPath: path.join('C:', 'App', 'resources'),
        packaged: true,
        existsSync: (candidate) => candidate === prodPath,
      }),
    ).toBe(prodPath);

    const devIco = path.resolve('/repo/out/main', '../../build', 'icon.ico');
    expect(
      resolveBrandIconPath('ico', {
        mainDir: '/repo/out/main',
        appPath: '/repo/out/main',
        packaged: false,
        existsSync: (candidate) => candidate === devIco,
      }),
    ).toBe(devIco);

    const devFavicon = path.resolve('/repo/out/main', '../../apps/renderer/public/favicon.png');
    expect(
      resolveBrandIconPath('png', {
        mainDir: '/repo/out/main',
        appPath: '/repo/out/main',
        packaged: false,
        existsSync: (candidate) => candidate === devFavicon,
      }),
    ).toBe(devFavicon);
  });
});

describe('ensureWindowsDevStartMenuShortcut', () => {
  it('is a no-op outside Windows unpackaged interactive launches', () => {
    const write = vi.fn(() => true);
    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'darwin',
        packaged: false,
        headless: false,
        appDataDir: 'C:\\Users\\a\\AppData\\Roaming',
        execPath: 'C:\\electron.exe',
        appPath: 'E:\\repo\\out\\main',
        cwd: 'E:\\repo',
        iconPath: 'E:\\repo\\build\\icon.ico',
        readShortcutLink: vi.fn(),
        writeShortcutLink: write,
      }),
    ).toBe(false);
    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'win32',
        packaged: true,
        headless: false,
        appDataDir: 'C:\\Users\\a\\AppData\\Roaming',
        execPath: 'C:\\app.exe',
        appPath: 'C:\\resources\\app.asar',
        cwd: 'C:\\',
        iconPath: 'C:\\resources\\brand\\icon.ico',
        readShortcutLink: vi.fn(),
        writeShortcutLink: write,
      }),
    ).toBe(false);
    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'win32',
        packaged: false,
        headless: true,
        appDataDir: 'C:\\Users\\a\\AppData\\Roaming',
        execPath: 'C:\\electron.exe',
        appPath: 'E:\\repo\\out\\main',
        cwd: 'E:\\repo',
        iconPath: 'E:\\repo\\build\\icon.ico',
        readShortcutLink: vi.fn(),
        writeShortcutLink: write,
      }),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('creates when missing, skips when matching, and replaces when stale', () => {
    const icon = path.resolve('build/icon.ico');
    const script = path.resolve('out/main/index.js');
    const appDataDir = path.join('C:', 'Users', 'u', 'AppData', 'Roaming');
    const expectedShortcut = path.join(
      appDataDir,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${APP_PRODUCT_NAME} (Dev).lnk`,
    );

    const mkdir = vi.fn();
    const write = vi.fn(() => true);
    const read = vi.fn(() => ({
      target: 'C:\\node_modules\\electron\\electron.exe',
      args: `"${script}"`,
      icon,
      appUserModelId: APP_USER_MODEL_ID,
    }));

    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'win32',
        packaged: false,
        headless: false,
        appDataDir,
        execPath: 'C:\\node_modules\\electron\\electron.exe',
        appPath: 'E:\\repo\\out\\main',
        cwd: 'E:\\repo',
        scriptArg: script,
        iconPath: icon,
        existsSync: () => false,
        mkdirSync: mkdir,
        readShortcutLink: read,
        writeShortcutLink: write,
      }),
    ).toBe(true);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expectedShortcut,
      'create',
      expect.objectContaining({
        appUserModelId: APP_USER_MODEL_ID,
        icon,
        iconIndex: 0,
      }),
    );

    write.mockClear();
    // Matching shortcut does not rewrite.
    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'win32',
        packaged: false,
        headless: false,
        appDataDir,
        execPath: 'C:\\node_modules\\electron\\electron.exe',
        appPath: 'E:\\repo\\out\\main',
        cwd: 'E:\\repo',
        scriptArg: script,
        iconPath: icon,
        existsSync: () => true,
        mkdirSync: mkdir,
        readShortcutLink: read,
        writeShortcutLink: write,
      }),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();

    // Stale icon gets replaced.
    read.mockReturnValueOnce({
      target: 'C:\\node_modules\\electron\\electron.exe',
      args: `"${script}"`,
      icon: 'C:\\old.ico',
      appUserModelId: APP_USER_MODEL_ID,
    });
    expect(
      ensureWindowsDevStartMenuShortcut({
        platform: 'win32',
        packaged: false,
        headless: false,
        appDataDir,
        execPath: 'C:\\node_modules\\electron\\electron.exe',
        appPath: 'E:\\repo\\out\\main',
        cwd: 'E:\\repo',
        scriptArg: script,
        iconPath: icon,
        existsSync: () => true,
        mkdirSync: mkdir,
        readShortcutLink: read,
        writeShortcutLink: write,
      }),
    ).toBe(true);
    expect(write).toHaveBeenCalledWith(expectedShortcut, 'replace', expect.any(Object));
  });
});
