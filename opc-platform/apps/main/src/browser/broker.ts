import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFilePlatform } from '../process/execFilePlatform';
import type { BrowserConnectionTestResult, BrowserInstallProgress, BrowserPreviewResult } from '@opc/shared/ipc';
import type { BrowserInstallService, BrowserSettings, BrowserStatus } from './install';

export interface BrowserSessionInput {
  taskId: string;
  threadId?: string;
  workerId: string;
  userId?: string;
}

export interface BrowserResult {
  ok: boolean;
  text: string;
  details?: Record<string, unknown>;
}

export interface BrowserArtifact {
  ok: boolean;
  path?: string;
  relPath?: string;
  text: string;
}

export interface BrowserArtifactRegistration {
  (taskId: string, absolutePath: string): void;
}

export interface QrLoginSwitchResult {
  switched: boolean;
  method?: 'snapshot' | 'dom';
  label?: string;
  passwordOnly?: boolean;
}

interface Session extends BrowserSessionInput {
  id: string;
  profile: string;
  lastUsedAt: number;
}

interface ManagedRuntimeState {
  port: number;
  pid?: number;
  headed: boolean;
  executablePath: string;
  profileDir: string;
  startedAt: number;
  ownedByProcess: boolean;
}

interface CdpVersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpTargetInfo {
  id: string;
  type?: string;
  title?: string;
  url?: string;
}

const NAVIGATION_COMMANDS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'select', 'tab', 'batch']);
const MUTATING_COMMANDS = new Set([
  'open',
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'select',
  'hover',
  'scroll',
  'back',
  'forward',
  'reload',
  'tab',
  'upload',
  'batch',
]);
const SNAPSHOT_CACHE_TTL_MS = 15_000;
const RISKY_ACTION_WORDS =
  /(?:\b(?:submit|send|buy|purchase|checkout|delete|remove|publish|post|confirm|approve|pay|transfer|sign\s*out)\b|提交|发送|购买|结算|删除|移除|发布|确认|批准|支付|转账|退出|注销)/i;
const CREDENTIAL_INPUT_RE =
  /(?:密码|password|手机号|手机|账号|用户名|邮箱|验证码|phone|mobile|account|username|email|verification)/i;
const INTERACTIVE_INPUT_ROLE_RE = /\b(?:textbox|input|searchbox|combobox|password)\b/i;
const SELECTED_STATE_RE = /\[(?:selected|active|checked|pressed)\]/i;
const CREDENTIAL_SELECTED_TAB_RE = /(?:密码|账号|手机|短信|password|phone|sms)/i;
const QR_TEXT_RE = /(?:扫码|二维码|\bqr\b|qr\s*code|scan\s*qr)/i;
const QR_STRONG_SWITCH_RE =
  /(?:扫码登录|二维码登录|微信扫码|app\s*扫码|手机扫码|使用二维码|qr\s*code\s*log\s*in|scan\s*qr|log\s*in\s*with\s*qr|sign\s*in\s*with\s*qr)/i;
const QR_ALREADY_RENDERED_RE =
  /(?:刷新二维码|重新获取二维码|二维码已失效|二维码已过期|refresh\s*qr)/i;
const QR_NEGATIVE_RE =
  /(?:刷新|重新获取|失效|过期|下载|download|帮助|help|隐私|协议|注册|register|忘记|forgot)/i;
const INTERACTIVE_CLICKABLE_ROLE_RE =
  /\b(?:button|tab|link|img|generic|menuitem|switch|radio)\b/i;

export function extractSnapshotRef(line: string): string | null {
  const atMatch = line.match(/@e(\d+)\b/);
  if (atMatch?.[1]) return `@e${atMatch[1]}`;
  const bracketMatch = line.match(/\[ref=(e\d+)\]/i);
  if (bracketMatch?.[1]) return `@${bracketMatch[1]}`;
  return null;
}

export function hasCredentialLoginInput(snapshotText: string): boolean {
  return snapshotText.split(/\r?\n/).some((line) => {
    if (INTERACTIVE_INPUT_ROLE_RE.test(line) && CREDENTIAL_INPUT_RE.test(line)) {
      return true;
    }
    return SELECTED_STATE_RE.test(line) && CREDENTIAL_SELECTED_TAB_RE.test(line);
  });
}

export function hasRenderedQrHint(snapshotText: string): boolean {
  return snapshotText.split(/\r?\n/).some((line) => {
    if (SELECTED_STATE_RE.test(line) && QR_TEXT_RE.test(line)) return true;
    if (QR_ALREADY_RENDERED_RE.test(line)) return true;
    return /\bimg\b/i.test(line) && /(?:二维码|qr\s*code|qrcode)/i.test(line);
  });
}

export function findQrLoginSwitchRef(snapshotText: string): { ref: string; label: string } | null {
  if (!snapshotText || !hasCredentialLoginInput(snapshotText) || hasRenderedQrHint(snapshotText)) {
    return null;
  }

  let best: { ref: string; label: string; score: number } | null = null;
  for (const line of snapshotText.split(/\r?\n/)) {
    const ref = extractSnapshotRef(line);
    if (!ref) continue;
    if (/\[(?:selected|active|checked|pressed|disabled)\]/i.test(line)) continue;
    if (isBrowserActionRisky(line) || QR_NEGATIVE_RE.test(line)) continue;

    let score = 0;
    if (QR_STRONG_SWITCH_RE.test(line)) {
      score = 100;
    } else if (INTERACTIVE_CLICKABLE_ROLE_RE.test(line) && QR_TEXT_RE.test(line)) {
      score = 60;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { ref, label: line.trim().slice(0, 120), score };
    }
  }

  return best ? { ref: best.ref, label: best.label } : null;
}

