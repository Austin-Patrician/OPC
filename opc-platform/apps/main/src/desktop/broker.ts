import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app as electronApp, nativeImage } from 'electron';
import type {
  DesktopAppView,
  DesktopInstallProgress,
  DesktopPreviewResult,
  DesktopSettings,
  DesktopWindowView,
} from '@opc/shared/ipc';
import type { DesktopInstallService } from './install';
import { isAppBlocked, type DesktopRefMeta } from './policy';
import type { DesktopCaptureFrame } from './vision';
import { execFilePlatform } from '../process/execFilePlatform';
import { connectMcp, type McpConnection } from '../mcp/connection';
import type { McpServerConfig } from '../mcp/contract';

const execFileAsync = promisify(execFile);

let applicationCatalogPromise: Promise<Map<string, string>> | undefined;
let linuxDesktopEntriesPromise: Promise<LinuxDesktopEntry[]> | undefined;
const iconCache = new Map<string, Promise<string | undefined>>();

interface LinuxDesktopEntry {
  name: string;
  executable: string;
  icon: string;
  fileName: string;
}

function linuxDesktopRoots(): string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(path.delimiter);
  return [...new Set([
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'applications'),
    ...dataDirs.map((directory) => path.join(directory, 'applications')),
  ])].filter((directory) => fs.existsSync(directory));
}

function readDesktopEntry(filePath: string): LinuxDesktopEntry | undefined {
  let contents: string;
  try { contents = fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
  const section = contents.split(/^\s*\[Desktop Entry\]\s*$/m)[1]?.split(/^\s*\[/m)[0];
  if (!section || /^\s*(?:Hidden|NoDisplay)=true\s*$/im.test(section)) return undefined;
  const field = (key: string) => section.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.replace(/\\([snrt\\])/g, (_match, code: string) => ({ s: ' ', n: '\n', r: '\r', t: '\t', '\\': '\\' })[code] ?? code).trim() ?? '';
  const name = field('Name');
  const icon = field('Icon');
  const command = field('Exec').replace(/%[fFuUdDnNickvm]/g, '').trim().replace(/^env\s+/, '');
  const executable = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) ?? '';
  return name && icon ? { name, executable: path.basename(executable).toLowerCase(), icon, fileName: path.basename(filePath, '.desktop').toLowerCase() } : undefined;
}

async function linuxDesktopEntries(): Promise<LinuxDesktopEntry[]> {
  if (process.platform !== 'linux') return [];
  if (linuxDesktopEntriesPromise) return linuxDesktopEntriesPromise;
  linuxDesktopEntriesPromise = (async () => {
    const files: string[] = [];
    const visit = (directory: string, depth: number): void => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith('.desktop')) files.push(target);
        else if (entry.isDirectory()) visit(target, depth + 1);
      }
    };
    linuxDesktopRoots().forEach((root) => visit(root, 0));
    return files.map(readDesktopEntry).filter((entry): entry is LinuxDesktopEntry => Boolean(entry));
  })();
  return linuxDesktopEntriesPromise;
}

function normalizedAppName(value: string): string {
  return value.toLowerCase().replace(/\s+(?:helper|renderer|gpu|crashpad)(?:\s*\([^)]*\))?$/i, '').trim();
}

async function linuxDesktopIcon(name: string, executablePath?: string): Promise<string | undefined> {
  const entries = await linuxDesktopEntries();
  const normalizedName = normalizedAppName(name);
  const executable = executablePath ? path.basename(executablePath).toLowerCase() : '';
  const entry = entries.find((item) => item.name.toLowerCase() === normalizedName || item.fileName === normalizedName)
    ?? (executable ? entries.find((item) => item.executable === executable) : undefined);
  if (!entry) return undefined;
  if (path.isAbsolute(entry.icon)) return imageFileDataUrl(entry.icon);

  const dataRoots = (process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(path.delimiter);
  const iconRoots = [
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'icons'),
    ...dataRoots.map((directory) => path.join(directory, 'icons')),
    ...dataRoots.map((directory) => path.join(directory, 'pixmaps')),
    path.join(os.homedir(), '.icons'),
  ];
  const configPath = path.join(os.homedir(), '.config', 'gtk-3.0', 'settings.ini');
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const theme = config.match(/^gtk-icon-theme-name\s*=\s*(.+)$/m)?.[1]?.trim() || 'hicolor';
  const themes = [...new Set([theme, 'hicolor', 'Adwaita'])];
  const iconNames = [...new Set([entry.icon, entry.icon.replace(/\.(?:png|svg|xpm)$/i, '')])];
  const sizes = ['512x512', '256x256', 'scalable', '128x128', '96x96', '64x64', '48x48', '32x32', '24x24', '16x16'];
  const extensions = ['png', 'svg', 'xpm'];
  const candidates = [
    ...iconRoots.flatMap((root) => iconNames.flatMap((iconName) => [
      ...themes.flatMap((themeName) => sizes.flatMap((size) => extensions.map((extension) => path.join(root, themeName, size, 'apps', `${iconName}.${extension}`)))),
      ...extensions.map((extension) => path.join(root, `${iconName}.${extension}`)),
    ])),
  ];
  for (const candidate of candidates) {
    const icon = imageFileDataUrl(candidate);
    if (icon) return icon;
  }
  return undefined;
}

function imageFileDataUrl(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  if (path.extname(filePath).toLowerCase() === '.svg') {
    return `data:image/svg+xml;base64,${fs.readFileSync(filePath).toString('base64')}`;
  }
  const image = nativeImage.createFromPath(filePath);
  return image.isEmpty() ? undefined : image.toDataURL();
}

