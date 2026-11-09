import { describe, expect, it } from 'vitest';
import { desktopChecksumFor, desktopReleaseAsset } from './install';

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
