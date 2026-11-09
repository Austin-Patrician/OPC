import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CompanyDatabase } from '../data/companyDatabase';
import type {
  DesktopAppAllowlistEntry,
  DesktopInstallState,
  DesktopPermissionStatus,
  DesktopSettings,
  DesktopStatus,
} from '@opc/shared/ipc';

const execFileAsync = promisify(execFile);
export const AGENT_DESKTOP_VERSION = '1.2.0';
const SETTINGS_KEY = 'desktop.settings';
/** Compressed download sizes for the pinned v1.2.0 release assets. */
const PACKAGE_BYTES = 31 * 1024 * 1024;
const PACKAGE_BYTES_BY_ASSET: Record<string, number> = {
  'agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz': 2_230_641,
  'agent-desktop-v1.2.0-aarch64-pc-windows-msvc.tar.gz': 1_706_239,
  'agent-desktop-v1.2.0-aarch64-unknown-linux-gnu.tar.gz': 3_333_305,
  'agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz': 2_359_765,
  'agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz': 1_759_368,
  'agent-desktop-v1.2.0-x86_64-unknown-linux-gnu.tar.gz': 3_458_001,
};
const RELEASE_BASE = `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}`;
const DEFAULT_SETTINGS: DesktopSettings = {
  enabled: false,
  allowedApps: [],
  requireApprovalFor: ['external-submit', 'destructive', 'clipboard-write', 'physical-input'],
  maxOutputBytes: 64_000,
};

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) total += fs.statSync(target).size;
      } catch { /* concurrent cleanup */ }
    }
  }
  return total;
}

function readSetting(db: CompanyDatabase, userId: string): string | undefined {
  return (db.prepare('SELECT value FROM app_setting WHERE key = ?').get(`${SETTINGS_KEY}.${userId}`) as { value?: string } | undefined)?.value;
}

function normalizeEntry(input: unknown): DesktopAppAllowlistEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return undefined;
  return {
    id: raw.id.trim().slice(0, 240),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 120) : raw.id.trim(),
    platform: typeof raw.platform === 'string' ? raw.platform : process.platform,
    enabled: raw.enabled !== false,
    source: raw.source === 'system' ? 'system' : 'user',
  };
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS, allowedApps: [] };
  const raw = value as Record<string, unknown>;
  const allowedApps = Array.isArray(raw.allowedApps)
    ? [...new Map(raw.allowedApps.map(normalizeEntry).filter((entry): entry is DesktopAppAllowlistEntry => Boolean(entry)).map((entry) => [entry.id, entry])).values()]
    : [];
  const requireApprovalFor = Array.isArray(raw.requireApprovalFor)
    ? [...new Set(raw.requireApprovalFor.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))]
    : [...DEFAULT_SETTINGS.requireApprovalFor];
  const max = typeof raw.maxOutputBytes === 'number' && Number.isFinite(raw.maxOutputBytes)
    ? Math.max(8_000, Math.min(256_000, Math.floor(raw.maxOutputBytes)))
    : DEFAULT_SETTINGS.maxOutputBytes;
  return { enabled: raw.enabled === true, allowedApps, requireApprovalFor, maxOutputBytes: max };
}

const UNKNOWN_PERMISSIONS: DesktopPermissionStatus = {
  accessibility: 'unknown', screenRecording: 'unknown', automation: 'unknown',
};

function parseJson(stdout: string): Record<string, unknown> | undefined {
  try { return JSON.parse(stdout) as Record<string, unknown>; } catch { return undefined; }
}

export function desktopReleaseAsset(platform: string, architecture: string): string {
  const arch = architecture === 'arm64' ? 'aarch64' : architecture === 'x64' ? 'x86_64' : undefined;
  if (!arch) throw new Error(`agent-desktop 不支持当前 CPU 架构：${architecture}`);
  const target = platform === 'darwin' ? `${arch}-apple-darwin`
    : platform === 'win32' ? `${arch}-pc-windows-msvc`
      : platform === 'linux' ? `${arch}-unknown-linux-gnu` : undefined;
  if (!target) throw new Error(`agent-desktop 不支持当前操作系统：${platform}`);
  return `agent-desktop-v${AGENT_DESKTOP_VERSION}-${target}.tar.gz`;
}

function releaseAsset(): string { return desktopReleaseAsset(process.platform, process.arch); }

