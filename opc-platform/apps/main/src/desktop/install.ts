import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execFilePlatform } from '../process/execFilePlatform';
import type { CompanyDatabase } from '../data/companyDatabase';
import type {
  DesktopAppAllowlistEntry,
  DesktopApprovalCategory,
  DesktopInstallState,
  DesktopInstallProgress,
  DesktopPermissionStatus,
  DesktopSettings,
  DesktopStatus,
} from '@opc/shared/ipc';

const execFileAsync = promisify(execFile);
export const AGENT_DESKTOP_VERSION = '1.2.0';
const SETTINGS_KEY = 'desktop.settings';
const APPROVAL_POLICY_VERSION = 1;
const APPROVAL_CATEGORIES: readonly DesktopApprovalCategory[] = [
  'desktop-access', 'screenshot', 'desktop-launch', 'window-focus', 'desktop-action',
  'physical-input', 'clipboard-read', 'clipboard-write', 'external-submit', 'destructive',
];
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
  requireApprovalFor: ['external-submit', 'destructive', 'clipboard-read', 'clipboard-write'],
  approvalPolicyVersion: APPROVAL_POLICY_VERSION,
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

function readSetting(db: CompanyDatabase): string | undefined {
  return (db.prepare('SELECT value FROM app_setting WHERE key = ?').get(SETTINGS_KEY) as { value?: string } | undefined)?.value;
}

function migrateLegacySettings(db: CompanyDatabase): string | undefined {
  const isSettings = (value: string | undefined): value is string => {
    if (!value) return false;
    try { const parsed: unknown = JSON.parse(value); return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)); }
    catch { return false; }
  };
  return db.transaction(() => {
    let current = readSetting(db);
    if (!isSettings(current)) {
      const legacy = db.prepare(`SELECT value FROM app_setting WHERE key GLOB ?
        ORDER BY CASE WHEN key = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`)
        .get(`${SETTINGS_KEY}.*`, `${SETTINGS_KEY}.user`) as { value?: string } | undefined;
      if (isSettings(legacy?.value)) {
        db.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(SETTINGS_KEY, legacy.value, Date.now());
        current = readSetting(db);
      }
    }
    db.prepare('DELETE FROM app_setting WHERE key GLOB ?').run(`${SETTINGS_KEY}.*`);
    return current;
  })();
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
  const isLegacyPolicy = raw.approvalPolicyVersion !== APPROVAL_POLICY_VERSION;
  const storedApprovalCategories = Array.isArray(raw.requireApprovalFor)
    ? raw.requireApprovalFor.filter((item): item is DesktopApprovalCategory => typeof item === 'string' && APPROVAL_CATEGORIES.includes(item as DesktopApprovalCategory))
    : [...DEFAULT_SETTINGS.requireApprovalFor];
  const requireApprovalFor: DesktopApprovalCategory[] = [...new Set<DesktopApprovalCategory>(isLegacyPolicy
    ? [...storedApprovalCategories.filter((item) => item !== 'physical-input'), 'clipboard-read']
    : storedApprovalCategories)];
  const max = typeof raw.maxOutputBytes === 'number' && Number.isFinite(raw.maxOutputBytes)
    ? Math.max(8_000, Math.min(256_000, Math.floor(raw.maxOutputBytes)))
    : DEFAULT_SETTINGS.maxOutputBytes;
  return { enabled: raw.enabled === true, allowedApps, requireApprovalFor, approvalPolicyVersion: APPROVAL_POLICY_VERSION, maxOutputBytes: max };
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

