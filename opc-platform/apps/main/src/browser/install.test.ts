import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { AGENT_BROWSER_VERSION, BrowserInstallService, normalizeBrowserSettings } from './install';

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('browser settings normalization', () => {
  it('preserves an explicitly empty approval policy', () => {
    expect(normalizeBrowserSettings({ requireApprovalFor: [] }).requireApprovalFor).toEqual([]);
  });

  it('uses default approvals only when the policy is absent', () => {
    expect(normalizeBrowserSettings({}).requireApprovalFor).toEqual([
      'external-submit',
      'download',
      'upload',
      'authentication',
      'destructive',
    ]);
  });

  it('向后兼容旧版配置并补齐真实浏览器默认字段（managed / headed / pinTab / human）', () => {
    const normalized = normalizeBrowserSettings({
      enabled: true,
      allowAllDomains: true,
    });
    expect(normalized).toMatchObject({
      enabled: true,
      mode: 'managed',
      attachMethod: 'auto-connect',
      cdpEndpoint: '9222',
      pinTab: true,
      headed: true,
      inputMode: 'human',
      allowAllDomains: true,
    });

    const attachNormalized = normalizeBrowserSettings({
      mode: 'attach',
      attachMethod: 'cdp',
      cdpEndpoint: 'http://127.0.0.1:9333',
      pinTab: false,
      headed: false,
      inputMode: 'instant',
      executablePath: '  C:\\Chrome\\chrome.exe  ',
    });
    expect(attachNormalized).toMatchObject({
      mode: 'attach',
      attachMethod: 'cdp',
      cdpEndpoint: 'http://127.0.0.1:9333',
      pinTab: false,
      headed: false,
      inputMode: 'instant',
      executablePath: 'C:\\Chrome\\chrome.exe',
    });
  });

  it('本机已检测到正版 Chrome/Edge 时，install() 自动跳过 180MB Chrome for Testing 下载', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-browser-install-'));
    cleanupDirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    try {
      const binDir = path.join(dir, 'browser', 'runtime', AGENT_BROWSER_VERSION, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const binFile = path.join(binDir, process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser');
      writeFileSync(binFile, 'echo ok');

      const service = new BrowserInstallService(db, dir);
      const downloadRuntime = vi.fn(async () => undefined);
      const status = await service.install(undefined, {
        hasSystemBrowser: () => true,
        downloadRuntime,
      });

      expect(downloadRuntime).not.toHaveBeenCalled();
      expect(status.installState).toBe('ready');
      expect(status.enabled).toBe(true);
      expect(status.mode).toBe('managed');
    } finally {
      db.close();
    }
  });
});
