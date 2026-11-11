import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopChecksumFor, desktopReleaseAsset, DesktopInstallService, normalizeDesktopSettings } from './install';

describe('agent-desktop release selection', () => {
  it.each([
    ['darwin', 'arm64', 'agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz'],
    ['darwin', 'x64', 'agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz'],
    ['win32', 'arm64', 'agent-desktop-v1.2.0-aarch64-pc-windows-msvc.tar.gz'],
    ['win32', 'x64', 'agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz'],
    ['linux', 'arm64', 'agent-desktop-v1.2.0-aarch64-unknown-linux-gnu.tar.gz'],
    ['linux', 'x64', 'agent-desktop-v1.2.0-x86_64-unknown-linux-gnu.tar.gz'],
  ])('maps %s/%s to the pinned official asset', (platform, architecture, asset) => {
    expect(desktopReleaseAsset(platform!, architecture!)).toBe(asset);
  });

  it('rejects unsupported platforms and architectures instead of guessing an asset', () => {
    expect(() => desktopReleaseAsset('freebsd', 'x64')).toThrow('不支持当前操作系统');
    expect(() => desktopReleaseAsset('linux', 'ia32')).toThrow('不支持当前 CPU 架构');
  });

  it('accepts only an exact asset filename with a SHA-256 checksum', () => {
    const hash = 'a'.repeat(64);
    const checksums = `${hash}  agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz\n`;
    expect(desktopChecksumFor(checksums, 'agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz')).toBe(hash);
    expect(desktopChecksumFor(checksums, 'agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz')).toBeUndefined();
    expect(desktopChecksumFor(`not-a-checksum  agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz`, 'agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz')).toBeUndefined();
  });
});

describe('desktop settings migration', () => {
  it('drops legacy app allowlists and approval rules while preserving the master switch', () => {
    expect(normalizeDesktopSettings({
      enabled: true,
      allowedApps: [{ id: 'Chrome', enabled: false }],
      requireApprovalFor: ['external-submit'],
      maxOutputBytes: 12,
    })).toEqual({ enabled: true });
    expect(normalizeDesktopSettings(undefined)).toEqual({ enabled: false });
  });
});

describe('global desktop settings migration', () => {
  it('migrates the account default once and uses it for every worker identity', () => {
    const db = new Database(':memory:');
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'opc-desktop-settings-'));
    db.exec('CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)');
    insert.run('desktop.settings.user', JSON.stringify({
      enabled: true,
      allowedApps: [{ id: 'com.google.Chrome', label: 'Google Chrome', platform: process.platform, enabled: true, source: 'user' }],
      approvalPolicyVersion: 1,
    }), Date.now());
    insert.run('desktop.settings.person-1', JSON.stringify({ enabled: true, allowedApps: [], approvalPolicyVersion: 1 }), Date.now());

    try {
      const service = new DesktopInstallService(db, userDataDir);
      expect(service.settings()).toEqual({ enabled: true });
      expect((db.prepare('SELECT value FROM app_setting WHERE key = ?').get('desktop.settings') as { value: string }).value)
        .toBe('{"enabled":true}');
      expect(db.prepare('SELECT value FROM app_setting WHERE key = ?').get('desktop.settings.user')).toBeUndefined();
      expect(db.prepare('SELECT value FROM app_setting WHERE key = ?').get('desktop.settings.person-1')).toBeUndefined();
      service.setSettings({ enabled: false });
      expect(service.settings()).toEqual({ enabled: false });
    } finally {
      db.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
