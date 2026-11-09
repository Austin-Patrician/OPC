import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserInstallProgress, BrowserInstallPhase } from '@opc/shared/ipc';
import type { CompanyDatabase } from '../data/companyDatabase';

const execFileAsync = promisify(execFile);
export const AGENT_BROWSER_VERSION = '0.41.2';
const SETTINGS_KEY = 'browser.settings';

export type BrowserInstallState = 'uninstalled' | 'installing' | 'ready' | 'disabled' | 'error';

export interface BrowserSettings {
  enabled: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  allowAllDomains: boolean;
  requireApprovalFor: string[];
  maxOutputBytes: number;
}

export interface BrowserStatus {
  installState: BrowserInstallState;
  enabled: boolean;
  version?: string;
  binary?: string;
  healthy: boolean;
  downloadEstimateBytes: number;
  diskUsageBytes?: number;
  error?: string;
  profilePath: string;
}

const DOWNLOAD_ESTIMATE_BYTES = 180 * 1024 * 1024;

function npmCommand(): { executable: string; prefixArgs: string[] } {
  if (process.platform !== 'win32') return { executable: 'npm', prefixArgs: [] };

  const directories = new Set((process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean));
  const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files';
  directories.add(path.join(programFiles, 'nodejs'));
  if (process.env['ProgramFiles(x86)']) directories.add(path.join(process.env['ProgramFiles(x86)']!, 'nodejs'));
  if (process.env.NVM_SYMLINK) directories.add(process.env.NVM_SYMLINK);
  if (process.env.NODE_HOME) directories.add(process.env.NODE_HOME);
  if (process.env.LOCALAPPDATA) directories.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'));

  for (const directory of directories) {
    const executable = path.join(directory, 'node.exe');
    const cli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(executable) && fs.existsSync(cli)) return { executable, prefixArgs: [cli] };
  }
  throw new Error('未找到 Node.js 和 npm。请安装包含 npm 的 Node.js，并重启 OPC 后重试。');
}

function installBrowserRuntime(binary: string) {
  const args = ['install'];
  const options = { timeout: 300_000, maxBuffer: 2_000_000 };
  if (process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd')) {
    const commandShell = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    return execFileAsync(commandShell, ['/d', '/c', binary, ...args], options);
  }
  return execFileAsync(binary, args, options);
}

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
      } catch { /* A concurrently changing cache entry is omitted. */ }
    }
  }
  return total;
}

const DEFAULT_SETTINGS: BrowserSettings = {
  enabled: false,
  allowedDomains: [],
  blockedDomains: [],
  allowAllDomains: false,
  requireApprovalFor: ['external-submit', 'download', 'upload', 'authentication', 'destructive'],
  maxOutputBytes: 32_000,
};

function readSetting(db: CompanyDatabase): string | undefined {
  return (db.prepare('SELECT value FROM app_setting WHERE key = ?').get(SETTINGS_KEY) as { value?: string } | undefined)?.value;
}

function normalize(value: unknown): BrowserSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const raw = value as Record<string, unknown>;
  const strings = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))] : [];
  const max = typeof raw.maxOutputBytes === 'number' && Number.isFinite(raw.maxOutputBytes)
    ? Math.max(4_000, Math.min(256_000, Math.floor(raw.maxOutputBytes)))
    : DEFAULT_SETTINGS.maxOutputBytes;
  return {
    enabled: raw.enabled === true,
    allowedDomains: strings(raw.allowedDomains),
    blockedDomains: strings(raw.blockedDomains),
    allowAllDomains: raw.allowAllDomains === true,
    requireApprovalFor: strings(raw.requireApprovalFor).length ? strings(raw.requireApprovalFor) : [...DEFAULT_SETTINGS.requireApprovalFor],
    maxOutputBytes: max,
  };
}

export class BrowserInstallService {
  private state: BrowserInstallState = 'uninstalled';
  private error?: string;
  private binary?: string;
  private readonly runtimeDir: string;
  private diskUsageCache: { checkedAt: number; bytes: number } = { checkedAt: 0, bytes: 0 };

  constructor(private readonly db: CompanyDatabase, private readonly userDataDir: string) {
    this.runtimeDir = path.join(userDataDir, 'browser', 'runtime', AGENT_BROWSER_VERSION);
    this.refresh();
  }

  settings = (): BrowserSettings => {
    const raw = readSetting(this.db);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try { return normalize(JSON.parse(raw)); } catch { return { ...DEFAULT_SETTINGS }; }
  };

