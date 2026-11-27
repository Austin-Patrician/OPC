import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import {
  browserDomainAllowed,
  BrowserBroker,
  buildAgentBrowserArgs,
  extractExecFailureText,
  findQrLoginSwitchRef,
  isBrowserActionRisky,
  isStaleDaemonError,
  isTabGoneError,
} from './broker';
import { BrowserInstallService, normalizeBrowserSettings } from './install';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('browserDomainAllowed', () => {
  const base = {
    enabled: true,
    allowedDomains: ['example.com', '*.company.test'],
    blockedDomains: [],
    allowAllDomains: false,
    requireApprovalFor: [],
    maxOutputBytes: 32_000,
  };

  it('matches exact and wildcard domains without allowing lookalikes', () => {
    expect(browserDomainAllowed(base, 'https://example.com/a')).toBe(true);
    expect(browserDomainAllowed(base, 'https://sub.company.test/a')).toBe(true);
    expect(browserDomainAllowed(base, 'https://example.com.evil.test')).toBe(false);
  });

  it('gives blocked domains precedence', () => {
    expect(
      browserDomainAllowed({ ...base, allowAllDomains: true, blockedDomains: ['*.company.test'] }, 'https://sub.company.test'),
    ).toBe(false);
  });

  it('rejects malformed and unsupported URLs', () => {
    expect(browserDomainAllowed({ ...base, allowAllDomains: true }, 'not a url')).toBe(false);
    expect(browserDomainAllowed({ ...base, allowAllDomains: true }, 'file:///tmp/secret')).toBe(false);
  });

  it('recognizes consequential controls while allowing benign navigation to login pages', () => {
    expect(isBrowserActionRisky('button "Submit application"')).toBe(true);
    expect(isBrowserActionRisky('按钮「提交订单」')).toBe(true);
    expect(isBrowserActionRisky('button "Sign in"')).toBe(false);
    expect(isBrowserActionRisky('link "登录"')).toBe(false);
    expect(isBrowserActionRisky('link "Documentation"')).toBe(false);
  });
});

describe('buildAgentBrowserArgs', () => {
  it('按三种模式拼装正确 CLI 参数（managed CDP+pin-tab / attach auto-connect / headless profile）', () => {
    const managedSettings = normalizeBrowserSettings({ mode: 'managed', pinTab: true, inputMode: 'human' });
    expect(
      buildAgentBrowserArgs({
        sessionId: 'opc-th-1',
        settings: managedSettings,
        profilePath: '/tmp/personal',
        downloadPath: '/tmp/dl',
        managedCdpPort: 19222,
        command: ['open', 'https://example.com'],
      }),
    ).toEqual([
      '--session',
      'opc-th-1',
      '--cdp',
      '19222',
      '--pin-tab',
      '--input-mode',
      'human',
      '--download-path',
      '/tmp/dl',
      'open',
      'https://example.com',
    ]);

    const attachAuto = normalizeBrowserSettings({ mode: 'attach', attachMethod: 'auto-connect', pinTab: true });
    expect(
      buildAgentBrowserArgs({
        sessionId: 'opc-th-2',
        settings: attachAuto,
        profilePath: '/tmp/personal',
        downloadPath: '/tmp/dl',
        command: ['snapshot', '-i'],
      }),
    ).toEqual([
      '--session',
      'opc-th-2',
      '--auto-connect',
      '--pin-tab',
      '--input-mode',
      'human',
      '--download-path',
      '/tmp/dl',
      'snapshot',
      '-i',
    ]);

    const attachCdp = normalizeBrowserSettings({
      mode: 'attach',
      attachMethod: 'cdp',
      cdpEndpoint: '9333',
      pinTab: false,
      inputMode: 'smooth',
    });
    expect(
      buildAgentBrowserArgs({
        sessionId: 'opc-th-3',
        settings: attachCdp,
        profilePath: '/tmp/personal',
        downloadPath: '/tmp/dl',
        command: ['get', 'url'],
      }),
    ).toEqual([
      '--session',
      'opc-th-3',
      '--cdp',
      '9333',
      '--input-mode',
      'smooth',
      '--download-path',
      '/tmp/dl',
      'get',
      'url',
    ]);

    const headless = normalizeBrowserSettings({ mode: 'headless', inputMode: 'instant' });
    expect(
      buildAgentBrowserArgs({
        sessionId: 'opc-th-4',
        settings: headless,
        profilePath: '/tmp/user',
        downloadPath: '/tmp/dl',
        executablePath: '/usr/bin/google-chrome',
        command: ['read'],
      }),
    ).toEqual([
      '--session',
      'opc-th-4',
      '--profile',
      '/tmp/user',
      '--executable-path',
      '/usr/bin/google-chrome',
      '--input-mode',
      'instant',
      '--download-path',
      '/tmp/dl',
      'read',
    ]);
  });
});