async function processExecutablePath(pid: unknown): Promise<string | undefined> {
  const id = typeof pid === 'number' ? pid : typeof pid === 'string' && /^\d+$/.test(pid) ? Number(pid) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  if (process.platform === 'linux') {
    try { return await fs.promises.realpath(`/proc/${id}/exe`); } catch { return undefined; }
  }
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${id} -ErrorAction SilentlyContinue; if ($p) { $p.Path }`;
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000, maxBuffer: 8_000 }).catch(() => ({ stdout: '' }));
    const executable = result.stdout.trim();
    return executable && fs.existsSync(executable) ? executable : undefined;
  }
  return undefined;
}

function applicationRoots(): string[] {
  return ['/Applications', '/System/Applications', '/System/Library/CoreServices', path.join(process.env.HOME ?? '', 'Applications')]
    .filter((root, index, roots) => root && roots.indexOf(root) === index && fs.existsSync(root));
}

async function applicationCatalog(): Promise<Map<string, string>> {
  if (process.platform !== 'darwin') return new Map();
  if (applicationCatalogPromise) return applicationCatalogPromise;
  applicationCatalogPromise = (async () => {
    const catalog = new Map<string, string>();
    const roots = applicationRoots();
    const apps: string[] = [];
    const visit = (directory: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const appPath = path.join(directory, entry.name);
        if (entry.name.endsWith('.app')) apps.push(appPath);
        else visit(appPath, depth + 1);
      }
    };
    roots.forEach((root) => visit(root, 0));
    await Promise.all(apps.map(async (appPath) => {
      const plist = path.join(appPath, 'Contents', 'Info.plist');
      const idResult = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 1_000, maxBuffer: 4_000 }).catch(() => ({ stdout: '' }));
      const bundleId = idResult.stdout.trim();
      if (bundleId) catalog.set(`bundle:${bundleId.toLowerCase()}`, appPath);
      catalog.set(`name:${path.basename(appPath, '.app').toLowerCase()}`, appPath);
    }));
    return catalog;
  })();
  return applicationCatalogPromise;
}

async function applicationPath(bundleId: string, name: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  if (bundleId) {
    const query = `kMDItemCFBundleIdentifier == '${bundleId.replaceAll("'", "\\'")}'c`;
    const result = await execFileAsync('/usr/bin/mdfind', [query], { timeout: 3_000, maxBuffer: 32_000 }).catch(() => ({ stdout: '' }));
    const match = result.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item.endsWith('.app') && fs.existsSync(item));
    if (match) return match;
  }
  for (const root of ['/Applications', path.join(process.env.HOME ?? '', 'Applications')]) {
    const candidate = path.join(root, `${name}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const catalog = await applicationCatalog();
  const exact = catalog.get(`bundle:${bundleId.toLowerCase()}`) ?? catalog.get(`name:${name.toLowerCase()}`);
  if (exact) return exact;
  const normalized = name.toLowerCase().replace(/\s+(helper|renderer|gpu|crashpad)(?:\s*\([^)]*\))?$/i, '').trim();
  if (normalized !== name.toLowerCase()) return catalog.get(`name:${normalized}`);
  return undefined;
}

async function applicationIcon(bundleId: string, name: string, executablePath?: string, pid?: unknown): Promise<string | undefined> {
  const cacheKey = `${bundleId}\n${name}\n${executablePath ?? ''}\n${String(pid ?? '')}`;
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;
  const pending = loadApplicationIcon(bundleId, name, executablePath, pid);
  iconCache.set(cacheKey, pending);
  return pending;
}

async function loadApplicationIcon(bundleId: string, name: string, executablePath?: string, pid?: unknown): Promise<string | undefined> {
  if (process.platform === 'win32' || process.platform === 'linux') {
    const processPath = executablePath && fs.existsSync(executablePath) ? executablePath : await processExecutablePath(pid);
    if (process.platform === 'linux') {
      const desktopIcon = await linuxDesktopIcon(name, processPath);
      if (desktopIcon) return desktopIcon;
    }
    if (processPath) {
      const image = await electronApp.getFileIcon(processPath, { size: 'large' }).catch(() => nativeImage.createEmpty());
      if (!image.isEmpty()) return image.toDataURL();
    }
    return undefined;
  }

  const directPath = executablePath
    ? (executablePath.endsWith('.app') ? executablePath : executablePath.split('/Contents/')[0])
    : undefined;
  const directBundle = directPath && path.extname(directPath) === '.app' && fs.existsSync(path.join(directPath, 'Contents', 'Info.plist')) ? directPath : undefined;
  const appPath = directBundle ?? await applicationPath(bundleId, name);
  if (!appPath) return undefined;
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const plistResult = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 2_000, maxBuffer: 64_000 }).catch(() => ({ stdout: '' }));
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(plistResult.stdout) as Record<string, unknown>; } catch { /* invalid or unreadable plist */ }
  const resourceDir = path.join(appPath, 'Contents', 'Resources');
  const iconNames = [metadata.CFBundleIconFile, metadata.CFBundleIconName, metadata.CFBundleIconFiles]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
  const candidates = [...iconNames, 'AppIcon', 'app']
    .flatMap((iconName) => [iconName, iconName.endsWith('.icns') ? iconName : `${iconName}.icns`])
    .map((iconName) => path.join(resourceDir, iconName))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  try {
    const resourceEntries = fs.readdirSync(resourceDir, { withFileTypes: true });
    for (const entry of resourceEntries) {
      if (entry.isFile() && /(?:app|application|icon)/i.test(entry.name) && entry.name.toLowerCase().endsWith('.icns')) candidates.push(path.join(resourceDir, entry.name));
    }
  } catch { /* the app may have no readable resources directory */ }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-desktop-icon-'));
    const pngPath = path.join(tempDir, 'icon.png');
    try {
      await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', candidate, '--out', pngPath], { timeout: 5_000, maxBuffer: 8_000 });
      const icon = nativeImage.createFromBuffer(fs.readFileSync(pngPath));
      if (!icon.isEmpty()) return icon.toDataURL();
    } catch { /* try the next icon resource */ }
    finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  }
  return undefined;
}

