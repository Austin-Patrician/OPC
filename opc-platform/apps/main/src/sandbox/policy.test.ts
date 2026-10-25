import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, isInside, resolveToolPath, wrapCommand } from './policy';

const workspace = path.resolve('/tmp/opc-workspace');
const policy = {
  workspace,
  deniedReadRoots: ['/Users/someone/.ssh'],
  allowNetwork: false,
};

describe('isInside', () => {
  it('accepts the workspace and its descendants', () => {
    expect(isInside(workspace, path.join(workspace, 'server.js'))).toBe(true);
    expect(isInside(workspace, path.join(workspace, 'src/deep/file.ts'))).toBe(true);
    expect(isInside(workspace, workspace)).toBe(true);
  });

  it('rejects siblings, parents and traversal', () => {
    expect(isInside(workspace, '/tmp/other/file')).toBe(false);
    expect(isInside(workspace, `${workspace}-evil/file`)).toBe(false);
    expect(isInside(workspace, path.join(workspace, '..', 'escape.txt'))).toBe(false);
  });
});

describe('resolveToolPath', () => {
  it('resolves relative paths against the workspace', () => {
    expect(resolveToolPath(workspace, 'server.js')).toBe(path.join(workspace, 'server.js'));
  });

  it('keeps absolute paths absolute so they can be rejected', () => {
    expect(resolveToolPath(workspace, '/etc/passwd')).toBe('/etc/passwd');
  });
});

describe('buildSeatbeltProfile', () => {
  it('denies writes outside the workspace and denies the network', () => {
    const profile = buildSeatbeltProfile(policy);

    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(profile).toContain('(deny network-outbound)');
    // Local bind must stay possible, otherwise a dev server cannot start.
    expect(profile).not.toContain('(deny network*)');
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.ssh"))');
  });

  it('can allow the network when policy says so', () => {
    expect(buildSeatbeltProfile({ ...policy, allowNetwork: true })).not.toContain(
      '(deny network-outbound)',
    );
  });
});

describe('wrapCommand', () => {
  it('wraps in sandbox-exec on macOS', () => {
    const argv = wrapCommand('seatbelt', policy, 'echo hi');
    expect(argv.slice(0, 2)).toEqual(['sandbox-exec', '-p']);
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('wraps in bubblewrap on Linux with the workspace bound', () => {
    const argv = wrapCommand('bwrap', policy, 'echo hi');
    expect(argv[0]).toBe('bwrap');
    expect(argv).toContain('--unshare-net');
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('refuses to run without a backend', () => {
    expect(() => wrapCommand('none', policy, 'echo hi')).toThrow(/没有可用的沙箱后端/);
  });
});