describe('BrowserBroker snapshot cache', () => {
  it('clickRisk 复用缓存快照并在导航/点击后失效', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-broker-cache-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const install = new BrowserInstallService(db, dir);
    const broker = new BrowserBroker(install, dir);

    const runSpy = vi
      .spyOn(broker as unknown as { run: (i: unknown, cmd: readonly string[]) => Promise<{ ok: boolean; text: string }> }, 'run')
      .mockImplementation(async (_i, cmd) => {
        if (cmd[0] === 'snapshot') {
          return { ok: true, text: '@e1 button "提交发布"\n@e2 link "查看详情"' };
        }
        return { ok: true, text: 'ok' };
      });

    const input = { taskId: 'task-1', threadId: 'th-1', workerId: 'w-1', userId: 'user' };
    const snap = await broker.command(input, 'snapshot', ['-i']);
    expect(snap.ok).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Cache hit: zero extra CLI spawn inside clickRisk
    const r1 = await broker.clickRisk(input, '@e1');
    expect(r1.consequential).toBe(true);
    expect(r1.preview).toContain('提交发布');
    expect(runSpy).toHaveBeenCalledTimes(1);

    const r2 = await broker.clickRisk(input, '@e2');
    expect(r2.consequential).toBe(false);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Mutating command invalidates cache so next clickRisk fetches fresh snapshot
    await broker.command(input, 'scroll', ['down']);
    const r3 = await broker.clickRisk(input, '@e1');
    expect(r3.consequential).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(3);

    await broker.dispose();
    db.close();
  });

  it('screenshot 支持元素选择器特写且 capturePreview 在选择器失败时自动回退视口截图', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-broker-preview-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const install = new BrowserInstallService(db, dir);
    const broker = new BrowserBroker(install, dir);

    const runSpy = vi
      .spyOn(broker as unknown as { run: (i: unknown, cmd: readonly string[]) => Promise<{ ok: boolean; text: string }> }, 'run')
      .mockImplementation(async (_i, cmd) => {
        if (cmd[0] === 'screenshot' && cmd[1] === '@e12') {
          return { ok: true, text: 'ok' };
        }
        if (cmd[0] === 'screenshot' && cmd[1] === '@e99') {
          return { ok: false, text: 'element not found' };
        }
        if (cmd[0] === 'screenshot') {
          return { ok: true, text: 'ok' };
        }
        if (cmd[0] === 'get' && cmd[1] === 'url') {
          return { ok: true, text: 'https://creator.xiaohongshu.com/login' };
        }
        return { ok: true, text: 'ok' };
      });

    const input = { taskId: 'task-qr', threadId: 'th-qr', workerId: 'w-qr', userId: 'user' };
    const crop = await broker.screenshot(input, { selector: '@e12' });
    expect(crop.ok).toBe(true);
    expect(crop.relPath).toMatch(/^browser\/screenshot-.*\.png$/);
    expect(runSpy).toHaveBeenCalledWith(input, ['screenshot', '@e12', expect.stringMatching(/screenshot-.*\.png$/)]);

    const preview = await broker.capturePreview('task-qr', '@e99');
    expect(preview).toEqual({
      ok: true,
      taskId: 'task-qr',
      relPath: expect.stringMatching(/^browser\/screenshot-.*\.png$/),
      url: 'https://creator.xiaohongshu.com/login',
    });

    await broker.dispose();
    db.close();
  });
});