export interface DesktopSessionInput { taskId: string; workerId: string; appId?: string; windowId?: string; }
export interface DesktopResult { ok: boolean; text: string; data?: unknown; details?: Record<string, unknown>; }
interface Session extends DesktopSessionInput { id: string; lastUsedAt: number; headed: boolean; }

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowDetail extends DesktopWindowView {
  visible?: boolean;
  accessible?: boolean;
  focused?: boolean;
  bounds?: DesktopWindowBounds;
}

export interface DesktopDisplayDetail {
  id: string;
  isPrimary: boolean;
  scale: number;
  bounds: DesktopWindowBounds;
}

/** A native session is only valid when the runtime returned its real id. */
export function desktopSessionId(result: DesktopResult): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== 'object') return undefined;
  const value = result.data as Record<string, unknown>;
  return typeof value.session_id === 'string' && value.session_id.trim() ? value.session_id.trim() : undefined;
}

export function desktopSessionName(taskId: string): string {
  const readable = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'task';
  const digest = crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 12);
  return `opc-${readable}-${digest}`;
}

/** Extracts stdout/stderr strings even when child_process rejects on non-zero exit. */
export function extractExecErrorOutput(error: unknown): { stdout: string; stderr: string } {
  const candidate = error as { stdout?: unknown; stderr?: unknown } | null | undefined;
  const stdout = typeof candidate?.stdout === 'string' ? candidate.stdout : '';
  const rawStderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const stderr = rawStderr.trim()
    ? rawStderr
    : error instanceof Error
      ? error.message
      : String(error);
  return { stdout, stderr };
}

/** Parses the SID column from `whoami /user /fo csv /nh` output (`"DOMAIN\\user","S-1-5-..."`). */
export function parseCurrentUserSid(csv: string): string | undefined {
  const trimmed = csv.trim();
  if (!trimmed) return undefined;
  const match = /"(S-1-[0-9-]+)"/.exec(trimmed);
  return match?.[1];
}

function toStringEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function parseEnvelope(text: string): { ok: boolean; data?: unknown; error?: { code?: string; message?: string; disposition?: unknown } } | undefined {
  try { return JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code?: string; message?: string; disposition?: unknown } }; } catch { return undefined; }
}

const APP_SCOPED_COMMANDS = new Set([
  'snapshot',
  'find',
  'screenshot',
  'press',
  'focus-window',
  'list-surfaces',
  'resize-window',
  'move-window',
  'minimize',
  'maximize',
  'restore',
]);

const WINDOW_SCOPED_COMMANDS = new Set([
  'snapshot',
  'find',
  'screenshot',
  'press',
  'focus-window',
  'list-surfaces',
  'resize-window',
  'move-window',
  'minimize',
  'maximize',
  'restore',
]);

/** Translates raw driver screenshot errors into actionable OS permission instructions. */
export function formatDesktopScreenshotError(
  rawText: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawText.trim();
  if (/screen\s*recording/i.test(trimmed)) {
    if (platform === 'darwin') {
      return '桌面截图失败：尚未授予 macOS「屏幕录制」权限。请打开「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」，勾选「OPC Agent 工作台」（若从开发终端/IDE 启动，请同时勾选对应的终端/IDE 与 Electron），然后完全退出并重启应用后重试。';
    }
    return `桌面截图失败：缺少系统屏幕录制权限（${trimmed}）。请在系统权限设置中授权并重启应用后重试。`;
  }
  return trimmed || '桌面截图失败';
}

export function desktopCommandOptions(command: string, appId?: string, windowId?: string): string[] {
  // agent-desktop treats these as subcommand options. Ref actions already carry
  // their snapshot scope and reject unrelated --app/--window-id flags.
  const out: string[] = [];
  if (appId && APP_SCOPED_COMMANDS.has(command)) {
    out.push('--app', appId);
  }
  if (windowId && WINDOW_SCOPED_COMMANDS.has(command)) {
    out.push('--window-id', windowId);
  }
  return out;
}

function parseBounds(raw: unknown): DesktopWindowBounds | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const x = typeof value.x === 'number' ? value.x : NaN;
  const y = typeof value.y === 'number' ? value.y : NaN;
  const width = typeof value.width === 'number' ? value.width : NaN;
  const height = typeof value.height === 'number' ? value.height : NaN;
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

/**
 * Walks an `agent-desktop snapshot` JSON envelope and indexes every addressable `@ref_id`
 * so downstream risk guards and trace summaries know which control a ref points to.
 */
export function indexSnapshotRefs(
  data: unknown,
  fallbackApp?: string,
  fallbackWindowId?: string,
): Map<string, DesktopRefMeta> {
  const index = new Map<string, DesktopRefMeta>();
  if (!data || typeof data !== 'object') return index;

  const record = data as Record<string, unknown>;
  const app = typeof record.app === 'string' && record.app.trim() ? record.app.trim() : fallbackApp;
  const windowId =
    typeof record.window_id === 'string' && record.window_id.trim()
      ? record.window_id.trim()
      : fallbackWindowId;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ref =
      typeof obj.ref_id === 'string' && obj.ref_id.trim()
        ? obj.ref_id.trim()
        : typeof obj.ref === 'string' && obj.ref.trim()
          ? obj.ref.trim()
          : undefined;

    if (ref) {
      const role = typeof obj.role === 'string' ? obj.role : undefined;
      const name =
        typeof obj.name === 'string' && obj.name.trim()
          ? obj.name.trim()
          : typeof obj.title === 'string' && obj.title.trim()
            ? obj.title.trim()
            : typeof obj.label === 'string' && obj.label.trim()
              ? obj.label.trim()
              : undefined;
      const value = typeof obj.value === 'string' && obj.value.trim() ? obj.value.trim() : undefined;
      const bounds = parseBounds(obj.bounds);
      const nodeApp = typeof obj.app === 'string' && obj.app.trim() ? obj.app.trim() : app;
      index.set(ref, {
        ref,
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(value ? { value } : {}),
        ...(nodeApp ? { app: nodeApp } : {}),
        ...(windowId ? { windowId } : {}),
        ...(bounds ? { bounds } : {}),
      });
    }

    if (Array.isArray(obj.children)) {
      for (const child of obj.children) visit(child);
    }
  };

  visit(record.tree ?? record.root ?? record.elements ?? record.nodes ?? record);
  return index;
}

