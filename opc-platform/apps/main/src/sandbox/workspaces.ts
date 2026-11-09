import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { buildSeatbeltProfile, type SandboxBackend, type SandboxPolicy } from './policy';

/** Conversation → workspace. The hook needs it to police tool paths. */
const workspaces = new Map<string, string>();
const attachments = new Map<string, ChatAttachmentRef[]>();
const attachmentMounts = new Map<string, { source: string; target: string }[]>();

export function registerSandboxWorkspace(conversationId: unknown, workspace: string): void {
  workspaces.set(String(conversationId), path.resolve(workspace));
}

export function workspaceOf(conversationId: unknown): string | undefined {
  return workspaces.get(String(conversationId));
}

export function registerSandboxAttachments(
  conversationId: unknown,
  values: readonly (string | Pick<ChatAttachmentRef, 'path' | 'name'>)[],
): void {
  const key = String(conversationId);
  const refs = values.map((value) => {
      const filePath = typeof value === 'string' ? value : value.path;
      return {
        id: `sandbox-${path.resolve(filePath)}`,
        name: typeof value === 'string' ? path.basename(filePath) : value.name,
        path: path.resolve(filePath),
        size: 0,
        source: 'file' as const,
      };
    });
  attachments.set(key, refs);
  attachmentMounts.set(key, refs.map((attachment, index) => ({
    source: attachment.path,
    target: `/opc-attachments/${String(index + 1).padStart(2, '0')}-${safeAttachmentName(attachment.name)}`,
  })));
}

export function attachmentsOf(conversationId: unknown): readonly string[] {
  return (attachments.get(String(conversationId)) ?? []).map((attachment) => attachment.path);
}

/** Metadata used by host-side tools (for example OCR) to resolve attachment names. */
export function attachmentRefsOf(conversationId: unknown): readonly ChatAttachmentRef[] {
  return attachments.get(String(conversationId)) ?? [];
}

/** Linux bwrap cannot re-open a file below a parent mounted as /dev/null. */
export function attachmentMountsOf(conversationId: unknown): readonly { source: string; target: string }[] {
  return attachmentMounts.get(String(conversationId)) ?? [];
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
  mounts: readonly { source: string; target: string }[] = [],
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
    ];
    if (!policy.allowNetwork) args.push('--unshare-net');
    for (const root of policy.deniedReadRoots) args.push('--ro-bind-try', '/dev/null', root);
    // A task workspace is currently stored below the application-data root,
    // which is denied above. Mount it at an independent path so that the denied
    // parent cannot mask the workspace or prevent cwd resolution.
    args.push('--dir', '/workspace', '--bind', policy.workspace, '/workspace', '--chdir', '/workspace');
    if (mounts.length > 0) {
      args.push('--dir', '/opc-attachments');
      for (const mount of mounts) {
        const parent = path.posix.dirname(mount.target);
        if (parent !== '/opc-attachments') args.push('--dir', parent);
        args.push('--ro-bind-try', mount.source, mount.target);
      }
    }
    for (const root of policy.readOnlyRoots) {
      if (!root || root === policy.workspace) continue;
      args.push('--ro-bind-try', root, root);
    }
    // `quoteArg` performs the one shell-escaping pass needed for the command
    // argument. Applying `shQuote` before it would leave literal quote
    // characters in argv[5], making `/bin/sh -c "'echo hi'"` try to execute a
    // command literally named `echo hi` (exit 127) on every invocation.
    const mappedCommand = mounts.reduce((value, mount) => value.replaceAll(mount.source, mount.target), command);
    return [...args, '/bin/sh', '-c', mappedCommand].map(quoteArg).join(' ');
  }

  throw new Error('没有可用的沙箱后端');
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_/.,:=+-]+$/.test(value) ? value : shQuote(value);
}

function safeAttachmentName(name: string): string {
  return path.basename(name).replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
}
