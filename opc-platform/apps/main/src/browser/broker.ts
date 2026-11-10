import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFilePlatform } from '../process/execFilePlatform';
import type { BrowserInstallProgress } from '@opc/shared/ipc';
import type { BrowserInstallService, BrowserSettings, BrowserStatus } from './install';

export interface BrowserSessionInput { taskId: string; workerId: string; userId?: string; }
export interface BrowserResult { ok: boolean; text: string; details?: Record<string, unknown>; }
export interface BrowserArtifact { ok: boolean; path?: string; text: string; }
export interface BrowserArtifactRegistration { (taskId: string, absolutePath: string): void; }

interface Session extends BrowserSessionInput { id: string; profile: string; lastUsedAt: number; }

const NAVIGATION_COMMANDS = new Set(['click', 'dblclick', 'fill', 'press', 'select', 'tab']);
const RISKY_ACTION_WORDS = /(?:\b(?:submit|send|buy|purchase|checkout|delete|remove|publish|post|confirm|approve|pay|transfer|login|log\s*in|sign\s*out|save)\b|更新|提交|发送|购买|结算|删除|移除|发布|确认|批准|支付|转账|登录|退出|保存)/i;

export function isBrowserActionRisky(preview: string): boolean {
  return RISKY_ACTION_WORDS.test(preview);
}

export function browserDomainAllowed(settings: BrowserSettings, url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (settings.blockedDomains.some((rule) => matchesDomain(hostname, rule))) return false;
    if (settings.allowAllDomains) return true;
    return settings.allowedDomains.some((rule) => matchesDomain(hostname, rule));
  } catch {
    return false;
  }
}

function matchesDomain(hostname: string, rule: string): boolean {
  const normalized = rule.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  return normalized.startsWith('*.')
    ? hostname === normalized.slice(2) || hostname.endsWith(`.${normalized.slice(2)}`)
    : hostname === normalized;
}

