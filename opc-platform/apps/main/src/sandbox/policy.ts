import path from 'node:path';

export type SandboxBackend = 'seatbelt' | 'bwrap' | 'none';

export interface SandboxPolicy {
  /** Absolute path of the task workspace: the only writable root. */
  workspace: string;
  /** Absolute paths the process may not read (secrets). */
  deniedReadRoots: string[];
  allowNetwork: boolean;
}

/**
 * Pure policy → OS arguments. Kept side-effect free so the security rules can be
 * reviewed and unit-tested without spawning anything.
 *
 * macOS: `sandbox-exec` (deprecated by Apple but still enforced on 15.x).
 * Linux: bubblewrap (`bwrap`), unprivileged namespaces.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const quotes = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quotes(policy.workspace)}))`,
    // Node and its tooling need a scratch dir for sockets and temp files.
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
  ];

  for (const root of policy.deniedReadRoots) {
    lines.push(`(deny file-read* (subpath ${quotes(root)}))`);
  }

  if (!policy.allowNetwork) {
    // Block egress (exfiltration) but keep local bind/inbound: an employee must be
    // able to start a dev server and talk to it on 127.0.0.1.
    lines.push('(deny network-outbound)');
  }

  return lines.join('\n');
}

export function buildSeatbeltArgv(policy: SandboxPolicy, shellCommand: string): string[] {
  return ['sandbox-exec', '-p', buildSeatbeltProfile(policy), '/bin/sh', '-c', shellCommand];
}

export function buildBwrapArgv(policy: SandboxPolicy, shellCommand: string): string[] {
  const args = [
    'bwrap',
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
    // Read-only system dirs; only the workspace is writable.
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    policy.workspace,
    policy.workspace,
    '--chdir',
    policy.workspace,
  ];

  if (!policy.allowNetwork) args.push('--unshare-net');
  for (const root of policy.deniedReadRoots) args.push('--ro-bind-try', '/dev/null', root);

  args.push('/bin/sh', '-c', shellCommand);
  return args;
}

/** Wraps a shell command in whatever the host can enforce. */
export function wrapCommand(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  shellCommand: string,
): string[] {
  switch (backend) {
    case 'seatbelt':
      return buildSeatbeltArgv(policy, shellCommand);
    case 'bwrap':
      return buildBwrapArgv(policy, shellCommand);
    default:
      throw new Error('没有可用的沙箱后端');
  }
}

/** Resolves `target` and reports whether it is inside `root`. */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/** Absolute path of a tool argument, resolving relative paths against the workspace. */
export function resolveToolPath(workspace: string, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
}
