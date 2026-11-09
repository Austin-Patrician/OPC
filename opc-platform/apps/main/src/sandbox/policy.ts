import path from 'node:path';

export type SandboxBackend = 'seatbelt' | 'bwrap' | 'none';

export interface SandboxPolicy {
  /** Absolute path of the task workspace: the only writable root. */
  workspace: string;
  /** Absolute paths the process may not read (secrets). */
  deniedReadRoots: string[];
  /**
   * Interpreter prefixes the sandbox must expose read-only (venv, nvm, Homebrew).
   * Linux `bwrap` starts with an empty mount namespace, so without these a runtime
   * selected in Settings would not exist inside the sandbox.
   */
  readOnlyRoots: string[];
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
    // Shells commonly use `2>/dev/null` for optional probes. Without this
    // single-device exception, the redirection itself fails with EPERM and
    // turns otherwise harmless commands into tool errors.
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${quotes(policy.workspace)}))`,
    // Node and its tooling need a scratch dir for sockets and temp files.
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
  ];

  for (const root of policy.deniedReadRoots) {
    lines.push(`(deny file-read* (subpath ${quotes(root)}))`);
  }
  for (const root of policy.readOnlyRoots) {
    // Runtime profiles are directories (and attachment refs may be files). A
    // literal directory rule only permits opening the directory itself; every
    // actual executable or library below it is still denied by the default
    // profile. Re-open the complete authorized subtree instead.
    lines.push(`(allow file-read* (subpath ${quotes(root)}))`);
  }

  // Workspaces live below the application-data directory, which is one of the
  // default denied roots.  Re-open the task workspace after the deny rules so
  // the sandboxed process can resolve its cwd and read files it is allowed to
  // work on.  Without this, every shell starts with `getcwd: Operation not
  // permitted`, even though the workspace itself is writable.
  lines.push(`(allow file-read* (subpath ${quotes(policy.workspace)}))`);

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
  ];

  if (!policy.allowNetwork) args.push('--unshare-net');
  for (const root of policy.deniedReadRoots) args.push('--ro-bind-try', '/dev/null', root);
  // The workspace may be nested below a denied application-data root. Mount it
  // at an independent path inside the sandbox so the denied parent cannot mask
  // it, and so its descendants stay the only writable task files.
  args.push('--dir', '/workspace', '--bind', policy.workspace, '/workspace', '--chdir', '/workspace');
  for (const root of policy.readOnlyRoots) {
    if (!root || root === policy.workspace) continue;
    args.push('--ro-bind-try', root, root);
  }

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