function isMcpDisconnectError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'McpConnectionClosedError' ||
    /connection closed|not connected|broken pipe|epipe|eof/i.test(message);
}

/**
 * Wraps an `agent-desktop` MCP session with automatic single-flight reconnect
 * so an unexpected stdio pipe drop or native session timeout mid-task does not
 * permanently wedge a connection wrapper.
 */
export function createReconnectingDesktopMcpConnection(options: {
  open: () => Promise<McpConnection>;
  onDisconnect?: () => void;
  onReconnect?: (connection: McpConnection) => void;
}): Promise<McpConnection> {
  return options.open().then((initial) => {
    let active: McpConnection | null = initial;
    let opening: Promise<McpConnection> | undefined;
    let closed = false;
    const toolChangedListeners = new Set<() => void>();
    let unsubscribeActiveTools: (() => void) | undefined;
    let unsubscribeActiveClose: (() => void) | undefined;

    const bind = (connection: McpConnection) => {
      unsubscribeActiveTools?.();
      unsubscribeActiveClose?.();
      unsubscribeActiveTools = connection.onToolsChanged(() => {
        for (const listener of toolChangedListeners) listener();
      });
      unsubscribeActiveClose = connection.onClose?.(() => {
        if (closed || active !== connection) return;
        active = null;
        options.onDisconnect?.();
      });
    };

    bind(initial);

    const ensureConnection = async (): Promise<McpConnection> => {
      if (closed) throw new Error('agent-desktop MCP 连接已关闭');
      if (active) return active;
      if (!opening) {
        opening = options.open()
          .then((fresh) => {
            if (closed) {
              void fresh.close().catch(() => undefined);
              throw new Error('agent-desktop MCP 连接已关闭');
            }
            active = fresh;
            bind(fresh);
            options.onReconnect?.(fresh);
            return fresh;
          })
          .finally(() => {
            opening = undefined;
          });
      }
      return opening;
    };

    const reconnectFrom = async (stale: McpConnection): Promise<McpConnection> => {
      if (closed) throw new Error('agent-desktop MCP 连接已关闭');
      if (active === stale) {
        active = null;
        unsubscribeActiveTools?.();
        unsubscribeActiveClose?.();
        unsubscribeActiveTools = undefined;
        unsubscribeActiveClose = undefined;
        await stale.close().catch(() => undefined);
      }
      return ensureConnection();
    };

    const runWithReconnect = async <T>(work: (connection: McpConnection) => Promise<T>): Promise<T> => {
      const current = await ensureConnection();
      try {
        return await work(current);
      } catch (error) {
        if (closed || !isMcpDisconnectError(error)) throw error;
        const fresh = await reconnectFrom(current);
        return work(fresh);
      }
    };

    let currentConfig = initial.config;
    let currentServerInfo = initial.serverInfo;
    let currentTools = initial.tools;
    let currentResources = initial.resources;

    const syncSnapshot = (connection: McpConnection) => {
      currentConfig = connection.config;
      currentServerInfo = connection.serverInfo;
      currentTools = connection.tools;
      currentResources = connection.resources;
    };

    return {
      get config() { return active?.config ?? currentConfig; },
      get serverInfo() { return active?.serverInfo ?? currentServerInfo; },
      get tools() { return active?.tools ?? currentTools; },
      get resources() { return active?.resources ?? currentResources; },
      refreshTools: () => runWithReconnect(async (conn) => {
        const next = await conn.refreshTools();
        syncSnapshot(conn);
        return next;
      }),
      onToolsChanged: (listener) => {
        toolChangedListeners.add(listener);
        return () => { toolChangedListeners.delete(listener); };
      },
      onClose: (listener) => {
        void listener;
        return () => undefined;
      },
      callTool: (name, args) => runWithReconnect(async (conn) => {
        syncSnapshot(conn);
        return conn.callTool(name, args);
      }),
      readResource: (uri) => runWithReconnect(async (conn) => {
        syncSnapshot(conn);
        return conn.readResource(uri);
      }),
      listResourceTemplates: () => runWithReconnect(async (conn) => {
        syncSnapshot(conn);
        return conn.listResourceTemplates();
      }),
      close: async () => {
        closed = true;
        unsubscribeActiveTools?.();
        unsubscribeActiveClose?.();
        unsubscribeActiveTools = undefined;
        unsubscribeActiveClose = undefined;
        toolChangedListeners.clear();
        const closing = active ?? (opening ? await opening.catch(() => null) : null);
        active = null;
        if (closing) await closing.close();
      },
    };
  });
}

export class DesktopBroker {
  private readonly sessions = new Map<string, Session>();
  /** The exact tree that minted refs. Never validate a ref against a newer tree. */
  private readonly snapshots = new Map<string, { data: unknown; appId?: string; windowId?: string }>();
  private readonly refIndex = new Map<string, Map<string, DesktopRefMeta>>();
  private readonly captureFrames = new Map<string, DesktopCaptureFrame>();
  private readonly cursorOverlayApplied = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private visibleTask?: string;
  private mcpHealthy = false;
  private mcpToolCount = 11;
  private mcpError?: string;
  private cleanupTimer: ReturnType<typeof setInterval>;
  private desktopEnvPromise?: Promise<NodeJS.ProcessEnv | undefined>;
  private taskWorkspaceResolver?: (taskId: string) => string | undefined;
  private artifactRegistrar?: (taskId: string, absolutePath: string) => void;

  constructor(
    private readonly install: DesktopInstallService,
    private readonly artifactsDir = os.tmpdir(),
  ) {
    this.cleanupTimer = setInterval(() => { void this.cleanupIdle(); }, 10 * 60_000);
    this.cleanupTimer.unref?.();
  }

  setTaskWorkspaceResolver(resolver: (taskId: string) => string | undefined): void {
    this.taskWorkspaceResolver = resolver;
  }