describe('QR login auto-switcher', () => {
  it('findQrLoginSwitchRef 能识别带 ref 的扫码切换按钮并在已扫码/无凭据框/风险链接时不误点', () => {
    const passwordSnapshot = [
      '- tab "密码登录" [ref=e1] [selected]',
      '- tab "扫码登录" [ref=e2]',
      '- textbox "请输入手机号或邮箱" [ref=e3]',
      '- textbox "请输入密码" [ref=e4]',
      '- button "登录" [ref=e5]',
    ].join('\n');
    expect(findQrLoginSwitchRef(passwordSnapshot)).toEqual({
      ref: '@e2',
      label: '- tab "扫码登录" [ref=e2]',
    });

    const atRefSnapshot = [
      '@e1 button "账密登录" [active]',
      '@e2 link "微信扫码登录"',
      '@e3 input "密码"',
    ].join('\n');
    expect(findQrLoginSwitchRef(atRefSnapshot)).toEqual({
      ref: '@e2',
      label: '@e2 link "微信扫码登录"',
    });

    const alreadySelectedQr = [
      '- tab "密码登录" [ref=e1]',
      '- tab "扫码登录" [ref=e2] [selected]',
      '- textbox "请输入密码" [ref=e3]',
    ].join('\n');
    expect(findQrLoginSwitchRef(alreadySelectedQr)).toBeNull();

    const qrRendered = [
      '- textbox "密码" [ref=e1]',
      '- button "扫码登录" [ref=e2]',
      '- button "刷新二维码" [ref=e3]',
    ].join('\n');
    expect(findQrLoginSwitchRef(qrRendered)).toBeNull();

    const downloadAppPage = [
      '- button "扫码登录" [ref=e1]',
      '- link "下载 App 扫码体验" [ref=e2]',
    ].join('\n');
    expect(findQrLoginSwitchRef(downloadAppPage)).toBeNull();
  });

  it('trySwitchToQrLogin 支持快照点击切换、DOM 角落图标 eval 回退与纯密码兜底', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-broker-qr-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const install = new BrowserInstallService(db, dir);
    const broker = new BrowserBroker(install, dir);
    const input = { taskId: 'task-login', threadId: 'th-login', workerId: 'w-login', userId: 'user' };

    // 1. Snapshot switch path
    const runSpy = vi
      .spyOn(
        broker as unknown as {
          run: (i: unknown, cmd: readonly string[], opts?: { stdin?: string }) => Promise<{ ok: boolean; text: string }>;
        },
        'run',
      )
      .mockImplementation(async (_i, cmd) => {
        if (cmd[0] === 'snapshot') {
          return { ok: true, text: 'textbox "密码" @e1\nbutton "扫码登录" @e5' };
        }
        return { ok: true, text: 'ok' };
      });

    const snapResult = await broker.trySwitchToQrLogin(input);
    expect(snapResult).toMatchObject({ switched: true, method: 'snapshot' });
    expect(runSpy).toHaveBeenCalledWith(input, ['click', '@e5']);
    expect(runSpy).toHaveBeenCalledWith(input, ['wait', '900']);

    // 2. DOM top-right corner icon fallback via eval --stdin
    runSpy.mockReset();
    runSpy.mockImplementation(async (_i, cmd, opts) => {
      if (cmd[0] === 'snapshot') {
        return { ok: true, text: 'textbox "手机号" @e1\ntextbox "密码" @e2\nbutton "登录" @e3' };
      }
      if (cmd[0] === 'eval') {
        expect(cmd).toEqual(['eval', '--stdin']);
        expect(opts?.stdin).toContain('icon[-_]?qr');
        return {
          ok: true,
          text: JSON.stringify(
            JSON.stringify({ clicked: true, label: 'icon-qrcode', hasCredentialInput: true, qrVisible: false }),
          ),
        };
      }
      return { ok: true, text: 'ok' };
    });

    const domResult = await broker.trySwitchToQrLogin(input);
    expect(domResult).toEqual({ switched: true, method: 'dom', label: 'icon-qrcode' });
    expect(runSpy).toHaveBeenCalledWith(input, ['wait', '900']);

    // 3. Password-only fallback
    runSpy.mockReset();
    runSpy.mockImplementation(async (_i, cmd) => {
      if (cmd[0] === 'snapshot') {
        return { ok: true, text: 'textbox "邮箱" @e1\ntextbox "密码" @e2' };
      }
      if (cmd[0] === 'eval') {
        return {
          ok: true,
          text: JSON.stringify({ clicked: false, hasCredentialInput: true, qrVisible: false, reason: 'no-switch-found' }),
        };
      }
      return { ok: true, text: 'ok' };
    });

    const passwordOnlyResult = await broker.trySwitchToQrLogin(input);
    expect(passwordOnlyResult).toEqual({ switched: false, passwordOnly: true });

    await broker.dispose();
    db.close();
  });
});