const TRY_SWITCH_QR_LOGIN_SCRIPT = `(() => {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      // Cross-origin frame
    }
  }

  const isVisible = (el, win) => {
    if (!el || !(el instanceof win.Element)) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  };

  const strongLabelRe = /(?:扫码登录|二维码登录|微信扫码|app\\s*扫码|扫码更安全|qr\\s*code|scan\\s*qr)/i;
  const attrQrRe = /(?:qr[-_]?code|qr[-_]?login|login[-_]?qr|switch[-_]?qr|scan[-_]?login|icon[-_]?qr|erweima|saoma|qrcode)/i;
  const negativeRe = /(?:刷新|过期|失效|下载|协议|隐私|注册|忘记|refresh|download|help|terms|privacy)/i;
  const credentialSelector = [
    'input[type="password"]',
    'input[autocomplete*="password"]',
    'input[name*="pass" i]',
    'input[placeholder*="密码"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="验证码"]',
  ].join(',');

  let sawCredentialInput = false;

  for (const doc of docs) {
    const win = doc.defaultView || window;
    const inputs = Array.from(doc.querySelectorAll(credentialSelector)).filter((el) => isVisible(el, win));
    if (inputs.length === 0) continue;
    sawCredentialInput = true;

    const qrPresent = Array.from(doc.querySelectorAll('img, canvas, svg')).some((el) => {
      if (!isVisible(el, win)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 90 || rect.height < 90) return false;
      const meta = [
        el.getAttribute('src') || '',
        el.getAttribute('alt') || '',
        typeof el.className === 'string' ? el.className : '',
        el.id || '',
        el.getAttribute('aria-label') || '',
      ].join(' ');
      return /(?:qr|qrcode|erweima|scan)/i.test(meta);
    });
    if (qrPresent) {
      return JSON.stringify({ clicked: false, hasCredentialInput: true, qrVisible: true, reason: 'qr-already-visible' });
    }

    const anchorInput = inputs[0];
    let card = anchorInput.closest('form');
    if (!card) {
      let cur = anchorInput.parentElement;
      while (cur && cur !== doc.body) {
        const r = cur.getBoundingClientRect();
        if (r.width >= 200 && r.width <= 760 && r.height >= 160 && r.height <= 760) {
          card = cur;
        } else if (r.width > 760 || r.height > 760) {
          break;
        }
        cur = cur.parentElement;
      }
    }
    const cardRect = (card || doc.documentElement).getBoundingClientRect();

    let best = null;
    const candidates = doc.querySelectorAll('button, [role="button"], [role="tab"], a, i, svg, img, span, div');
    for (const el of candidates) {
      if (!isVisible(el, win)) continue;
      if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-disabled') === 'true') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 260 || rect.height > 120) continue;

      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const labelMeta = [
        text.length <= 40 ? text : '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('alt') || '',
      ].join(' ').trim();
      if (negativeRe.test(labelMeta)) continue;

      const useHref = el.querySelector('use')?.getAttribute('href') || el.querySelector('use')?.getAttribute('xlink:href') || '';
      const techMeta = [
        typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
        el.id || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-spm') || '',
        el.getAttribute('src') || '',
        useHref,
      ].join(' ');

      let score = 0;
      if (labelMeta && labelMeta.length <= 24 && strongLabelRe.test(labelMeta)) {
        score = Math.max(score, 100);
      }
      if (attrQrRe.test(techMeta) && Math.max(rect.width, rect.height) <= 96) {
        score = Math.max(score, 75);
      }
      if (score === 0) continue;

      const inTopRight = rect.right >= cardRect.left + cardRect.width * 0.55 && rect.top <= cardRect.top + cardRect.height * 0.45;
      if (inTopRight) score += 30;

      const style = win.getComputedStyle(el);
      const isNativeClickable = el.matches('button, a, [role="tab"], [role="button"]');
      if (isNativeClickable || style.cursor === 'pointer') score += 15;

      if (!best || score > best.score) {
        best = { el, score, label: (labelMeta || techMeta).trim().slice(0, 80) };
      }
    }

    if (best && best.score >= 75) {
      let target = best.el;
      const style = win.getComputedStyle(target);
      const isClickable = (node) => {
        const s = win.getComputedStyle(node);
        return s.pointerEvents !== 'none' && (node.matches('button, a, [role="tab"], [role="button"]') || s.cursor === 'pointer');
      };
      if (style.pointerEvents === 'none' || !isClickable(target)) {
        let parent = target.parentElement;
        while (parent && parent !== doc.body) {
          const pr = parent.getBoundingClientRect();
          if (pr.width <= 240 && pr.height <= 100 && isClickable(parent)) {
            target = parent;
            break;
          }
          parent = parent.parentElement;
        }
        if (target === best.el && best.el.parentElement) {
          const sibling = Array.from(best.el.parentElement.children).find((child) => {
            if (child === best.el || !isVisible(child, win)) return false;
            const cr = child.getBoundingClientRect();
            return Math.max(cr.width, cr.height) <= 96 && isClickable(child);
          });
          if (sibling) target = sibling;
        }
      }
      if (typeof target.click === 'function') {
        target.click();
      } else {
        target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return JSON.stringify({ clicked: true, label: best.label, hasCredentialInput: true, qrVisible: false });
    }
  }

  return JSON.stringify({
    clicked: false,
    hasCredentialInput: sawCredentialInput,
    qrVisible: false,
    reason: sawCredentialInput ? 'no-switch-found' : 'no-credential-input',
  });
})()`;

function parseEvalJson<T>(raw: string): T | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const first = JSON.parse(lines[i]!);
      if (typeof first === 'string') {
        return JSON.parse(first) as T;
      }
      if (first && typeof first === 'object') {
        return first as T;
      }
    } catch {
      // Keep searching lines
    }
  }
  return null;
}