  setArtifactRegistrar(registrar: (taskId: string, absolutePath: string) => void): void {
    this.artifactRegistrar = registrar;
  }

  status = () => {
    const runtime = this.install.status();
    const active = runtime.enabled && runtime.runtimeHealthy;
    return {
      ...runtime,
      runtimeHealthy: runtime.runtimeHealthy,
      healthy: runtime.runtimeHealthy && (!runtime.enabled || active),
      mcpHealthy: this.mcpHealthy || active,
      mcpToolCount: this.mcpToolCount,
      ...(this.mcpError ? { mcpError: this.mcpError } : {}),
    };
  };

  settings = () => this.install.settings();
  setSettings = (patch: Partial<DesktopSettings>) => this.install.setSettings(patch);
  installRuntime = (onProgress?: (progress: DesktopInstallProgress) => void) => this.install.install(onProgress);

  initialize = async () => {
    await this.install.initialize();
    this.syncExtensionStatus();
    return this.status();
  };

  probeMcp = async () => {
    this.syncExtensionStatus();
    return this.status();
  };

  private syncExtensionStatus(): void {
    const runtime = this.install.status();
    const active = runtime.enabled && runtime.runtimeHealthy;
    this.setMcpStatus({ healthy: active, toolCount: 11 });
  }

  uninstallRuntime = async (deleteRuntime = true) => { await this.disposeSessions(); return this.install.uninstall(deleteRuntime); };
  doctor = () => this.install.refresh();
  permissions = () => this.install.permissions();
  permissionsGuide = () => this.install.permissionsGuide();

  setMcpStatus(input: { healthy: boolean; toolCount?: number; error?: string }): void {
    this.mcpHealthy = input.healthy;
    this.mcpToolCount = input.toolCount ?? 11;
    this.mcpError = input.error;
  }

  assertAppAllowed(target: { app?: string; bundleId?: string; process?: string } | string | undefined): void {
    if (!target) return;
    const blocked = this.settings().blockedApps;
    if (isAppBlocked(target, blocked)) {
      const label = typeof target === 'string'
        ? target
        : (target.app ?? target.bundleId ?? target.process ?? '目标应用');
      throw new Error(`应用「${label}」在受保护黑名单中，已拒绝访问（可在「设置 → 电脑操作 → 桌面应用」调整）。`);
    }
  }

  lookupRefMeta(taskId: string, refId: string): DesktopRefMeta | undefined {
    return this.refIndex.get(taskId)?.get(refId.trim());
  }

  lastCaptureFrame(taskId: string): DesktopCaptureFrame | undefined {
    return this.captureFrames.get(taskId);
  }

  async connectMcp(workerId: string): Promise<McpConnection> {
    return createReconnectingDesktopMcpConnection({
      open: () => this.openMcpSession(workerId),
      onDisconnect: () => {
        this.setMcpStatus({ healthy: false, error: 'agent-desktop MCP 连接已断开，将在下次调用时自动重连' });
      },
      onReconnect: (fresh) => {
        this.setMcpStatus({ healthy: true, toolCount: fresh.tools.length });
      },
    });
  }

  private async openMcpSession(workerId: string): Promise<McpConnection> {
    const binary = this.install.binaryPath();
    if (!binary || !this.install.status().healthy || !this.settings().enabled) throw new Error('桌面运行时未安装、未启用或权限不足');
    const name = desktopSessionName(`${workerId}-${crypto.randomBytes(4).toString('hex')}`);
    const desktopEnv = await this.ensureDesktopEnv();
    const mcpEnv = toStringEnv(desktopEnv);
    const started = await this.raw(['session', 'start', '--name', name, '--no-trace']);
    const sessionId = desktopSessionId(started);
    if (!sessionId) throw new Error(started.text || 'agent-desktop 未能创建 MCP session');
    const config: McpServerConfig = {
      name: `agent_desktop_${desktopSessionName(workerId).replace(/-/g, '_')}`,
      command: binary,
      args: ['--session', sessionId, 'mcp'],
      ...(mcpEnv ? { env: mcpEnv } : {}),
      autoApprove: true,
      description: 'agent-desktop 提供的完整桌面操作命令集',
    };
    try {
      const connection = await connectMcp(config);
      this.setMcpStatus({ healthy: true, toolCount: connection.tools.length });
      return {
        ...connection,
        close: async () => {
          await connection.close().catch(() => undefined);
          await execFilePlatform(binary, ['session', 'end', sessionId], { timeout: 10_000, maxBuffer: 64_000, windowsHide: true, ...(desktopEnv ? { env: desktopEnv } : {}) }).catch(() => undefined);
        },
      };
    } catch (error) {
      this.setMcpStatus({ healthy: false, error: error instanceof Error ? error.message : String(error) });
      await execFilePlatform(binary, ['session', 'end', sessionId], { timeout: 10_000, maxBuffer: 64_000, windowsHide: true, ...(desktopEnv ? { env: desktopEnv } : {}) }).catch(() => undefined);
      throw error;
    }
  }