describe('BrowserBroker error clarity & self-healing', () => {
  it('extractExecFailureText、isTabGoneError 与 isStaleDaemonError 准确识别真实错误文本', () => {
    const errWithStderr = Object.assign(new Error('Command exited with code 1'), {
      stdout: '',
      stderr: '✗ tab_gone: pinned tab was closed',
    });
    expect(extractExecFailureText(errWithStderr)).toEqual({
      stdout: '',
      stderr: '✗ tab_gone: pinned tab was closed',
    });
    expect(extractExecFailureText(new Error('spawn EINVAL'))).toEqual({
      stdout: '',
      stderr: 'spawn EINVAL',
    });

    expect(isTabGoneError('✗ tab_gone: pinned tab was closed')).toBe(true);
    expect(isTabGoneError('Target closed')).toBe(true);
    expect(isTabGoneError('element not found')).toBe(false);

    expect(isStaleDaemonError('Timeout 25000ms exceeded waiting for response')).toBe(true);
    expect(isStaleDaemonError('CDP connection closed')).toBe(true);
    expect(isStaleDaemonError('element not found')).toBe(false);
  });

  it('clickRisk 支持 Playwright [ref=e1] 格式并匹配 @e1 与 e1', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-broker-ref-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const install = new BrowserInstallService(db, dir);
    const broker = new BrowserBroker(install, dir);

    vi.spyOn(
      broker as unknown as { run: (i: unknown, cmd: readonly string[]) => Promise<{ ok: boolean; text: string }> },
      'run',
    ).mockResolvedValue({
      ok: true,
      text: '- button "提交订单" [ref=e1]\n- link "查看详情" [ref=e12]',
    });

    const input = { taskId: 'task-ref', threadId: 'th-ref', workerId: 'w-ref', userId: 'user' };
    expect(await broker.clickRisk(input, '@e1')).toEqual({
      consequential: true,
      preview: '- button "提交订单" [ref=e1]',
    });
    expect(await broker.clickRisk(input, 'e12')).toEqual({
      consequential: false,
      preview: '- link "查看详情" [ref=e12]',
    });

    await broker.dispose();
    db.close();
  });

  it('open 在 tab_gone 时自动用 tab new 恢复，snapshot 返回清晰中文指引；超时时轮转 session 重试 open 且不重放 click', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-broker-heal-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const install = new BrowserInstallService(db, dir);
    install.setSettings({ allowAllDomains: true });
    const broker = new BrowserBroker(install, dir);
    const input = { taskId: 'task-heal', threadId: 'th-heal', workerId: 'w-heal', userId: 'user' };
    const initialSessionId = broker.sessionId(input);

    const runSpy = vi
      .spyOn(
        broker as unknown as { run: (i: unknown, cmd: readonly string[]) => Promise<{ ok: boolean; text: string }> },
        'run',
      )
      .mockImplementation(async (_i, cmd) => {
        if (cmd[0] === 'open' && broker.sessionId(input) === initialSessionId) {
          return { ok: false, text: '✗ tab_gone: pinned tab closed' };
        }
        if (cmd[0] === 'tab' && cmd[1] === 'new') {
          return { ok: true, text: 'https://www.jd.com' };
        }
        return { ok: true, text: 'ok' };
      });

    // 1. open auto-recovers tab_gone via tab new
    const openRecovered = await broker.open(input, 'https://www.jd.com');
    expect(openRecovered).toEqual({ ok: true, text: 'https://www.jd.com' });
    expect(runSpy).toHaveBeenCalledWith(input, ['tab', 'new', 'https://www.jd.com']);

    // 2. snapshot on tab_gone gives actionable guidance
    runSpy.mockResolvedValueOnce({ ok: false, text: '✗ tab_gone: pinned tab closed' });
    const snapFailed = await broker.command(input, 'snapshot', ['-i']);
    expect(snapFailed.ok).toBe(false);
    expect(snapFailed.text).toContain('标签页已被关闭（tab_gone）');

    // 3. open on timeout rotates session epoch (-r1) and retries once
    let openAttempts = 0;
    runSpy.mockImplementation(async (_i, cmd) => {
      if (cmd[0] === 'open') {
        openAttempts += 1;
        if (openAttempts === 1) return { ok: false, text: 'Timeout 25000ms exceeded' };
        return { ok: true, text: '✓ recovered' };
      }
      return { ok: true, text: 'ok' };
    });
    const openTimeoutRecovered = await broker.open(input, 'https://example.com');
    expect(openTimeoutRecovered).toEqual({ ok: true, text: '✓ recovered' });
    expect(openAttempts).toBe(2);
    expect(broker.sessionId(input)).toBe(`${initialSessionId}-r1`);

    // 4. mutating click on timeout rotates session (-r2) WITHOUT replaying click
    let clickCalls = 0;
    runSpy.mockImplementation(async (_i, cmd) => {
      if (cmd[0] === 'click') {
        clickCalls += 1;
        return { ok: false, text: 'ETIMEDOUT daemon not responding' };
      }
      return { ok: true, text: 'ok' };
    });
    const clickFailed = await broker.command(input, 'click', ['@e5']);
    expect(clickFailed.ok).toBe(false);
    expect(clickCalls).toBe(1);
    expect(clickFailed.text).toContain('已自动重置会话');
    expect(broker.sessionId(input)).toBe(`${initialSessionId}-r2`);

    await broker.dispose();
    db.close();
  });
});