export class BrowserBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<void>>();
  private visibleTask?: string;
  private taskWorkspace?: (taskId: string) => string | undefined;
  private registerArtifact?: BrowserArtifactRegistration;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly install: BrowserInstallService, private readonly artifactsRoot?: string) {
    this.cleanupTimer = setInterval(() => { void this.cleanupIdleSessions(); }, 10 * 60_000);
    this.cleanupTimer.unref?.();
  }

  status = (): BrowserStatus => this.install.status();
  settings = (): BrowserSettings => this.install.settings();
  setSettings = (patch: Partial<BrowserSettings>): BrowserSettings => this.install.setSettings(patch);
  setTaskWorkspaceResolver = (resolver: (taskId: string) => string | undefined): void => { this.taskWorkspace = resolver; };
  setArtifactRegistrar = (registrar: BrowserArtifactRegistration): void => { this.registerArtifact = registrar; };
  installBrowser = (onProgress?: (progress: BrowserInstallProgress) => void): Promise<BrowserStatus> => this.install.install(onProgress);
  uninstallBrowser = async (deleteProfile = false, deleteBrowserCache = false): Promise<BrowserStatus> => {
    for (const session of [...this.sessions.values()]) {
      await this.run(session, ['close']).catch(() => undefined);
      this.sessions.delete(session.id);
    }
    this.visibleTask = undefined;
    return this.install.uninstall(deleteProfile, deleteBrowserCache);
  };
  doctor = (): BrowserStatus => this.install.refresh();

  isUrlAllowed(url: string): boolean {
    return browserDomainAllowed(this.settings(), url);
  }

  sessionId(input: BrowserSessionInput): string {
    return this.session(input).id;
  }

  async open(input: BrowserSessionInput, url: string, options: { allowUnlisted?: boolean } = {}): Promise<BrowserResult> {
    if (!this.isUrlAllowed(url) && !options.allowUnlisted) return { ok: false, text: '该网址不在浏览器允许域名中' };
    return this.withLock(input.userId ?? 'default', async () => this.run(input, ['open', url]));
  }

  async command(input: BrowserSessionInput, command: string, args: readonly string[] = [], options: { allowUnlisted?: boolean } = {}): Promise<BrowserResult> {
    return this.withLock(input.userId ?? 'default', async () => {
      const result = await this.run(input, [command, ...args]);
      if (!result.ok || !NAVIGATION_COMMANDS.has(command)) return result;
      const urlResult = await this.run(input, ['get', 'url']);
      const currentUrl = extractUrl(urlResult.text);
      if (options.allowUnlisted || !currentUrl || currentUrl === 'about:blank' || this.isUrlAllowed(currentUrl)) return result;
      await this.run(input, ['back']).catch(() => undefined);
      return { ok: false, text: `浏览器阻止了未允许的页面跳转：${currentUrl}`, details: result.details };
    });
  }

  async clickRisk(input: BrowserSessionInput, ref: string): Promise<{ consequential: boolean; preview?: string }> {
    const snapshot = await this.command(input, 'snapshot', ['-i']);
    if (!snapshot.ok) return { consequential: false };
    const line = snapshot.text.split(/\r?\n/).find((candidate) => candidate.includes(ref));
    return { consequential: Boolean(line && isBrowserActionRisky(line)), ...(line ? { preview: line.trim().slice(0, 240) } : {}) };
  }

  async screenshot(input: BrowserSessionInput): Promise<BrowserArtifact> {
    const taskDir = this.taskDirectory(input);
    fs.mkdirSync(taskDir, { recursive: true });
    const target = path.join(taskDir, 'browser', `screenshot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await this.command(input, 'screenshot', [target]);
    if (result.ok) this.registerArtifact?.(input.taskId, target);
    return { ok: result.ok, text: result.text, ...(result.ok ? { path: target } : {}) };
  }

  async download(input: BrowserSessionInput, selector: string, filename?: string): Promise<BrowserArtifact> {
    const taskDir = this.taskDirectory(input);
    fs.mkdirSync(taskDir, { recursive: true });
    const safeName = path.basename(filename || `download-${Date.now()}`).replace(/[^\w.-]+/g, '_') || `download-${Date.now()}`;
    const target = path.join(taskDir, 'browser', safeName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await this.command(input, 'download', [selector, target]);
    if (result.ok) this.registerArtifact?.(input.taskId, target);
    return { ok: result.ok, text: result.text, ...(result.ok ? { path: target } : {}) };
  }

  async upload(input: BrowserSessionInput, selector: string, absolutePath: string): Promise<BrowserResult> {
    return this.withLock(input.userId ?? 'default', async () => this.run(input, ['upload', selector, absolutePath]));
  }

  async show(taskId: string): Promise<void> {
    this.visibleTask = taskId;
    const session = [...this.sessions.values()].find((item) => item.taskId === taskId);
    if (session) await this.run(session, ['get', 'url'], ['--headed', 'true']);
  }

  async hide(taskId?: string): Promise<void> {
    const targetTask = taskId ?? this.visibleTask;
    if (!taskId || this.visibleTask === taskId) this.visibleTask = undefined;
    const session = [...this.sessions.values()].find((item) => item.taskId === targetTask);
    if (session) await this.run(session, ['get', 'url'], ['--headed', 'false']);
  }

  async resetProfile(userId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) if ((session.userId ?? 'default') === userId) this.sessions.delete(session.id);
    fs.rmSync(this.install.profilePath(userId), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) await this.run(session, ['close']).catch(() => undefined);
    this.sessions.clear();
  }

  private async cleanupIdleSessions(): Promise<void> {
    const cutoff = Date.now() - 30 * 60_000;
    for (const session of [...this.sessions.values()]) {
      if (session.lastUsedAt >= cutoff) continue;
      await this.run(session, ['close']).catch(() => undefined);
      this.sessions.delete(session.id);
      if (this.visibleTask === session.taskId) this.visibleTask = undefined;
    }
  }

  private async run(input: BrowserSessionInput, command: string[], launchArgs: string[] = []): Promise<BrowserResult> {
    const binary = this.install.binaryPath();
    if (!binary || !this.install.status().healthy || !this.settings().enabled) return { ok: false, text: '浏览器未安装或未启用' };
    const session = this.session(input);
    const settings = this.settings();
    const output = await execFilePlatform(binary, ['--session', session.id, '--profile', session.profile, '--download-path', this.taskDirectory(input), ...launchArgs, ...command], {
      timeout: 90_000,
      maxBuffer: Math.max(64_000, settings.maxOutputBytes * 4),
      windowsHide: true,
    }).catch((error: unknown) => ({ stdout: '', stderr: error instanceof Error ? error.message : String(error), error }));
    const text = `${output.stdout ?? ''}${output.stderr ? `\n${output.stderr}` : ''}`.trim();
    return { ok: !('error' in output), text: text.slice(0, settings.maxOutputBytes), details: { sessionId: session.id, command: command[0] } };
  }

  private taskDirectory(input: BrowserSessionInput): string {
    const resolved = this.taskWorkspace?.(input.taskId);
    if (resolved) return resolved;
    return path.join(this.artifactsRoot ?? path.resolve(this.install.profilePath(input.userId ?? 'default'), '..', '..', 'artifacts'), input.taskId);
  }

  private session(input: BrowserSessionInput): Session {
    const readable = input.taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'task';
    const digest = crypto.createHash('sha256').update(input.taskId).digest('hex').slice(0, 12);
    const id = `opc-${readable}-${digest}`;
    const existing = this.sessions.get(id);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
    const session: Session = { ...input, id, profile: this.install.profilePath(input.userId ?? 'default'), lastUsedAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  private async withLock(key: string, work: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try { return await work(); } finally { release(); if (this.locks.get(key) === chain) this.locks.delete(key); }
  }
}

function extractUrl(text: string): string | undefined {
  const candidate = text.trim().split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line) || line === 'about:blank');
  return candidate;
}