async function downloadBytes(
  url: string,
  expectedBytes?: number,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`下载 agent-desktop 失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : expectedBytes;
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      onProgress?.(bytes.length, totalBytes ?? bytes.length);
      return bytes;
    }

    const chunks: Buffer[] = [];
    let downloadedBytes = 0;
    let lastReportedPercent = -1;
    let lastReportedAt = 0;
    onProgress?.(0, totalBytes);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        downloadedBytes += chunk.length;
        const percent = totalBytes ? Math.floor(downloadedBytes / totalBytes * 100) : -1;
        const now = Date.now();
        if (percent !== lastReportedPercent || now - lastReportedAt >= 200) {
          onProgress?.(downloadedBytes, totalBytes);
          lastReportedPercent = percent;
          lastReportedAt = now;
        }
      }
    } finally {
      reader.releaseLock();
    }
    onProgress?.(downloadedBytes, totalBytes ?? downloadedBytes);
    return Buffer.concat(chunks, downloadedBytes);
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

  settings = (): DesktopSettings => {
    const raw = migrateLegacySettings(this.db);
    if (!raw) return { ...DEFAULT_SETTINGS, allowedApps: [...DEFAULT_SETTINGS.allowedApps] };
    try {
      const parsed: unknown = JSON.parse(raw);
      const normalized = normalizeDesktopSettings(parsed);
      const version = parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).approvalPolicyVersion
        : undefined;
      if (version !== APPROVAL_POLICY_VERSION) {
        this.db.prepare(`UPDATE app_setting SET value = ?, updated_at = ? WHERE key = ?`)
          .run(JSON.stringify(normalized), Date.now(), SETTINGS_KEY);
      }
      return normalized;
    } catch { return { ...DEFAULT_SETTINGS, allowedApps: [] }; }
  };

  setSettings = (patch: Partial<DesktopSettings>): DesktopSettings => {
    const next = normalizeDesktopSettings({ ...this.settings(), ...patch });
    this.db.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(next), Date.now());
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

  install = async (onProgress?: (progress: DesktopInstallProgress) => void): Promise<DesktopStatus> => {
    this.state = 'installing'; this.error = undefined;
    let activePhase: DesktopInstallProgress['phase'] = 'download';
    let progressStart = 0;
    let progressEnd = 70;
    let phaseStartedAt = Date.now();
    let phaseDurationMs = 120_000;
    let lastPercent = 0;
    let downloadProgress: Pick<DesktopInstallProgress, 'downloadedBytes' | 'totalBytes'> = {};
    const report = (percent: number) => {
      lastPercent = Math.max(lastPercent, Math.min(100, Math.floor(percent)));
      onProgress?.({ phase: activePhase, percent: lastPercent, ...downloadProgress });
    };
    const startEstimatedPhase = (phase: DesktopInstallProgress['phase'], start: number, end: number, durationMs: number) => {
      activePhase = phase;
      progressStart = start;
      progressEnd = end;
      phaseStartedAt = Date.now();
      phaseDurationMs = durationMs;
      report(start);
    };
    const progressTimer = setInterval(() => {
      if (activePhase === 'download') return;
      const fraction = 1 - Math.exp(-(Date.now() - phaseStartedAt) / phaseDurationMs);
      report(progressStart + (progressEnd - progressStart) * fraction);
    }, 800);
    try {
      const staging = `${this.runtimeDir}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const backup = `${this.runtimeDir}.previous`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      try {
        const asset = releaseAsset();
        this.packageBytes = PACKAGE_BYTES_BY_ASSET[asset] ?? PACKAGE_BYTES;
        const [archive, checksums] = await Promise.all([
          downloadBytes(`${RELEASE_BASE}/${asset}`, this.packageBytes, (downloadedBytes, totalBytes) => {
            downloadProgress = { downloadedBytes, ...(totalBytes ? { totalBytes } : {}) };
            report(totalBytes ? Math.min(70, downloadedBytes / totalBytes * 70) : 0);
          }),
          downloadBytes(`${RELEASE_BASE}/checksums.txt`),
        ]);
        startEstimatedPhase('verify', 70, 76, 12_000);
        const expected = desktopChecksumFor(checksums.toString('utf8'), asset);
        if (!expected) throw new Error(`checksums.txt 中没有 agent-desktop 资产：${asset}`);
        const actual = crypto.createHash('sha256').update(archive).digest('hex');
        if (actual !== expected) throw new Error('agent-desktop 下载校验失败，未安装不可信运行时');
        const archivePath = path.join(staging, asset);
        fs.writeFileSync(archivePath, archive, { mode: 0o600 });
        startEstimatedPhase('extract', 76, 88, 45_000);
        await execFileAsync('tar', ['-xzf', archivePath, '-C', staging], { timeout: 60_000, maxBuffer: 2_000_000 });
        fs.rmSync(archivePath, { force: true });
        const staged = this.findBinary(staging);
        if (!staged) throw new Error('agent-desktop 安装完成但未找到可执行文件');
        if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);
        startEstimatedPhase('activate', 88, 96, 12_000);
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
      this.state = 'installing';
      this.diskCache.at = 0;
      startEstimatedPhase('permissions', 96, 99, 10_000);
      await this.probePermissions();
      this.state = this.permissionsState.accessibility === 'denied' ? 'permission-required' : 'ready';
      activePhase = 'permissions';
      report(100);
    } catch (caught) {
      this.state = 'error'; this.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      clearInterval(progressTimer);
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
    await execFilePlatform(this.binary, ['permissions', '--guide'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch(() => undefined);
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
    const result = await execFilePlatform(this.binary, ['permissions'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch((error: unknown) => ({ stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    const payload = parseJson(result.stdout ?? '');
    const data = payload?.data as Record<string, unknown> | undefined;
    const state = (key: string): DesktopPermissionStatus['accessibility'] => {
      const value = (data?.[key] as Record<string, unknown> | undefined)?.state;
      return value === 'granted' || value === 'denied' || value === 'not_required' || value === 'unknown' ? value : 'unknown';
    };
    this.permissionsState = { accessibility: state('accessibility'), screenRecording: state('screen_recording'), automation: state('automation') };
    const statusResult = await execFilePlatform(this.binary, ['status'], { timeout: 20_000, maxBuffer: 1_000_000 }).catch(() => ({ stdout: '' }));
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
