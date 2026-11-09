import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, isInside, resolveToolPath, wrapCommand } from './policy';
import { sandboxedShellCommand } from './workspaces';

const workspace = path.resolve('/tmp/opc-workspace');
const policy = {
  workspace,
  deniedReadRoots: ['/Users/someone/.ssh'],
  readOnlyRoots: ['/Users/someone/.venv'],
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

  // POSIX-only: on Windows path.resolve() turns '/etc/passwd' into '<drive>:\etc\passwd',
  // which is still absolute — the invariant under test holds there, the literal does not.
  it.skipIf(process.platform === 'win32')(
    'keeps absolute paths absolute so they can be rejected',
    () => {
      expect(resolveToolPath(workspace, '/etc/passwd')).toBe('/etc/passwd');
    },
  );
});

describe('buildSeatbeltProfile', () => {
  it('denies writes outside the workspace and denies the network', () => {
    const profile = buildSeatbeltProfile(policy);

    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
    expect(profile).toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(profile).toContain('(deny network-outbound)');
    // Local bind must stay possible, otherwise a dev server cannot start.
    expect(profile).not.toContain('(deny network*)');
    expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.ssh"))');
    // A real task workspace can itself be nested below a denied application-data
    // root. The explicit read exception must be present so shell cwd resolution
    // does not fail before the command starts.
    expect(profile).toContain(`(allow file-read* (subpath "${workspace}"))`);
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
    const workspaceBind = argv.indexOf('--bind');
    expect(argv.slice(workspaceBind, workspaceBind + 3)).toEqual(['--bind', workspace, '/workspace']);
    expect(argv.slice(workspaceBind + 3, workspaceBind + 5)).toEqual(['--chdir', '/workspace']);
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('refuses to run without a backend', () => {
    expect(() => wrapCommand('none', policy, 'echo hi')).toThrow(/没有可用的沙箱后端/);
  });
});

describe('sandboxedShellCommand', () => {
  it('passes the shell command once, without leaving literal quote characters', () => {
    const command = sandboxedShellCommand('bwrap', policy, 'echo hi');

    expect(command).toContain("/bin/sh -c 'echo hi'");
    expect(command).not.toContain("-c ''\\''echo hi'\\'''");
  });

  it('mounts authorized read-only roots in the bwrap command', () => {
    const command = sandboxedShellCommand('bwrap', policy, 'cat /Users/someone/photo.png');

    expect(command).toContain('--ro-bind-try /Users/someone/.venv /Users/someone/.venv');
  });

  it('maps an authorized attachment out from a denied parent on bwrap', () => {
    const command = sandboxedShellCommand(
      'bwrap',
      policy,
      'file /Users/someone/Library/Application Support/OPC/photo.png',
      [{ source: '/Users/someone/Library/Application Support/OPC/photo.png', target: '/opc-attachments/01-photo.png' }],
    );

    expect(command).toContain('--dir /opc-attachments');
    expect(command).toContain('--ro-bind-try \'/Users/someone/Library/Application Support/OPC/photo.png\' /opc-attachments/01-photo.png');
    expect(command).toContain('file /opc-attachments/01-photo.png');
  });
});
