import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSeatbeltProfile, type SandboxBackend, type SandboxPolicy } from './policy';

/** Conversation → workspace. The hook needs it to police tool paths. */
const workspaces = new Map<string, string>();

export function registerSandboxWorkspace(conversationId: unknown, workspace: string): void {
  workspaces.set(String(conversationId), path.resolve(workspace));
}

export function workspaceOf(conversationId: unknown): string | undefined {
  return workspaces.get(String(conversationId));
}

/** Single-quote for /bin/sh, the only escaping the wrapper needs. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Profile file per workspace, so the command line stays one line and does not have
 * to carry newlines. Rewritten on every use: the policy may change with the workspace.
 */
export function writeSeatbeltProfile(policy: SandboxPolicy): string {
  const target = path.join(os.tmpdir(), `opc-sandbox-${hash(policy.workspace)}.sb`);
  fs.writeFileSync(target, buildSeatbeltProfile(policy), 'utf8');
  return target;
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(36);
}

/**
 * A single shell string that the `bash` tool can run. The tool executes through
 * `ExecutionEnv`, so wrapping the *command* is what moves it into the sandbox.
 */
export function sandboxedShellCommand(
  backend: SandboxBackend,
  policy: SandboxPolicy,
  command: string,
): string {
  if (backend === 'seatbelt') {
    const profile = writeSeatbeltProfile(policy);
    return `sandbox-exec -f ${shQuote(profile)} /bin/sh -c ${shQuote(command)}`;
  }

  if (backend === 'bwrap') {
    const args = [
      'bwrap',
      '--die-with-parent',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--new-session',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind-try',
      '/lib',
      '/lib',
      '--ro-bind-try',
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
    return [...args, '/bin/sh', '-c', shQuote(command)].map(quoteArg).join(' ');
  }

  throw new Error('没有可用的沙箱后端');
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_/.,:=+-]+$/.test(value) ? value : shQuote(value);
}