  async listApps(): Promise<DesktopAppView[]> {
    const result = await this.raw(['list-apps'], undefined, undefined, true);
    if (!result.ok) throw new Error(result.text || '无法读取当前运行应用');
    const data = result.data as Record<string, unknown> | undefined;
    if (!Array.isArray(data?.apps)) return [];

    const enriched = await Promise.all(data.apps.map(async (item) => {
      const value = item as Record<string, unknown>;
      const name = String(value.name ?? value.app ?? value.application_name ?? value.display_name ?? value.process_name ?? '');
      const bundleId = [value.bundle_id, value.bundle_identifier, value.bundleIdentifier]
        .find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))?.trim() ?? '';
      const executablePath = [value.path, value.app_path, value.application_path, value.executable_path]
        .find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
      const pid = value.pid ?? value.process_id;
      const presentation = typeof value.presentation === 'string' ? value.presentation : '';
      const process = typeof value.process === 'string'
        ? value.process
        : typeof value.process_name === 'string'
          ? value.process_name
          : typeof pid === 'number' || typeof pid === 'string'
            ? String(pid)
            : undefined;
      const icon = name ? await applicationIcon(bundleId, name, executablePath, pid) : undefined;
      return {
        name,
        ...(process ? { process } : {}),
        ...(bundleId ? { bundleId } : {}),
        ...(icon ? { icon } : {}),
        presentation,
      };
    }));

    const filtered = enriched.filter((item) => item.name);
    filtered.sort((left, right) => {
      const leftFg = left.presentation === 'foreground' ? 0 : 1;
      const rightFg = right.presentation === 'foreground' ? 0 : 1;
      if (leftFg !== rightFg) return leftFg - rightFg;
      return left.name.localeCompare(right.name, 'zh-CN');
    });

    const apps: DesktopAppView[] = filtered.map(({ presentation: _presentation, ...item }) => item);
    console.warn(`[desktop] app scan: ${apps.length} apps, ${apps.filter((item) => Boolean(item.icon)).length} real icons`);
    return apps;
  }

  async listWindowDetails(appFilter?: string): Promise<DesktopWindowDetail[]> {
    const args = ['list-windows', ...(appFilter ? ['--app', appFilter] : [])];
    const result = await this.raw(args, undefined, undefined, true);
    if (!result.ok) throw new Error(result.text || '无法读取当前桌面窗口');
    const data = result.data;
    if (!Array.isArray(data)) return [];
    return data.map((item) => {
      const value = item as Record<string, unknown>;
      const bounds = parseBounds(value.bounds);
      return {
        id: String(value.id ?? value.window_id ?? ''),
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.app_name === 'string'
          ? { app: value.app_name }
          : typeof value.app === 'string'
            ? { app: value.app }
            : {}),
        ...(typeof value.pid === 'number' ? { process: String(value.pid) } : {}),
        ...(typeof value.visible === 'boolean' ? { visible: value.visible } : {}),
        ...(typeof value.accessible === 'boolean' ? { accessible: value.accessible } : {}),
        ...(typeof value.is_focused === 'boolean' ? { focused: value.is_focused } : {}),
        ...(bounds ? { bounds } : {}),
      };
    }).filter((item) => item.id);
  }

  async listWindows(): Promise<DesktopWindowView[]> {
    const details = await this.listWindowDetails();
    return details.map(({ visible: _v, accessible: _a, focused: _f, bounds: _b, ...view }) => view);
  }

  async listDisplays(): Promise<DesktopDisplayDetail[]> {
    const result = await this.raw(['list-displays'], undefined, undefined, true);
    if (!result.ok) return [];
    const data = result.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((item): DesktopDisplayDetail | null => {
        const value = item as Record<string, unknown>;
        const bounds = parseBounds(value.bounds);
        if (!bounds) return null;
        return {
          id: String(value.id ?? ''),
          isPrimary: value.is_primary === true,
          scale: typeof value.scale === 'number' && value.scale > 0 ? value.scale : 1,
          bounds,
        };
      })
      .filter((entry): entry is DesktopDisplayDetail => entry !== null);
  }

  async execute(
    input: DesktopSessionInput,
    command: string,
    args: readonly string[] = [],
    options: { appId?: string; windowId?: string; stdin?: string; headed?: boolean } = {},
  ): Promise<DesktopResult> {
    const appId = options.appId ?? input.appId;
    const windowId = options.windowId ?? input.windowId;
    this.assertAppAllowed(appId);

    const currentSettings = this.settings();
    if (options.headed && currentSettings.controlMode === 'background') {
      return {
        ok: false,
        text: '当前桌面控制处于「纯后台无打扰模式」，已禁用物理鼠标/坐标点击与拖拽。可在「设置 → 电脑操作 → 桌面应用」切换为「混合全能模式」。',
      };
    }

    return this.withLock(input.taskId, async () => {
      const session = await this.session(input);
      if (appId) session.appId = appId;
      if (windowId) session.windowId = windowId;

      if (currentSettings.cursorOverlay && !this.cursorOverlayApplied.has(session.id)) {
        this.cursorOverlayApplied.add(session.id);
        await this.raw(
          ['cursor-overlay', 'enable', '--accent', '#2563EB', '--label', 'AI 助手操作中'],
          session.id,
          undefined,
          false,
          false,
        ).catch(() => undefined);
      }

      const rawFlags = desktopCommandOptions(command, appId, windowId);
      const commandFlags: string[] = [];
      for (let i = 0; i < rawFlags.length; i += 2) {
        const flag = rawFlags[i]!;
        const val = rawFlags[i + 1]!;
        if (!args.includes(flag)) commandFlags.push(flag, val);
      }

      const headed = Boolean(options.headed && currentSettings.controlMode === 'hybrid');
      const result = await this.raw([command, ...args, ...commandFlags], session.id, options.stdin, false, headed);
      if (command === 'snapshot' && result.ok && result.data !== undefined) {
        this.snapshots.set(input.taskId, {
          data: result.data,
          ...(appId ? { appId } : {}),
          ...(windowId ? { windowId } : {}),
        });
        this.refIndex.set(input.taskId, indexSnapshotRefs(result.data, appId, windowId));
      }
      return result;
    });
  }

  async captureScreenshot(
    input: DesktopSessionInput,
    options: { app?: string; windowId?: string; screen?: number } = {},
  ): Promise<{
    ok: boolean;
    text: string;
    path?: string;
    relPath?: string;
    frame?: DesktopCaptureFrame;
  }> {
    const appId = options.app ?? input.appId;
    const windowId = options.windowId ?? input.windowId;
    this.assertAppAllowed(appId);

    const workspaceRoot = this.taskWorkspaceResolver?.(input.taskId);
    const targetRoot = workspaceRoot
      ? workspaceRoot
      : path.join(this.artifactsDir, 'desktop', desktopSessionName(input.taskId));
    const shotsDir = path.join(targetRoot, 'desktop-shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    const fileName = `shot-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`;
    const targetPath = path.join(shotsDir, fileName);

    const args = [targetPath];
    if (options.screen !== undefined && Number.isInteger(options.screen)) {
      args.push('--screen', String(options.screen));
    }

    const result = await this.execute(input, 'screenshot', args, {
      ...(appId ? { appId } : {}),
      ...(windowId ? { windowId } : {}),
    });
    if (!result.ok || !fs.existsSync(targetPath)) {
      return { ok: false, text: formatDesktopScreenshotError(result.text) };
    }

    let relPath: string | undefined;
    if (workspaceRoot) {
      relPath = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath)).replace(/\\/g, '/');
      try {
        this.artifactRegistrar?.(input.taskId, targetPath);
      } catch {
        // Non-fatal if task row is absent during a standalone preview test
      }
    }

    const frame = await this.resolveCaptureFrame(result.data, {
      ...(appId ? { appId } : {}),
      ...(windowId ? { windowId } : {}),
      ...(options.screen !== undefined ? { screen: options.screen } : {}),
    });
    if (frame) {
      this.captureFrames.set(input.taskId, frame);
    }

    return {
      ok: true,
      text: result.text,
      path: targetPath,
      ...(relPath ? { relPath } : {}),
      ...(frame ? { frame } : {}),
    };
  }

  private async resolveCaptureFrame(
    data: unknown,
    target: { appId?: string; windowId?: string; screen?: number },
  ): Promise<DesktopCaptureFrame | undefined> {
    const meta = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const rawScale = typeof meta.scale_factor === 'number' && meta.scale_factor > 0 ? meta.scale_factor : undefined;
    const rawW = typeof meta.width === 'number' && meta.width > 0 ? meta.width : undefined;
    const rawH = typeof meta.height === 'number' && meta.height > 0 ? meta.height : undefined;

    if (target.windowId || target.appId) {
      const windows = await this.listWindowDetails(target.appId).catch(() => []);
      const matched = target.windowId
        ? windows.find((win) => win.id === target.windowId)
        : windows.find((win) => win.focused && win.visible !== false && win.bounds) ??
          windows.find((win) => win.accessible && win.visible !== false && win.bounds) ??
          windows.find((win) => win.visible !== false && win.bounds) ??
          windows.find((win) => Boolean(win.bounds));
      if (matched?.bounds && matched.bounds.width > 0 && matched.bounds.height > 0) {
        return {
          originX: matched.bounds.x,
          originY: matched.bounds.y,
          width: matched.bounds.width,
          height: matched.bounds.height,
          scaleFactor: rawScale ?? 1,
          ...(matched.app || target.appId ? { app: matched.app ?? target.appId } : {}),
          windowId: matched.id,
          capturedAt: Date.now(),
        };
      }
    }

    const displays = await this.listDisplays().catch(() => []);
    const picked = target.screen !== undefined && displays[target.screen]
      ? displays[target.screen]
      : displays.find((item) => item.isPrimary) ?? displays[0];
    if (picked) {
      return {
        originX: picked.bounds.x,
        originY: picked.bounds.y,
        width: picked.bounds.width,
        height: picked.bounds.height,
        scaleFactor: rawScale ?? picked.scale,
        capturedAt: Date.now(),
      };
    }

    if (rawW && rawH) {
      const scale = rawScale ?? 1;
      return {
        originX: 0,
        originY: 0,
        width: Math.round(rawW / scale),
        height: Math.round(rawH / scale),
        scaleFactor: scale,
        ...(target.appId ? { app: target.appId } : {}),
        ...(target.windowId ? { windowId: target.windowId } : {}),
        capturedAt: Date.now(),
      };
    }
    return undefined;
  }

  async capturePreview(taskId: string, appId?: string): Promise<DesktopPreviewResult> {
    const active = [...this.sessions.values()].find((entry) => entry.taskId === taskId);
    const targetApp = appId?.trim() || active?.appId;
    try {
      const shot = await this.captureScreenshot(
        {
          taskId,
          workerId: active?.workerId ?? 'preview',
          ...(targetApp ? { appId: targetApp } : {}),
          ...(active?.windowId ? { windowId: active.windowId } : {}),
        },
        targetApp ? { app: targetApp } : {},
      );
      if (!shot.ok || !shot.relPath) {
        return { ok: false, error: shot.text || '无法截取当前桌面画面' };
      }
      return {
        ok: true,
        taskId,
        relPath: shot.relPath,
        ...(targetApp ? { appId: targetApp } : {}),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async inspect(input: DesktopSessionInput): Promise<DesktopResult> {
    const session = [...this.sessions.values()].find((entry) => entry.taskId === input.taskId);
    if (!session) return { ok: false, text: '当前任务没有活动的桌面 session' };
    this.assertAppAllowed(session.appId);
    session.lastUsedAt = Date.now();
    const result = await this.raw(['snapshot', '-i', ...desktopCommandOptions('snapshot', session.appId, session.windowId)], session.id);
    if (result.ok && result.data !== undefined) {
      this.snapshots.set(input.taskId, {
        data: result.data,
        ...(session.appId ? { appId: session.appId } : {}),
        ...(session.windowId ? { windowId: session.windowId } : {}),
      });
      this.refIndex.set(input.taskId, indexSnapshotRefs(result.data, session.appId, session.windowId));
    }
    return result;
  }

  async show(taskId: string, appId?: string): Promise<void> {
    this.visibleTask = taskId;
    const session = [...this.sessions.values()].find((entry) => entry.taskId === taskId);
    const targetApp = appId?.trim() || session?.appId;
    if (targetApp) this.assertAppAllowed(targetApp);
    if (!session) return;
    await this.raw(
      ['focus-window', ...desktopCommandOptions('focus-window', targetApp, session.windowId)],
      session.id,
      undefined,
      false,
      false,
    ).catch(() => undefined);
  }

  async hide(taskId?: string): Promise<void> {
    const target = taskId ?? this.visibleTask;
    if (!taskId || taskId === this.visibleTask) this.visibleTask = undefined;
    const session = [...this.sessions.values()].find((entry) => entry.taskId === target);
    if (!session) return;
    session.headed = false;
    await this.raw(['snapshot', '-i'], session.id, undefined, false, false).catch(() => undefined);
  }

  /** End the native session as soon as its durable task reaches a terminal state. */
  async disposeTask(taskId: string): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.taskId !== taskId) continue;
      await this.raw(['session', 'end'], session.id).catch(() => undefined);
      this.sessions.delete(key);
      this.snapshots.delete(taskId);
      this.refIndex.delete(taskId);
      this.captureFrames.delete(taskId);
      this.cursorOverlayApplied.delete(session.id);
      if (this.visibleTask === taskId) this.visibleTask = undefined;
    }
  }

  async disposeSessions(): Promise<void> {
    for (const session of [...this.sessions.values()]) { await this.raw(['session', 'end'], session.id).catch(() => undefined); }
    this.sessions.clear();
    this.snapshots.clear();
    this.refIndex.clear();
    this.captureFrames.clear();
    this.cursorOverlayApplied.clear();
    this.visibleTask = undefined;
  }

  async dispose(): Promise<void> { clearInterval(this.cleanupTimer); await this.disposeSessions(); }

  private async session(input: DesktopSessionInput): Promise<Session> {
    // Keep the readable prefix for diagnostics, but include a digest so task
    // ids such as "a/b" and "a_b" cannot accidentally share a native session.
    const id = desktopSessionName(input.taskId);
    const existing = this.sessions.get(id);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
    const started = await this.raw(['session', 'start', '--name', id, '--no-trace']);
    const sessionId = desktopSessionId(started);
    if (!sessionId) throw new Error(started.text || 'agent-desktop 未能创建桌面 session');
    const session: Session = { ...input, id: sessionId, lastUsedAt: Date.now(), headed: false };
    this.sessions.set(id, session);
    return session;
  }

  private async ensureDesktopEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    if (process.platform !== 'win32') return undefined;
    if (this.desktopEnvPromise) return this.desktopEnvPromise;
    this.desktopEnvPromise = (async () => {
      const homeDir = typeof this.install.privateHomeDir === 'function'
        ? this.install.privateHomeDir()
        : undefined;
      if (!homeDir) return undefined;
      const agentDesktopDir = path.join(homeDir, '.agent-desktop');
      try {
        fs.mkdirSync(agentDesktopDir, { recursive: true });
        const whoami = await execFileAsync('whoami', ['/user', '/fo', 'csv', '/nh'], {
          timeout: 5_000,
          windowsHide: true,
        }).catch(() => ({ stdout: '' }));
        const sid = parseCurrentUserSid(whoami.stdout);
        const principal = sid ? `*${sid}` : process.env.USERNAME?.trim();
        if (principal) {
          for (const target of [homeDir, agentDesktopDir]) {
            await execFileAsync(
              'icacls',
              [
                target,
                '/inheritance:r',
                '/grant:r',
                '*S-1-5-18:(OI)(CI)F',
                '*S-1-5-32-544:(OI)(CI)F',
                `${principal}:(OI)(CI)F`,
              ],
              { timeout: 5_000, windowsHide: true },
            ).catch(() => undefined);
          }
        }
        return { ...process.env, USERPROFILE: homeDir, HOME: homeDir };
      } catch {
        this.desktopEnvPromise = undefined;
        return undefined;
      }
    })();
    return this.desktopEnvPromise;
  }

  private async raw(
    args: readonly string[],
    sessionId?: string,
    stdin?: string,
    allowDisabled = false,
    headedOverride?: boolean,
  ): Promise<DesktopResult> {
    const binary = this.install.binaryPath();
    const session = sessionId ? [...this.sessions.values()].find((entry) => entry.id === sessionId) : undefined;
    const settings = this.install.settings();
    if (!binary || !this.install.status().healthy || (!allowDisabled && !settings.enabled)) return { ok: false, text: '桌面运行时未安装、未启用或权限不足' };
    const desktopEnv = await this.ensureDesktopEnv();
    const useHeaded = headedOverride !== undefined ? headedOverride : Boolean(session?.headed);
    const commandArgs = [
      ...(sessionId ? ['--session', sessionId] : []),
      ...(useHeaded ? ['--headed'] : []),
      ...args,
    ];
    const outputLimit = 2_000_000;
    const child = execFilePlatform(binary, commandArgs, {
      timeout: 90_000,
      maxBuffer: 8_000_000,
      windowsHide: true,
      ...(desktopEnv ? { env: desktopEnv } : {}),
    });
    if (stdin !== undefined) child.child.stdin?.end(stdin);
    const output = await child.catch((error: unknown) => ({ ...extractExecErrorOutput(error), error }));
    const text = `${output.stdout ?? ''}${output.stderr ? `\n${output.stderr}` : ''}`.trim();
    const payload = parseEnvelope(output.stdout ?? '');
    if ('error' in output || !payload?.ok) return { ok: false, text: (payload?.error?.message ?? text) || 'agent-desktop 执行失败', data: payload?.data, details: { code: payload?.error?.code, disposition: payload?.error?.disposition, ...(sessionId ? { sessionId } : {}) } };
    return { ok: true, text: text.slice(0, outputLimit), data: payload.data, details: { ...(sessionId ? { sessionId } : {}), command: args.at(-1) } };
  }

  private async cleanupIdle(): Promise<void> {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [key, session] of this.sessions) if (session.lastUsedAt < cutoff) {
      await this.raw(['session', 'end'], session.id).catch(() => undefined);
      this.sessions.delete(key);
      this.snapshots.delete(session.taskId);
      this.refIndex.delete(session.taskId);
      this.captureFrames.delete(session.taskId);
      this.cursorOverlayApplied.delete(session.id);
      if (this.visibleTask === session.taskId) this.visibleTask = undefined;
    }
  }

  private async withLock(key: string, work: () => Promise<DesktopResult>): Promise<DesktopResult> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await work(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
}
