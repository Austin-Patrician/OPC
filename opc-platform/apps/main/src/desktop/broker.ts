import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app as electronApp, nativeImage } from 'electron';
import type { DesktopAppView, DesktopInstallProgress, DesktopSettings, DesktopWindowView } from '@opc/shared/ipc';
import type { DesktopInstallService } from './install';
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


function parseEnvelope(text: string): { ok: boolean; data?: unknown; error?: { code?: string; message?: string; disposition?: unknown } } | undefined {
  try { return JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code?: string; message?: string; disposition?: unknown } }; } catch { return undefined; }
}

export function desktopCommandOptions(command: string, appId?: string, windowId?: string): string[] {
  // agent-desktop treats these as subcommand options. Ref actions already carry
  // their snapshot scope and reject unrelated --app/--window-id flags.
  if (command === 'snapshot' || command === 'find' || command === 'screenshot') {
    return [...(appId ? ['--app', appId] : []), ...(windowId ? ['--window-id', windowId] : [])];
  }
  if (command === 'focus-window') {
    return [...(appId ? ['--app', appId] : []), ...(windowId ? ['--window-id', windowId] : [])];
  }
  return [];
}

export class DesktopBroker {
  private readonly sessions = new Map<string, Session>();
  /** The exact tree that minted refs. Never validate a ref against a newer tree. */
  private readonly snapshots = new Map<string, { data: unknown; appId?: string; windowId?: string }>();
  private readonly locks = new Map<string, Promise<void>>();
  private visibleTask?: string;
  private mcpHealthy = false;
  private mcpToolCount = 0;
  private mcpError?: string;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly install: DesktopInstallService) {
    this.cleanupTimer = setInterval(() => { void this.cleanupIdle(); }, 10 * 60_000);
    this.cleanupTimer.unref?.();
  }

  status = () => {
    const runtime = this.install.status();
    const mcpHealthy = runtime.enabled ? this.mcpHealthy : false;
    return {
      ...runtime,
      runtimeHealthy: runtime.healthy,
      healthy: runtime.healthy && (!runtime.enabled || mcpHealthy),
      mcpHealthy,
      mcpToolCount: this.mcpToolCount,
      ...(this.mcpError ? { mcpError: this.mcpError } : {}),
    };
  };
  settings = () => this.install.settings();
  setSettings = (patch: Partial<DesktopSettings>) => this.install.setSettings(patch);
  installRuntime = (onProgress?: (progress: DesktopInstallProgress) => void) => this.install.install(onProgress);
  initialize = async () => {
    await this.install.initialize();
    return this.probeMcp();
  };
  probeMcp = async () => {
    if (!this.install.settings().enabled) {
      this.setMcpStatus({ healthy: false });
      return this.status();
    }
    if (!this.install.status().healthy) {
      this.setMcpStatus({ healthy: false, error: this.install.status().error });
      return this.status();
    }
    try {
      const probe = await this.connectMcp('healthcheck');
      const toolCount = probe.tools.length;
      await probe.close();
      this.setMcpStatus({ healthy: toolCount > 0, toolCount, ...(toolCount > 0 ? {} : { error: 'agent-desktop MCP 未发现工具' }) });
    } catch (error) {
      this.setMcpStatus({ healthy: false, error: error instanceof Error ? error.message : String(error) });
    }
    return this.status();
  };
  uninstallRuntime = async (deleteRuntime = true) => { await this.disposeSessions(); return this.install.uninstall(deleteRuntime); };
  doctor = () => this.install.refresh();
  permissions = () => this.install.permissions();
  permissionsGuide = () => this.install.permissionsGuide();

  setMcpStatus(input: { healthy: boolean; toolCount?: number; error?: string }): void {
    this.mcpHealthy = input.healthy;
    this.mcpToolCount = input.toolCount ?? 0;
    this.mcpError = input.error;
  }

  async connectMcp(workerId: string): Promise<McpConnection> {
    const binary = this.install.binaryPath();
    if (!binary || !this.install.status().healthy || !this.settings().enabled) throw new Error('桌面运行时未安装、未启用或权限不足');
    const name = desktopSessionName(workerId);
    const started = await this.raw(['session', 'start', '--name', name, '--no-trace']);
    const sessionId = desktopSessionId(started);
    if (!sessionId) throw new Error(started.text || 'agent-desktop 未能创建 MCP session');
    const config: McpServerConfig = { name: `agent_desktop_${name.replace(/-/g, '_')}`, command: binary, args: ['--session', sessionId, 'mcp'], autoApprove: true, description: 'agent-desktop 提供的完整桌面操作命令集' };
    try {
      const connection = await connectMcp(config);
      this.setMcpStatus({ healthy: true, toolCount: connection.tools.length });
      return {
        ...connection,
        close: async () => {
          await connection.close();
          await execFilePlatform(binary, ['session', 'end', sessionId], { timeout: 10_000, maxBuffer: 64_000, windowsHide: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      this.setMcpStatus({ healthy: false, error: error instanceof Error ? error.message : String(error) });
      await execFilePlatform(binary, ['session', 'end', sessionId], { timeout: 10_000, maxBuffer: 64_000, windowsHide: true }).catch(() => undefined);
      throw error;
    }
  }

  async listApps(): Promise<DesktopAppView[]> {
    const result = await this.raw(['list-apps'], undefined, undefined, true);
    if (!result.ok) throw new Error(result.text || '无法读取当前运行应用');
    const data = result.data as Record<string, unknown> | undefined;
    const apps = Array.isArray(data?.apps) ? (await Promise.all(data.apps.map(async (item) => {
      const value = item as Record<string, unknown>;
      const name = String(value.name ?? value.app ?? value.application_name ?? value.display_name ?? value.process_name ?? '');
      const bundleId = [value.bundle_id, value.bundle_identifier, value.bundleIdentifier]
        .find((item): item is string => typeof item === 'string' && Boolean(item.trim()))?.trim() ?? '';
      const executablePath = [value.path, value.app_path, value.application_path, value.executable_path]
        .find((item): item is string => typeof item === 'string' && Boolean(item.trim()));
      const pid = value.pid ?? value.process_id;
      return { name, ...(typeof value.process === 'string' ? { process: value.process } : typeof value.process_name === 'string' ? { process: value.process_name } : typeof pid === 'number' || typeof pid === 'string' ? { process: String(pid) } : {}), ...(bundleId ? { bundleId } : {}), ...(name ? { icon: await applicationIcon(bundleId, name, executablePath, pid) } : {}) };
    }))).filter((item) => item.name).map(({ icon, ...item }) => ({ ...item, ...(icon ? { icon } : {}) })) : [];
    console.warn(`[desktop] app scan: ${apps.length} apps, ${apps.filter((item) => Boolean(item.icon)).length} real icons, ${apps.filter((item) => !item.icon).length} initial fallbacks`);
    return apps;
  }

  async listWindows(): Promise<DesktopWindowView[]> {
    const result = await this.raw(['list-windows'], undefined, undefined, true);
    if (!result.ok) throw new Error(result.text || '无法读取当前桌面窗口');
    const data = result.data;
    return Array.isArray(data) ? data.map((item) => {
      const value = item as Record<string, unknown>;
      return { id: String(value.id ?? value.window_id ?? ''), ...(typeof value.title === 'string' ? { title: value.title } : {}), ...(typeof value.app_name === 'string' ? { app: value.app_name } : {}), ...(typeof value.pid === 'number' ? { process: String(value.pid) } : {}) };
    }).filter((item) => item.id) : [];
  }

  async execute(input: DesktopSessionInput, command: string, args: readonly string[] = [], options: { appId?: string; windowId?: string; stdin?: string } = {}): Promise<DesktopResult> {
    const appId = options.appId ?? input.appId;
    return this.withLock(input.taskId, async () => {
      const session = await this.session(input);
      const commandFlags = desktopCommandOptions(command, appId, options.windowId ?? input.windowId);
      const result = await this.raw([command, ...args, ...commandFlags], session.id, options.stdin);
      if (command === 'snapshot' && result.ok && result.data !== undefined) this.snapshots.set(input.taskId, {
        data: result.data,
        ...(appId ? { appId } : {}),
        ...((options.windowId ?? input.windowId) ? { windowId: options.windowId ?? input.windowId } : {}),
      });
      return result;
    });
  }

  async inspect(input: DesktopSessionInput): Promise<DesktopResult> {
    const session = [...this.sessions.values()].find((entry) => entry.taskId === input.taskId);
    if (!session) return { ok: false, text: '当前任务没有活动的桌面 session' };
    session.lastUsedAt = Date.now();
    const result = await this.raw(['snapshot', '-i', ...desktopCommandOptions('snapshot', session.appId, session.windowId)], session.id);
    if (result.ok && result.data !== undefined) this.snapshots.set(input.taskId, {
      data: result.data,
      ...(session.appId ? { appId: session.appId } : {}),
      ...(session.windowId ? { windowId: session.windowId } : {}),
    });
    return result;
  }

  async show(taskId: string): Promise<void> {
    this.visibleTask = taskId;
    const session = [...this.sessions.values()].find((entry) => entry.taskId === taskId);
    if (!session) return;
    session.headed = true;
    await this.raw(['focus-window', ...desktopCommandOptions('focus-window', session.appId, session.windowId)], session.id).catch(() => undefined);
  }

  async hide(taskId?: string): Promise<void> {
    const target = taskId ?? this.visibleTask;
    if (!taskId || taskId === this.visibleTask) this.visibleTask = undefined;
    const session = [...this.sessions.values()].find((entry) => entry.taskId === target);
    if (!session) return;
    session.headed = false;
    await this.raw(['snapshot', '-i'], session.id).catch(() => undefined);
  }

  /** End the native session as soon as its durable task reaches a terminal state. */
  async disposeTask(taskId: string): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.taskId !== taskId) continue;
      await this.raw(['session', 'end'], session.id).catch(() => undefined);
      this.sessions.delete(key);
      this.snapshots.delete(taskId);
      if (this.visibleTask === taskId) this.visibleTask = undefined;
    }
  }

  async disposeSessions(): Promise<void> {
    for (const session of [...this.sessions.values()]) { await this.raw(['session', 'end'], session.id).catch(() => undefined); }
    this.sessions.clear(); this.snapshots.clear(); this.visibleTask = undefined;
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

  private async raw(args: readonly string[], sessionId?: string, stdin?: string, allowDisabled = false): Promise<DesktopResult> {
    const binary = this.install.binaryPath();
    const session = sessionId ? [...this.sessions.values()].find((entry) => entry.id === sessionId) : undefined;
    const settings = this.install.settings();
    if (!binary || !this.install.status().healthy || (!allowDisabled && !settings.enabled)) return { ok: false, text: '桌面运行时未安装、未启用或权限不足' };
    const commandArgs = [
      ...(sessionId ? ['--session', sessionId] : []),
      ...(session?.headed ? ['--headed'] : []),
      ...args,
    ];
    const outputLimit = 2_000_000;
    const child = execFilePlatform(binary, commandArgs, { timeout: 90_000, maxBuffer: 8_000_000, windowsHide: true });
    if (stdin !== undefined) child.child.stdin?.end(stdin);
    const output = await child.catch((error: unknown) => ({ stdout: '', stderr: error instanceof Error ? error.message : String(error), error }));
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
