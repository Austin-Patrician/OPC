import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { buildSeatbeltProfile, type SandboxBackend, type SandboxPolicy } from './policy';

/** Conversation -> workspace. The hook needs it to police tool paths. */
const workspaces = new Map<string, string>();
const attachments = new Map<string, ChatAttachmentRef[]>();

function scopedConvKey(conversationId: unknown, scopeKey?: string): string {
  return scopeKey ? `${scopeKey}:${String(conversationId)}` : String(conversationId);
}

export function registerSandboxWorkspace(
  conversationId: unknown,
  workspace: string,
  scopeKey?: string,
): void {
  workspaces.set(scopedConvKey(conversationId, scopeKey), path.resolve(workspace));
}

export function workspaceOf(conversationId: unknown, scopeKey?: string): string | undefined {
  return workspaces.get(scopedConvKey(conversationId, scopeKey));
}

export function registerSandboxAttachments(
  conversationId: unknown,
  values: readonly (string | Pick<ChatAttachmentRef, 'path' | 'name'>)[],
  scopeKey?: string,
): void {
  const key = scopedConvKey(conversationId, scopeKey);
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
}

export function attachmentsOf(conversationId: unknown, scopeKey?: string): readonly string[] {
  return (attachments.get(scopedConvKey(conversationId, scopeKey)) ?? []).map(
    (attachment) => attachment.path,
  );
}

/** Metadata used by host-side tools (for example OCR) to resolve staged attachment names. */
export function attachmentRefsOf(
  conversationId: unknown,
  scopeKey?: string,
): readonly ChatAttachmentRef[] {
  return attachments.get(scopedConvKey(conversationId, scopeKey)) ?? [];
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
    ];
    if (!policy.allowNetwork) args.push('--unshare-net');
    for (const root of policy.deniedReadRoots) args.push('--ro-bind-try', '/dev/null', root);
    // A task workspace is currently stored below the application-data root,
    // which is denied above. Mount it at an independent path so that the denied
    // parent cannot mask the workspace or prevent cwd resolution.
    args.push('--dir', '/workspace', '--bind', policy.workspace, '/workspace', '--chdir', '/workspace');
    for (const root of policy.readOnlyRoots) {
      if (!root || root === policy.workspace) continue;
      args.push('--ro-bind-try', root, root);
    }
    return [...args, '/bin/sh', '-c', command].map(quoteArg).join(' ');
  }

  throw new Error('没有可用的沙箱后端');
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_/.,:=+-]+$/.test(value) ? value : shQuote(value);
}