function packageBytesForCurrentPlatform(): number {
  try { return PACKAGE_BYTES_BY_ASSET[releaseAsset()] ?? PACKAGE_BYTES; } catch { return PACKAGE_BYTES; }
}

async function downloadBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`下载 agent-desktop 失败：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timeout); }
}

export function desktopChecksumFor(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+[* ]?(.+)$/);
    if (match && path.basename(match[2]!.trim()) === asset) return match[1]!.toLowerCase();
  }
  return undefined;
}

export class DesktopInstallService {
  private state: DesktopInstallState = 'uninstalled';
  private error?: string;
  private binary?: string;
  private permissionsState: DesktopPermissionStatus = { ...UNKNOWN_PERMISSIONS };
  private supportedSurfaces: string[] = [];
  private packageBytes?: number;
  private diskCache: { at: number; bytes: number } = { at: 0, bytes: 0 };
  private readonly runtimeDir: string;

  constructor(private readonly db: CompanyDatabase, userDataDir: string) {
    this.runtimeDir = path.join(userDataDir, 'desktop', 'runtime', AGENT_DESKTOP_VERSION);
    this.refresh();
  }

  settings = (userId = 'user'): DesktopSettings => {
    // The settings page writes the current user's default policy. A worker may
    // override it with its own key, but an absent worker key must inherit the
    // user policy or the capability would silently appear disabled to workers.
    const raw = readSetting(this.db, userId) ?? (userId === 'user' ? undefined : readSetting(this.db, 'user'));
    if (!raw) return { ...DEFAULT_SETTINGS, allowedApps: [...DEFAULT_SETTINGS.allowedApps] };
    try { return normalizeDesktopSettings(JSON.parse(raw)); } catch { return { ...DEFAULT_SETTINGS, allowedApps: [] }; }
  };

  setSettings = (patch: Partial<DesktopSettings>, userId = 'user'): DesktopSettings => {
    const next = normalizeDesktopSettings({ ...this.settings(userId), ...patch });
    this.db.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(`${SETTINGS_KEY}.${userId}`, JSON.stringify(next), Date.now());
    this.refresh();
    return next;
  };

  status = (): DesktopStatus => ({
    installState: this.state,
    enabled: this.settings().enabled,
    ...(this.binary ? { version: AGENT_DESKTOP_VERSION, binary: this.binary } : {}),
    healthy: Boolean(this.binary) && (this.state === 'ready' || this.state === 'disabled'),
    packageBytes: this.packageBytes ?? packageBytesForCurrentPlatform(),
    ...(this.state !== 'uninstalled' ? { diskUsageBytes: this.diskUsage() } : {}),
    permissions: this.permissionsState,
    supportedSurfaces: this.supportedSurfaces,
    ...(this.error ? { error: this.error } : {}),
  });

  binaryPath = (): string | undefined => this.binary;

  initialize = async (): Promise<DesktopStatus> => {
    if (this.binary) {
      await this.probePermissions();
      this.syncPermissionState();
    }
    return this.status();
  };

  refresh = (): DesktopStatus => {
    this.binary = this.findBinary();
    this.packageBytes = this.binary ? packageBytesForCurrentPlatform() : undefined;
    this.state = !this.binary ? 'uninstalled'
      : this.permissionsState.accessibility === 'denied' ? 'permission-required'
        : this.settings().enabled ? 'ready' : 'disabled';
    this.error = undefined;
    return this.status();
  };

  install = async (): Promise<DesktopStatus> => {
    this.state = 'installing'; this.error = undefined;
    try {
      const staging = `${this.runtimeDir}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const backup = `${this.runtimeDir}.previous`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      try {
        const asset = releaseAsset();
        this.packageBytes = PACKAGE_BYTES_BY_ASSET[asset] ?? PACKAGE_BYTES;
        const [archive, checksums] = await Promise.all([
          downloadBytes(`${RELEASE_BASE}/${asset}`),
          downloadBytes(`${RELEASE_BASE}/checksums.txt`),
        ]);
        const expected = desktopChecksumFor(checksums.toString('utf8'), asset);
        if (!expected) throw new Error(`checksums.txt 中没有 agent-desktop 资产：${asset}`);
        const actual = crypto.createHash('sha256').update(archive).digest('hex');
        if (actual !== expected) throw new Error('agent-desktop 下载校验失败，未安装不可信运行时');
        const archivePath = path.join(staging, asset);
        fs.writeFileSync(archivePath, archive, { mode: 0o600 });
        await execFileAsync('tar', ['-xzf', archivePath, '-C', staging], { timeout: 60_000, maxBuffer: 2_000_000 });
        fs.rmSync(archivePath, { force: true });
        const staged = this.findBinary(staging);
        if (!staged) throw new Error('agent-desktop 安装完成但未找到可执行文件');
        if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);
        fs.rmSync(backup, { recursive: true, force: true });
        if (fs.existsSync(this.runtimeDir)) fs.renameSync(this.runtimeDir, backup);
        try { fs.renameSync(staging, this.runtimeDir); }
        catch (error) { if (fs.existsSync(backup) && !fs.existsSync(this.runtimeDir)) fs.renameSync(backup, this.runtimeDir); throw error; }
        fs.rmSync(backup, { recursive: true, force: true });
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      this.binary = this.findBinary();
      if (!this.binary) throw new Error('agent-desktop 安装完成但未找到可执行文件');
      this.packageBytes = packageBytesForCurrentPlatform();
      this.setSettings({ enabled: true });
      this.diskCache.at = 0;
      await this.probePermissions();
      this.state = this.permissionsState.accessibility === 'denied' ? 'permission-required' : 'ready';
    } catch (caught) {
      this.state = 'error'; this.error = caught instanceof Error ? caught.message : String(caught);
    }
    return this.status();
  };

  uninstall = (deleteRuntime = true): DesktopStatus => {
    this.setSettings({ enabled: false });
    if (deleteRuntime) fs.rmSync(this.runtimeDir, { recursive: true, force: true });
    this.diskCache.at = 0;
    return this.refresh();
  };

  permissions = async (): Promise<DesktopStatus> => { await this.probePermissions(); this.syncPermissionState(); return this.status(); };

  permissionsGuide = async (): Promise<DesktopStatus> => {
    if (!this.binary) return this.status();
    await execFileAsync(this.binary, ['permissions', '--guide'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch(() => undefined);
    await this.probePermissions();
    this.syncPermissionState();
    return this.status();
  };

  private syncPermissionState(): void {
    if (!this.binary) {
      this.state = 'uninstalled';
      return;
    }
    if (this.permissionsState.accessibility === 'denied') {
      this.state = 'permission-required';
      return;
    }
    this.state = this.settings().enabled ? 'ready' : 'disabled';
  }

  private async probePermissions(): Promise<void> {
    if (!this.binary) return;
    const result = await execFileAsync(this.binary, ['permissions'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch((error: unknown) => ({ stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    const payload = parseJson(result.stdout ?? '');
    const data = payload?.data as Record<string, unknown> | undefined;
    const state = (key: string): DesktopPermissionStatus['accessibility'] => {
      const value = (data?.[key] as Record<string, unknown> | undefined)?.state;
      return value === 'granted' || value === 'denied' || value === 'not_required' || value === 'unknown' ? value : 'unknown';
    };
    this.permissionsState = { accessibility: state('accessibility'), screenRecording: state('screen_recording'), automation: state('automation') };
    const statusResult = await execFileAsync(this.binary, ['status'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch(() => ({ stdout: '' }));
    const statusPayload = parseJson(statusResult.stdout ?? '');
    const statusData = statusPayload?.data as Record<string, unknown> | undefined;
    this.supportedSurfaces = Array.isArray(statusData?.supported_surfaces) ? statusData.supported_surfaces.filter((item): item is string => typeof item === 'string') : [];
  }

  private diskUsage(): number {
    if (Date.now() - this.diskCache.at < 30_000) return this.diskCache.bytes;
    const bytes = directoryBytes(this.runtimeDir);
    this.diskCache = { at: Date.now(), bytes };
    return bytes;
  }

  private findBinary(root = this.runtimeDir): string | undefined {
    const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-desktop.cmd' : 'agent-desktop');
    if (fs.existsSync(local)) return local;
    const direct = path.join(root, process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop');
    if (fs.existsSync(direct)) return direct;
    if (root !== this.runtimeDir) {
      const wanted = process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop';
      const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
      while (pending.length) {
        const current = pending.pop()!;
        if (current.depth > 3) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          const target = path.join(current.dir, entry.name);
          if (entry.isFile() && entry.name === wanted) return target;
          if (entry.isDirectory() && entry.name !== 'node_modules') pending.push({ dir: target, depth: current.depth + 1 });
        }
      }
      return undefined;
    }
    return undefined;
  }
}

export { PACKAGE_BYTES };