export function isBrowserActionRisky(preview: string): boolean {
  return RISKY_ACTION_WORDS.test(preview);
}

export function extractExecFailureText(error: unknown): { stdout: string; stderr: string } {
  const rec = error && typeof error === 'object' ? (error as { stdout?: unknown; stderr?: unknown }) : undefined;
  const stdout = typeof rec?.stdout === 'string' ? rec.stdout.trim() : '';
  const stderr = typeof rec?.stderr === 'string' ? rec.stderr.trim() : '';
  if (stdout || stderr) {
    return { stdout, stderr };
  }
  return {
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}

export function isTabGoneError(text: string): boolean {
  return /\btab_gone\b|pinned\s+tab.*(?:gone|closed|missing|not\s+found)|target\s+closed|no\s+page\s+found|page\s+has\s+been\s+closed/i.test(
    text,
  );
}

export function isStaleDaemonError(text: string): boolean {
  return /\b(?:timed?\s*out|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|socket\s+hang\s+up|daemon\s+(?:not\s+responding|failed|timed?\s*out|disconnected)|connection\s+(?:closed|refused|reset|lost)|websocket\s+(?:closed|error)|failed\s+to\s+connect|cdp\s+(?:connection|session)\s+(?:closed|lost|failed))\b/i.test(
    text,
  );
}

export function browserDomainAllowed(
  settings: Pick<BrowserSettings, 'allowAllDomains' | 'allowedDomains' | 'blockedDomains'>,
  url: string,
): boolean {
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

export function buildAgentBrowserArgs(input: {
  sessionId: string;
  settings: Pick<BrowserSettings, 'mode' | 'attachMethod' | 'cdpEndpoint' | 'pinTab' | 'inputMode'>;
  profilePath: string;
  downloadPath: string;
  managedCdpPort?: number;
  executablePath?: string;
  command: readonly string[];
}): string[] {
  const { sessionId, settings, profilePath, downloadPath, managedCdpPort, executablePath, command } = input;
  const inputMode = settings.inputMode || 'human';

  if (settings.mode === 'managed' && managedCdpPort !== undefined) {
    return [
      '--session',
      sessionId,
      '--cdp',
      String(managedCdpPort),
      ...(settings.pinTab ? ['--pin-tab'] : []),
      '--input-mode',
      inputMode,
      '--download-path',
      downloadPath,
      ...command,
    ];
  }

  if (settings.mode === 'attach') {
    const connectionArgs =
      settings.attachMethod === 'auto-connect'
        ? ['--auto-connect']
        : ['--cdp', settings.cdpEndpoint?.trim() || '9222'];
    return [
      '--session',
      sessionId,
      ...connectionArgs,
      ...(settings.pinTab ? ['--pin-tab'] : []),
      '--input-mode',
      inputMode,
      '--download-path',
      downloadPath,
      ...command,
    ];
  }

  return [
    '--session',
    sessionId,
    '--profile',
    profilePath,
    ...(executablePath ? ['--executable-path', executablePath] : []),
    '--input-mode',
    inputMode,
    '--download-path',
    downloadPath,
    ...command,
  ];
}

function cdpHttpBase(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return null;
}

async function probeCdpVersion(endpoint: string, timeoutMs = 1_200): Promise<CdpVersionInfo | null> {
  const base = cdpHttpBase(endpoint);
  if (!base) return null;
  try {
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as CdpVersionInfo;
  } catch {
    return null;
  }
}

async function probeCdpTargets(endpoint: string, timeoutMs = 1_200): Promise<CdpTargetInfo[]> {
  const base = cdpHttpBase(endpoint);
  if (!base) return [];
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const list = (await response.json()) as CdpTargetInfo[];
    return Array.isArray(list) ? list.filter((item) => item.type === 'page') : [];
  } catch {
    return [];
  }
}

async function activateCdpTarget(endpoint: string, targetId: string): Promise<boolean> {
  const base = cdpHttpBase(endpoint);
  if (!base || !targetId) return false;
  try {
    const response = await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(1_200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function openCdpTab(endpoint: string, url?: string): Promise<boolean> {
  const base = cdpHttpBase(endpoint);
  if (!base) return false;
  const targetUrl = url?.trim() || 'about:blank';
  const reqUrl = `${base}/json/new?${encodeURIComponent(targetUrl)}`;
  for (const method of ['PUT', 'GET'] as const) {
    try {
      const response = await fetch(reqUrl, { method, signal: AbortSignal.timeout(1_500) });
      if (response.ok) return true;
    } catch {
      // Try fallback method.
    }
  }
  return false;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreeLoopbackPort(start = 19_222, end = 19_260): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 19_222;
      server.close(() => resolve(port));
    });
  });
}

function tryFocusProcessWindow(pid?: number): void {
  if (!pid || process.platform !== 'win32') return;
  const psScript =
    `$wshell = New-Object -ComObject WScript.Shell; ` +
    `[void]$wshell.AppActivate(${pid})`;
  void execFilePlatform('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    timeout: 1_800,
    windowsHide: true,
  }).catch(() => undefined);
}

