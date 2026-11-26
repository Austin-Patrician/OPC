import fs from 'node:fs';
import path from 'node:path';
import type { ShortcutDetails } from 'electron';

export const APP_USER_MODEL_ID = 'com.opc.agent.workspace';
export const APP_PRODUCT_NAME = 'OPC Agent 工作台';

export interface BrandIconResolveOptions {
  mainDir: string;
  appPath: string;
  resourcesPath?: string;
  packaged: boolean;
  existsSync?: (candidate: string) => boolean;
}

/**
 * Resolves the desktop brand icon path across Electron Vite dev (`out/main`) and
 * packaged (`resources/brand`, outside `app.asar` so Windows Shell / Toast can read it).
 */
export function resolveBrandIconPath(
  kind: 'ico' | 'png',
  options: BrandIconResolveOptions,
): string | undefined {
  const exists = options.existsSync ?? fs.existsSync;
  const filename = kind === 'ico' ? 'icon.ico' : 'icon.png';

  const candidates: string[] = [];
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, 'brand', filename));
  }
  // `mainDir` is `<repo>/out/main` in dev/preview builds.
  candidates.push(path.resolve(options.mainDir, '../../build', filename));
  candidates.push(path.join(options.appPath, 'build', filename));
  if (options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, 'brand', filename));
  }

  if (kind === 'png') {
    candidates.push(
      path.join(options.mainDir, '../renderer/favicon.png'),
      path.resolve(options.mainDir, '../../apps/renderer/public/favicon.png'),
      path.join(options.appPath, 'apps/renderer/public/favicon.png'),
    );
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export interface EnsureWindowsDevShortcutOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  headless: boolean;
  appDataDir: string;
  execPath: string;
  appPath: string;
  cwd: string;
  scriptArg?: string;
  iconPath?: string;
  existsSync?: (target: string) => boolean;
  mkdirSync?: (dir: string, opts: { recursive: boolean }) => unknown;
  readShortcutLink?: (shortcutPath: string) => ShortcutDetails;
  writeShortcutLink?: (
    shortcutPath: string,
    operation: 'create' | 'update' | 'replace',
    details: ShortcutDetails,
  ) => boolean;
}

/**
 * Registers/updates a Start Menu shortcut for unpackaged Windows dev runs so
 * Windows 10/11 Toast notifications associate `APP_USER_MODEL_ID` with OPC's
 * brand icon & display name rather than `electron.exe` defaults.
 */
export function ensureWindowsDevStartMenuShortcut(
  options: EnsureWindowsDevShortcutOptions,
): boolean {
  if (
    options.platform !== 'win32' ||
    options.packaged ||
    options.headless ||
    !options.iconPath ||
    !options.readShortcutLink ||
    !options.writeShortcutLink
  ) {
    return false;
  }

  const exists = options.existsSync ?? fs.existsSync;
  const mkdir = options.mkdirSync ?? fs.mkdirSync;
  const programsDir = path.join(
    options.appDataDir,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  const shortcutPath = path.join(programsDir, `${APP_PRODUCT_NAME} (Dev).lnk`);

  const entryTarget =
    options.scriptArg && options.scriptArg.trim().length > 0 && !options.scriptArg.startsWith('-')
      ? path.resolve(options.scriptArg)
      : path.resolve(options.appPath);
  const args = `"${entryTarget}"`;
  const icon = path.resolve(options.iconPath);
  const details: ShortcutDetails = {
    target: options.execPath,
    args,
    cwd: options.cwd,
    icon,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    description: `${APP_PRODUCT_NAME} (Dev)`,
  };

  try {
    const alreadyExists = exists(shortcutPath);
    if (alreadyExists) {
      try {
        const current = options.readShortcutLink(shortcutPath);
        if (
          current.target.toLowerCase() === options.execPath.toLowerCase() &&
          (current.args ?? '') === args &&
          (current.icon ?? '').toLowerCase() === icon.toLowerCase() &&
          current.appUserModelId === APP_USER_MODEL_ID
        ) {
          return true;
        }
      } catch {
        // Re-write broken/unreadable shortcut link below.
      }
    } else {
      mkdir(programsDir, { recursive: true });
    }
    return options.writeShortcutLink(
      shortcutPath,
      alreadyExists ? 'replace' : 'create',
      details,
    );
  } catch {
    return false;
  }
}