  setSettings = (patch: Partial<BrowserSettings>): BrowserSettings => {
    const next = normalize({ ...this.settings(), ...patch });
    this.db.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(next), Date.now());
    this.refresh();
    return next;
  };

  profilePath = (userId: string): string => {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
    const profile = path.join(this.userDataDir, 'browser', 'profiles', safe);
    fs.mkdirSync(profile, { recursive: true });
    return profile;
  };

  binaryPath = (): string | undefined => this.binary;

  status = (): BrowserStatus => ({
    installState: this.state,
    enabled: this.settings().enabled,
    ...(this.binary ? { binary: this.binary, version: AGENT_BROWSER_VERSION } : {}),
    healthy: Boolean(this.binary) && (this.state === 'ready' || this.state === 'disabled'),
    downloadEstimateBytes: DOWNLOAD_ESTIMATE_BYTES,
    ...(this.state === 'ready' || this.state === 'disabled' ? { diskUsageBytes: this.diskUsageBytes() } : {}),
    ...(this.error ? { error: this.error } : {}),
    profilePath: path.join(this.userDataDir, 'browser', 'profiles'),
  });

  private diskUsageBytes(): number {
    const now = Date.now();
    if (now - this.diskUsageCache.checkedAt < 30_000) return this.diskUsageCache.bytes;
    const bytes = directoryBytes(this.runtimeDir) + directoryBytes(this.browserCachePath());
    this.diskUsageCache = { checkedAt: now, bytes };
    return bytes;
  }

  private browserCachePath(): string {
    const home = os.homedir();
    return process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright')
        : path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
  }

  refresh = (): BrowserStatus => {
    const candidate = this.findBinary();
    this.binary = candidate;
    this.state = candidate ? (this.settings().enabled ? 'ready' : 'disabled') : 'uninstalled';
    this.error = undefined;
    return this.status();
  };

  install = async (onProgress?: (progress: BrowserInstallProgress) => void): Promise<BrowserStatus> => {
    this.state = 'installing';
    this.error = undefined;
    let phase: BrowserInstallPhase = 'dependencies';
    let phaseStartedAt = Date.now();
    let phaseStartPercent = 2;
    let phaseEndPercent = 32;
    let phaseDurationMs = 45_000;
    let browserPhaseStarted = false;
    // The installer commands expose completion, not byte-level progress; keep this estimate below each phase ceiling until it resolves.
    const reportProgress = () => {
      const elapsed = Date.now() - phaseStartedAt;
      const fraction = 1 - Math.exp(-elapsed / phaseDurationMs);
      const percent = Math.min(phaseEndPercent, Math.floor(phaseStartPercent + (phaseEndPercent - phaseStartPercent) * fraction));
      onProgress?.({ phase, percent, estimated: true });
    };
    const startPhase = (next: BrowserInstallPhase, start: number, end: number, durationMs: number) => {
      phase = next;
      phaseStartedAt = Date.now();
      phaseStartPercent = start;
      phaseEndPercent = end;
      phaseDurationMs = durationMs;
      if (next === 'browser') browserPhaseStarted = true;
      reportProgress();
    };
    reportProgress();
    const progressTimer = setInterval(reportProgress, 800);
    try {
      const existing = this.findBinary();
      if (!existing) {
        const stagingDir = `${this.runtimeDir}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const backupDir = `${this.runtimeDir}.previous`;
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(stagingDir, { recursive: true });
        try {
          const npm = npmCommand();
          await execFileAsync(npm.executable, [...npm.prefixArgs, 'install', '--prefix', stagingDir, '--no-save', `agent-browser@${AGENT_BROWSER_VERSION}`], { timeout: 180_000, maxBuffer: 2_000_000 });
          const stagedBinary = this.findBinary(stagingDir);
          if (!stagedBinary) throw new Error('agent-browser 安装完成但未找到可执行文件');
          startPhase('browser', 35, 90, 180_000);
          await installBrowserRuntime(stagedBinary);
          fs.rmSync(backupDir, { recursive: true, force: true });
          if (fs.existsSync(this.runtimeDir)) fs.renameSync(this.runtimeDir, backupDir);
          try {
            fs.renameSync(stagingDir, this.runtimeDir);
          } catch (error) {
            if (fs.existsSync(backupDir) && !fs.existsSync(this.runtimeDir)) fs.renameSync(backupDir, this.runtimeDir);
            throw error;
          }
          fs.rmSync(backupDir, { recursive: true, force: true });
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
      } else {
        startPhase('browser', 35, 90, 180_000);
      }
      const binary = this.findBinary();
      if (!binary) throw new Error('agent-browser 安装完成但未找到可执行文件');
      if (!browserPhaseStarted) startPhase('browser', 35, 90, 180_000);
      await installBrowserRuntime(binary);
      startPhase('finalizing', 95, 99, 30_000);
      this.binary = binary;
      this.setSettings({ enabled: true });
      this.diskUsageCache.checkedAt = 0;
      this.state = 'ready';
      onProgress?.({ phase: 'finalizing', percent: 100, estimated: true });
    } catch (caught) {
      this.state = 'error';
      this.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      clearInterval(progressTimer);
    }
    return this.status();
  };

  uninstall = (deleteProfile = false, deleteBrowserCache = false): BrowserStatus => {
    this.setSettings({ enabled: false });
    fs.rmSync(this.runtimeDir, { recursive: true, force: true });
    if (deleteBrowserCache) fs.rmSync(this.browserCachePath(), { recursive: true, force: true });
    if (deleteProfile) fs.rmSync(path.join(this.userDataDir, 'browser', 'profiles'), { recursive: true, force: true });
    this.diskUsageCache.checkedAt = 0;
    return this.refresh();
  };

  private findBinary(root = this.runtimeDir): string | undefined {
    const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser');
    if (fs.existsSync(local)) return local;
    if (root !== this.runtimeDir) return undefined;
    const candidates = process.platform === 'win32' ? ['agent-browser.cmd', 'agent-browser'] : ['agent-browser'];
    for (const candidate of candidates) {
      const dirs = (process.env.PATH ?? '').split(path.delimiter);
      for (const dir of dirs) {
        const target = path.join(dir, candidate);
        if (fs.existsSync(target)) return target;
      }
    }
    const home = os.homedir();
    const npx = path.join(home, '.npm', '_npx');
    if (fs.existsSync(npx)) {
      for (const entry of fs.readdirSync(npx)) {
        const target = path.join(npx, entry, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser');
        if (fs.existsSync(target)) return target;
      }
    }
    return undefined;
  }
}