export class BrowserBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionEpoch = new Map<string, number>();
  private readonly snapshotCache = new Map<string, { text: string; at: number }>();
  private readonly locks = new Map<string, Promise<void>>();
  private managedRuntime?: ManagedRuntimeState;
  private managedLaunchPromise?: Promise<ManagedRuntimeState | null>;
  private visibleTask?: string;
  private taskWorkspace?: (taskId: string) => string | undefined;
  private registerArtifact?: BrowserArtifactRegistration;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly install: BrowserInstallService, private readonly artifactsRoot?: string) {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleSessions();
    }, 10 * 60_000);
    this.cleanupTimer.unref?.();
  }

  status = (): BrowserStatus => {
    const base = this.install.status();
    return {
      ...base,
      managedRunning: Boolean(this.managedRuntime),
      ...(this.managedRuntime ? { cdpPort: this.managedRuntime.port } : {}),
    };
  };

  settings = (): BrowserSettings => this.install.settings();

  setSettings = (patch: Partial<BrowserSettings>): BrowserSettings => {
    const prev = this.install.settings();
    const next = this.install.setSettings(patch);
    const connectionChanged =
      prev.mode !== next.mode ||
      prev.attachMethod !== next.attachMethod ||
      prev.cdpEndpoint !== next.cdpEndpoint ||
      prev.executablePath !== next.executablePath ||
      prev.headed !== next.headed ||
      prev.pinTab !== next.pinTab;

    if (connectionChanged) {
      this.snapshotCache.clear();
      this.sessions.clear();
      this.sessionEpoch.clear();
      const binary = this.install.binaryPath();
      if (binary) {
        void execFilePlatform(binary, ['close', '--all'], { timeout: 5_000, windowsHide: true }).catch(() => undefined);
      }
      if (prev.headed !== next.headed || prev.executablePath !== next.executablePath || prev.mode !== next.mode) {
        if (this.managedRuntime?.ownedByProcess && this.managedRuntime.pid) {
          try {
            process.kill(this.managedRuntime.pid);
          } catch {
            // Process already exited.
          }
        }
        this.managedRuntime = undefined;
        try {
          fs.rmSync(this.install.managedRuntimeFile(), { force: true });
        } catch {
          // Ignore file removal errors.
        }
      }
    }
    return next;
  };

  setTaskWorkspaceResolver = (resolver: (taskId: string) => string | undefined): void => {
    this.taskWorkspace = resolver;
  };

  setArtifactRegistrar = (registrar: BrowserArtifactRegistration): void => {
    this.registerArtifact = registrar;
  };

  installBrowser = (onProgress?: (progress: BrowserInstallProgress) => void): Promise<BrowserStatus> =>
    this.install.install(onProgress);

  uninstallBrowser = async (deleteProfile = false, deleteBrowserCache = false): Promise<BrowserStatus> => {
    for (const session of [...this.sessions.values()]) {
      await this.run(session, ['close']).catch(() => undefined);
      this.sessions.delete(session.id);
    }
    this.snapshotCache.clear();
    this.sessionEpoch.clear();
    if (this.managedRuntime?.ownedByProcess && this.managedRuntime.pid) {
      try {
        process.kill(this.managedRuntime.pid);
      } catch {
        // Already exited.
      }
    }
    this.managedRuntime = undefined;
    this.visibleTask = undefined;
    return this.install.uninstall(deleteProfile, deleteBrowserCache);
  };

  doctor = (): BrowserStatus => {
    this.install.refresh();
    return this.status();
  };

  isUrlAllowed(url: string): boolean {
    return browserDomainAllowed(this.settings(), url);
  }

  sessionId(input: BrowserSessionInput): string {
    return this.session(input).id;
  }

  async open(input: BrowserSessionInput, url: string, options: { allowUnlisted?: boolean } = {}): Promise<BrowserResult> {
    if (!this.isUrlAllowed(url) && !options.allowUnlisted) {
      return { ok: false, text: '该网址不在浏览器允许域名中' };
    }
    return this.withLock(input.userId ?? 'default', async () => {
      const session = this.session(input);
      this.snapshotCache.delete(session.id);
      let result = await this.run(input, ['open', url]);
      if (!result.ok && isTabGoneError(result.text)) {
        const reopened = await this.run(input, ['tab', 'new', url]);
        if (reopened.ok) return reopened;
        result = reopened;
      }
      if (!result.ok && isStaleDaemonError(result.text)) {
        this.resetSessionDaemon(input);
        const retried = await this.run(input, ['open', url]);
        if (retried.ok) return retried;
        return {
          ok: false,
          text: `浏览器连接超时或已断开（已自动重置会话重试仍失败）：${retried.text}`,
          details: retried.details,
        };
      }
      return result;
    });
  }

  async command(
    input: BrowserSessionInput,
    command: string,
    args: readonly string[] = [],
    options: { allowUnlisted?: boolean } = {},
  ): Promise<BrowserResult> {
    return this.withLock(input.userId ?? 'default', async () => {
      const session = this.session(input);
      if (MUTATING_COMMANDS.has(command)) {
        this.snapshotCache.delete(session.id);
      }
      const result = await this.run(input, [command, ...args]);
      if (result.ok && command === 'snapshot' && args.includes('-i')) {
        this.snapshotCache.set(session.id, { text: result.text, at: Date.now() });
      }
      if (!result.ok) {
        if (isTabGoneError(result.text)) {
          return {
            ok: false,
            text: `之前锁定的浏览器标签页已被关闭（tab_gone），请先调用 browser_open 重新打开目标网页。\n原始错误：${result.text}`,
            details: result.details,
          };
        }
        if (command !== 'close' && isStaleDaemonError(result.text)) {
          this.resetSessionDaemon(input);
          return {
            ok: false,
            text: `浏览器会话超时或连接中断，已自动重置会话。请调用 browser_open 重新打开页面继续。\n原始错误：${result.text}`,
            details: result.details,
          };
        }
        return result;
      }
      if (!NAVIGATION_COMMANDS.has(command)) return result;

      const urlResult = await this.run(input, ['get', 'url']);
      const currentUrl = extractUrl(urlResult.text);
      if (options.allowUnlisted || !currentUrl || currentUrl === 'about:blank' || this.isUrlAllowed(currentUrl)) {
        return result;
      }
      this.snapshotCache.delete(session.id);
      await this.run(input, ['back']).catch(() => undefined);
      return {
        ok: false,
        text: `浏览器阻止了未允许的页面跳转：${currentUrl}`,
        details: result.details,
      };
    });
  }

  async batch(
    input: BrowserSessionInput,
    commands: readonly string[][],
    options: { allowUnlisted?: boolean; bail?: boolean } = {},
  ): Promise<BrowserResult> {
    return this.withLock(input.userId ?? 'default', async () => {
      const session = this.session(input);
      this.snapshotCache.delete(session.id);
      const flags = ['batch', ...(options.bail !== false ? ['--bail'] : []), '--json'];
      let result = await this.run(input, flags, { stdin: JSON.stringify(commands) });
      if (!result.ok && isTabGoneError(result.text)) {
        if (commands[0]?.[0] === 'open' && commands[0]?.[1]) {
          const reopened = await this.run(input, ['tab', 'new', commands[0][1]]);
          if (!reopened.ok) {
            result = reopened;
          } else if (commands.length === 1) {
            result = reopened;
          } else {
            result = await this.run(input, flags, { stdin: JSON.stringify(commands.slice(1)) });
          }
        } else {
          return {
            ok: false,
            text: `之前锁定的浏览器标签页已被关闭（tab_gone），请先调用 browser_open 重新打开目标网页。\n原始错误：${result.text}`,
            details: result.details,
          };
        }
      }
      if (!result.ok && isStaleDaemonError(result.text)) {
        this.resetSessionDaemon(input);
        return {
          ok: false,
          text: `浏览器批量操作超时或连接中断，已自动重置会话。请调用 browser_open 重新打开页面继续。\n原始错误：${result.text}`,
          details: result.details,
        };
      }
      if (!result.ok) return result;

      const urlResult = await this.run(input, ['get', 'url']);
      const currentUrl = extractUrl(urlResult.text);
      if (options.allowUnlisted || !currentUrl || currentUrl === 'about:blank' || this.isUrlAllowed(currentUrl)) {
        return result;
      }
      this.snapshotCache.delete(session.id);
      await this.run(input, ['back']).catch(() => undefined);
      return {
        ok: false,
        text: `浏览器批量操作触发了未允许的页面跳转：${currentUrl}`,
        details: result.details,
      };
    });
  }

  async clickRisk(input: BrowserSessionInput, ref: string): Promise<{ consequential: boolean; preview?: string }> {
    const session = this.session(input);
    const cached = this.snapshotCache.get(session.id);
    let snapshotText: string | undefined;
    if (cached && Date.now() - cached.at <= SNAPSHOT_CACHE_TTL_MS) {
      snapshotText = cached.text;
    } else {
      const snapshot = await this.command(input, 'snapshot', ['-i']);
      if (snapshot.ok) snapshotText = snapshot.text;
    }
    if (!snapshotText) return { consequential: false };
    const normalizedRef = /^e\d+$/i.test(ref.trim()) ? `@${ref.trim()}` : ref.trim();
    const line = snapshotText
      .split(/\r?\n/)
      .find((candidate) => extractSnapshotRef(candidate) === normalizedRef || candidate.includes(normalizedRef));
    return {
      consequential: Boolean(line && isBrowserActionRisky(line)),
      ...(line ? { preview: line.trim().slice(0, 240) } : {}),
    };
  }

  async screenshot(
    input: BrowserSessionInput,
    options: { annotate?: boolean; fullPage?: boolean; selector?: string } = {},
  ): Promise<BrowserArtifact> {
    const taskDir = this.taskDirectory(input);
    fs.mkdirSync(taskDir, { recursive: true });
    const target = path.join(taskDir, 'browser', `screenshot-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.png`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const selector = options.selector?.trim();
    const args = [
      ...(options.annotate ? ['--annotate'] : []),
      ...(options.fullPage && !selector ? ['--full'] : []),
      ...(selector ? [selector] : []),
      target,
    ];
    const result = await this.command(input, 'screenshot', args);
    const relPath = path.relative(taskDir, target).replace(/\\/g, '/');
    if (result.ok) this.registerArtifact?.(input.taskId, target);
    return { ok: result.ok, text: result.text, ...(result.ok ? { path: target, relPath } : {}) };
  }

  async download(input: BrowserSessionInput, selector: string, filename?: string): Promise<BrowserArtifact> {
    const taskDir = this.taskDirectory(input);
    fs.mkdirSync(taskDir, { recursive: true });
    const safeName =
      path.basename(filename || `download-${Date.now()}`).replace(/[^\w.-]+/g, '_') || `download-${Date.now()}`;
    const target = path.join(taskDir, 'browser', safeName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await this.command(input, 'download', [selector, target]);
    if (result.ok) this.registerArtifact?.(input.taskId, target);
    return { ok: result.ok, text: result.text, ...(result.ok ? { path: target } : {}) };
  }

  async upload(input: BrowserSessionInput, selector: string, absolutePath: string): Promise<BrowserResult> {
    return this.withLock(input.userId ?? 'default', async () => this.run(input, ['upload', selector, absolutePath]));
  }

  async openWindow(url?: string): Promise<{ ok: boolean; error?: string }> {
    const current = this.settings();
    if (!current.enabled) {
      return { ok: false, error: '请先在设置中启用 Personal Agent 浏览器。' };
    }
    if (current.mode === 'attach') {
      const diag = await this.testConnection();
      if (!diag.ok) return { ok: false, error: diag.message };
      const cdpBase = current.attachMethod === 'cdp' ? current.cdpEndpoint : diag.cdpUrl;
      if (cdpBase && url) {
        await openCdpTab(cdpBase, url);
      }
      return { ok: true };
    }

    const runtime = await this.ensureManagedBrowser({
      requireHeaded: true,
      ...(url ? { initialUrl: url } : {}),
    });
    if (!runtime) {
      return {
        ok: false,
        error: '未找到可用的本地 Chrome/Edge 浏览器，请在设置中选择浏览器可执行文件路径。',
      };
    }
    if (url) {
      const targets = await probeCdpTargets(String(runtime.port));
      const alreadyOpen = targets.find((t) => t.url === url);
      if (alreadyOpen) {
        await activateCdpTarget(String(runtime.port), alreadyOpen.id);
      } else {
        await openCdpTab(String(runtime.port), url);
      }
    } else {
      const targets = await probeCdpTargets(String(runtime.port));
      const first = targets[0];
      if (first) await activateCdpTarget(String(runtime.port), first.id);
    }
    tryFocusProcessWindow(runtime.pid);
    return { ok: true };
  }

  async show(taskId: string): Promise<void> {
    this.visibleTask = taskId;
    const current = this.settings();
    const session = [...this.sessions.values()].find((item) => item.taskId === taskId || item.threadId === taskId);

    if (current.mode === 'managed') {
      const runtime = await this.ensureManagedBrowser({ requireHeaded: true });
      if (runtime) {
        if (session) {
          const urlRes = await this.run(session, ['get', 'url']).catch(() => undefined);
          const url = urlRes?.ok ? extractUrl(urlRes.text) : undefined;
          const targets = await probeCdpTargets(String(runtime.port));
          const matched = (url ? targets.find((t) => t.url === url) : undefined) ?? targets[0];
          if (matched) {
            await activateCdpTarget(String(runtime.port), matched.id);
          }
        }
        tryFocusProcessWindow(runtime.pid);
      }
      return;
    }

    if (current.mode === 'attach' && session && current.attachMethod === 'cdp') {
      const urlRes = await this.run(session, ['get', 'url']).catch(() => undefined);
      const url = urlRes?.ok ? extractUrl(urlRes.text) : undefined;
      const targets = await probeCdpTargets(current.cdpEndpoint);
      const matched = url ? targets.find((t) => t.url === url) : targets[0];
      if (matched) {
        await activateCdpTarget(current.cdpEndpoint, matched.id);
      }
    }
  }

  async hide(taskId?: string): Promise<void> {
    if (!taskId || this.visibleTask === taskId) {
      this.visibleTask = undefined;
    }
  }

  async capturePreview(taskId: string, selector?: string): Promise<BrowserPreviewResult> {
    const session = [...this.sessions.values()].find((item) => item.taskId === taskId || item.threadId === taskId);
    const input: BrowserSessionInput = session
      ? {
          taskId,
          ...(session.threadId ? { threadId: session.threadId } : {}),
          workerId: session.workerId,
          ...(session.userId ? { userId: session.userId } : {}),
        }
      : { taskId, workerId: 'preview' };

    const trimmedSelector = selector?.trim();
    let shot = await this.screenshot(input, trimmedSelector ? { selector: trimmedSelector } : {});
    if (!shot.ok && trimmedSelector) {
      shot = await this.screenshot(input);
    }
    if (!shot.ok || !shot.relPath) {
      return { ok: false, error: shot.text || '无法截取当前浏览器画面' };
    }

    const urlRes = await this.command(input, 'get', ['url']).catch(() => undefined);
    const url = urlRes?.ok ? extractUrl(urlRes.text) : undefined;
    return {
      ok: true,
      taskId,
      relPath: shot.relPath,
      ...(url ? { url } : {}),
    };
  }

  async trySwitchToQrLogin(input: BrowserSessionInput): Promise<QrLoginSwitchResult> {
    const session = this.session(input);
    const cached = this.snapshotCache.get(session.id);
    let snapshotText: string | undefined;
    if (cached && Date.now() - cached.at <= SNAPSHOT_CACHE_TTL_MS) {
      snapshotText = cached.text;
    } else {
      const snapRes = await this.command(input, 'snapshot', ['-i']).catch(() => undefined);
      if (snapRes?.ok) snapshotText = snapRes.text;
    }

    if (snapshotText) {
      const candidate = findQrLoginSwitchRef(snapshotText);
      if (candidate) {
        const clicked = await this.command(input, 'click', [candidate.ref]).catch(() => ({ ok: false, text: '' }));
        if (clicked.ok) {
          await this.command(input, 'wait', ['900']).catch(() => undefined);
          return { switched: true, method: 'snapshot', label: candidate.label };
        }
      }
      if (hasRenderedQrHint(snapshotText)) {
        return { switched: false, passwordOnly: false };
      }
    }

    const evalRes = await this.withLock(input.userId ?? 'default', () =>
      this.run(input, ['eval', '--stdin'], { stdin: TRY_SWITCH_QR_LOGIN_SCRIPT }),
    ).catch(() => ({ ok: false, text: '' }));

    const parsed = evalRes.ok
      ? parseEvalJson<{ clicked?: boolean; label?: string; hasCredentialInput?: boolean; qrVisible?: boolean }>(
          evalRes.text,
        )
      : null;

    if (parsed?.clicked) {
      this.snapshotCache.delete(session.id);
      await this.command(input, 'wait', ['900']).catch(() => undefined);
      return {
        switched: true,
        method: 'dom',
        ...(parsed.label ? { label: parsed.label } : {}),
      };
    }

    const passwordOnly = Boolean(
      (parsed?.hasCredentialInput && !parsed?.qrVisible) ||
        (snapshotText && hasCredentialLoginInput(snapshotText) && !hasRenderedQrHint(snapshotText)),
    );
    return { switched: false, passwordOnly };
  }

  async testConnection(): Promise<BrowserConnectionTestResult> {
    const current = this.settings();
    if (current.mode === 'managed') {
      const browser = this.install.resolvedBrowser();
      const runningPort = await this.existingManagedPort();
      if (!browser) {
        return {
          ok: Boolean(this.install.binaryPath()),
          mode: 'managed',
          browserName: 'Chrome for Testing',
          message: this.install.binaryPath()
            ? '未探测到系统 Chrome/Edge，将回退使用内置 Chrome for Testing。'
            : '未检测到本地浏览器且尚未安装运行时。',
        };
      }
      const version = runningPort ? await probeCdpVersion(String(runningPort)) : null;
      const tabs = runningPort ? await probeCdpTargets(String(runningPort)) : [];
      return {
        ok: true,
        mode: 'managed',
        browserName: browser.name,
        ...(runningPort ? { cdpUrl: `http://127.0.0.1:${runningPort}`, tabCount: tabs.length } : {}),
        message: version
          ? `已连接 ${browser.name}（${version.Browser ?? '运行中'}，${tabs.length} 个标签页）。`
          : `已就绪：将使用本机正版 ${browser.name}（独立持久化档案，首次打开时自动启动）。`,
      };
    }

    if (current.mode === 'attach') {
      const binary = this.install.binaryPath();
      if (!binary) {
        return {
          ok: false,
          mode: 'attach',
          message: '请先安装浏览器运行时（agent-browser CLI）。',
        };
      }
      if (current.attachMethod === 'auto-connect') {
        const res = await execFilePlatform(binary, ['--auto-connect', 'get', 'cdp-url'], {
          timeout: 6_000,
          windowsHide: true,
        }).catch((err: unknown) => ({ stdout: '', stderr: err instanceof Error ? err.message : String(err), error: true }));
        const out = `${res.stdout ?? ''} ${res.stderr ?? ''}`.trim();
        const wsMatch = out.match(/ws:\/\/[^\s"']+/i);
        if (!('error' in res) && wsMatch) {
          return {
            ok: true,
            mode: 'attach',
            browserName: '日常 Chrome',
            cdpUrl: wsMatch[0],
            message: `已发现正在运行的日常 Chrome（Auto-Connect 就绪）。`,
          };
        }
        return {
          ok: false,
          mode: 'attach',
          browserName: '日常 Chrome',
          message:
            '未检测到开启远程调试的 Chrome。请在日常 Chrome 地址栏打开 chrome://inspect/#remote-debugging 并开启远程调试，或在设置中改用 CDP 端口模式。',
        };
      }

      const info = await probeCdpVersion(current.cdpEndpoint);
      if (!info) {
        return {
          ok: false,
          mode: 'attach',
          browserName: '日常 Chrome',
          message: `无法连接 CDP 端点（${current.cdpEndpoint}）。请确认 Chrome 已带 --remote-debugging-port=${current.cdpEndpoint} 启动。`,
        };
      }
      const tabs = await probeCdpTargets(current.cdpEndpoint);
      return {
        ok: true,
        mode: 'attach',
        browserName: info.Browser ?? 'Chrome',
        ...(info.webSocketDebuggerUrl ? { cdpUrl: info.webSocketDebuggerUrl } : {}),
        tabCount: tabs.length,
        message: `连接成功：${info.Browser ?? 'Chrome'}，当前共有 ${tabs.length} 个打开的标签页。`,
      };
    }

    return {
      ok: Boolean(this.install.binaryPath()),
      mode: 'headless',
      browserName: this.install.activeBrowserName(),
      message: this.install.binaryPath() ? '后台静默模式已就绪。' : '请先安装浏览器运行时。',
    };
  }

  async resetProfile(userId: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if ((session.userId ?? 'default') === userId) this.sessions.delete(session.id);
    }
    this.snapshotCache.clear();
    this.sessionEpoch.clear();
    if (this.managedRuntime?.ownedByProcess && this.managedRuntime.pid) {
      try {
        process.kill(this.managedRuntime.pid);
      } catch {
        // Already exited.
      }
    }
    this.managedRuntime = undefined;
    fs.rmSync(this.install.managedRuntimeFile(), { force: true });
    fs.rmSync(this.install.profilePath(userId), { recursive: true, force: true });
    fs.rmSync(this.install.personalProfilePath(), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      await this.run(session, ['close']).catch(() => undefined);
    }
    this.sessions.clear();
    this.snapshotCache.clear();
    this.sessionEpoch.clear();
    if (this.managedRuntime?.ownedByProcess && this.managedRuntime.pid) {
      try {
        process.kill(this.managedRuntime.pid);
      } catch {
        // Already exited.
      }
    }
    this.managedRuntime = undefined;
  }

  private async existingManagedPort(): Promise<number | undefined> {
    if (this.managedRuntime) {
      const alive = await probeCdpVersion(String(this.managedRuntime.port));
      if (alive) return this.managedRuntime.port;
      this.managedRuntime = undefined;
    }
    const persisted = this.readManagedRuntimeFile();
    if (persisted) {
      const alive = await probeCdpVersion(String(persisted.port));
      if (alive) {
        this.managedRuntime = persisted;
        return persisted.port;
      }
    }
    return undefined;
  }

  private readManagedRuntimeFile(): ManagedRuntimeState | undefined {
    try {
      const raw = fs.readFileSync(this.install.managedRuntimeFile(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ManagedRuntimeState>;
      if (typeof parsed.port === 'number' && Number.isFinite(parsed.port)) {
        return {
          port: parsed.port,
          ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
          headed: parsed.headed !== false,
          executablePath: typeof parsed.executablePath === 'string' ? parsed.executablePath : '',
          profileDir: typeof parsed.profileDir === 'string' ? parsed.profileDir : '',
          startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
          ownedByProcess: false,
        };
      }
    } catch {
      // Missing or invalid state file.
    }
    return undefined;
  }

  private async ensureManagedBrowser(options: {
    requireHeaded?: boolean;
    initialUrl?: string;
  } = {}): Promise<ManagedRuntimeState | null> {
    const current = this.settings();
    const wantHeaded = options.requireHeaded === true || current.headed;

    const existingPort = await this.existingManagedPort();
    if (existingPort && this.managedRuntime) {
      if (!wantHeaded || this.managedRuntime.headed) {
        return this.managedRuntime;
      }
      if (this.managedRuntime.pid) {
        try {
          process.kill(this.managedRuntime.pid);
        } catch {
          // Ignore kill failures.
        }
      }
      this.managedRuntime = undefined;
    }

    if (this.managedLaunchPromise) {
      return this.managedLaunchPromise;
    }

    this.managedLaunchPromise = (async () => {
      const executablePath = this.install.resolvedExecutablePath();
      if (!executablePath) return null;

      const port = await findFreeLoopbackPort();
      const profileDir = this.install.personalProfilePath();
      const launchArgs = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        ...(wantHeaded ? [] : ['--headless=new']),
        ...(options.initialUrl ? [options.initialUrl] : ['about:blank']),
      ];

      const child = spawn(executablePath, launchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: !wantHeaded,
      });
      child.unref();

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const info = await probeCdpVersion(String(port), 500);
        if (info) {
          const runtime: ManagedRuntimeState = {
            port,
            ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
            headed: wantHeaded,
            executablePath,
            profileDir,
            startedAt: Date.now(),
            ownedByProcess: true,
          };
          this.managedRuntime = runtime;
          try {
            fs.mkdirSync(path.dirname(this.install.managedRuntimeFile()), { recursive: true });
            fs.writeFileSync(this.install.managedRuntimeFile(), JSON.stringify(runtime, null, 2));
          } catch {
            // Best-effort runtime file persistence.
          }
          return runtime;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    })().finally(() => {
      this.managedLaunchPromise = undefined;
    });

    return this.managedLaunchPromise;
  }

  private async cleanupIdleSessions(): Promise<void> {
    const cutoff = Date.now() - 30 * 60_000;
    for (const session of [...this.sessions.values()]) {
      if (session.lastUsedAt >= cutoff) continue;
      await this.run(session, ['close']).catch(() => undefined);
      this.sessions.delete(session.id);
      this.snapshotCache.delete(session.id);
      if (this.visibleTask === session.taskId) this.visibleTask = undefined;
    }
  }

  private async run(
    input: BrowserSessionInput,
    command: readonly string[],
    options: { stdin?: string } = {},
  ): Promise<BrowserResult> {
    const binary = this.install.binaryPath();
    if (!binary || !this.install.status().healthy || !this.settings().enabled) {
      return { ok: false, text: '浏览器未安装或未启用' };
    }
    const session = this.session(input);
    const settings = this.settings();

    let managedCdpPort: number | undefined;
    if (settings.mode === 'managed') {
      const runtime = await this.ensureManagedBrowser();
      managedCdpPort = runtime?.port;
    }

    const executablePath = settings.mode === 'headless' ? this.install.resolvedExecutablePath() : undefined;
    const args = buildAgentBrowserArgs({
      sessionId: session.id,
      settings,
      profilePath: session.profile,
      downloadPath: this.taskDirectory(input),
      ...(managedCdpPort !== undefined ? { managedCdpPort } : {}),
      ...(executablePath ? { executablePath } : {}),
      command,
    });

    const task = execFilePlatform(binary, args, {
      timeout: 45_000,
      maxBuffer: Math.max(64_000, settings.maxOutputBytes * 4),
      windowsHide: true,
    });
    if (options.stdin !== undefined) {
      task.child?.stdin?.end(options.stdin);
    }

    const output = await task.catch((error: unknown) => ({
      ...extractExecFailureText(error),
      error,
    }));
    const text = `${output.stdout ?? ''}${output.stderr ? `\n${output.stderr}` : ''}`.trim();
    return {
      ok: !('error' in output),
      text: text.slice(0, settings.maxOutputBytes),
      details: { sessionId: session.id, command: command[0] },
    };
  }

  private resetSessionDaemon(input: BrowserSessionInput): void {
    const scopeKey = input.threadId || input.taskId;
    const oldSession = this.session(input);
    const oldId = oldSession.id;
    this.sessions.delete(oldId);
    this.snapshotCache.delete(oldId);
    if (this.visibleTask === input.taskId) {
      this.visibleTask = undefined;
    }
    this.sessionEpoch.set(scopeKey, (this.sessionEpoch.get(scopeKey) ?? 0) + 1);
    const binary = this.install.binaryPath();
    if (binary) {
      void execFilePlatform(binary, ['--session', oldId, 'close'], {
        timeout: 5_000,
        windowsHide: true,
      }).catch(() => undefined);
    }
  }

  private taskDirectory(input: BrowserSessionInput): string {
    const resolved = this.taskWorkspace?.(input.taskId);
    if (resolved) return resolved;
    return path.join(
      this.artifactsRoot ?? path.resolve(this.install.profilePath(input.userId ?? 'default'), '..', '..', 'artifacts'),
      input.taskId,
    );
  }

  private session(input: BrowserSessionInput): Session {
    const scopeKey = input.threadId || input.taskId;
    const readable = scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'task';
    const digest = crypto.createHash('sha256').update(scopeKey).digest('hex').slice(0, 12);
    const epoch = this.sessionEpoch.get(scopeKey) ?? 0;
    const id = epoch > 0 ? `opc-${readable}-${digest}-r${epoch}` : `opc-${readable}-${digest}`;
    const existing = this.sessions.get(id);
    if (existing) {
      existing.taskId = input.taskId;
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const settings = this.settings();
    const profile =
      settings.mode === 'managed' && typeof this.install.personalProfilePath === 'function'
        ? this.install.personalProfilePath()
        : this.install.profilePath(input.userId ?? 'default');
    const session: Session = { ...input, id, profile, lastUsedAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  private async withLock(key: string, work: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }
}

function extractUrl(text: string): string | undefined {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//i.test(line) || line === 'about:blank');
}
