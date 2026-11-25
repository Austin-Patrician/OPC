import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SandboxBackend, SandboxPolicy } from './policy';
import { wrapCommand } from './policy';

export interface SandboxStatus {
  backend: SandboxBackend;
  detail: string;
  supported: boolean;
}

const CANDIDATES = ['/usr/bin/sandbox-exec', '/bin/sandbox-exec'];

/**
 * macOS uses `sandbox-exec`, Linux uses `bwrap`, and Windows runs with
 * application-layer workspace/path guardrails (`windows-guarded`) so Python,
 * Node, and document skills execute reliably without hard-blocking the host.
 */
export function detectBackend(): SandboxStatus {
  if (process.platform === 'win32') {
    return {
      backend: 'windows-guarded',
      detail: 'Windows 本机工作区执行（无内核沙箱，按设置策略审批或放行）',
      supported: true,
    };
  }

  if (process.platform === 'darwin') {
    const found = CANDIDATES.find((candidate) => fs.existsSync(candidate));
    return found
      ? { backend: 'seatbelt', detail: `sandbox-exec · ${found}`, supported: true }
      : { backend: 'none', detail: '未找到 sandbox-exec', supported: false };
  }

  if (process.platform === 'linux') {
    const found = ['/usr/bin/bwrap', '/bin/bwrap'].some((candidate) => fs.existsSync(candidate));
    return found
      ? { backend: 'bwrap', detail: 'bubblewrap（bwrap）', supported: true }
      : { backend: 'none', detail: '未安装 bubblewrap（bwrap）', supported: false };
  }

  return { backend: 'none', detail: `不支持的系统：${process.platform}`, supported: false };
}

export function defaultDeniedRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.pi'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.config'),
  ];
  if (process.platform === 'darwin') {
    roots.push(
      path.join(home, 'Library', 'Keychains'),
      path.join(home, 'Library', 'Application Support', 'OPC Agent 工作台'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const opcRoot = path.join(appData, 'OPC Agent 工作台');
    // Protect database, credentials, and OAuth state while leaving managed
    // skills, Python venvs, and task workspaces readable as authorized roots.
    roots.push(
      path.join(opcRoot, 'opc.sqlite'),
      path.join(opcRoot, 'opc.sqlite-wal'),
      path.join(opcRoot, 'opc.sqlite-shm'),
      path.join(opcRoot, 'secrets.json'),
      path.join(opcRoot, 'mcp-oauth'),
    );
  }
  return roots;
}

export function buildPolicy(
  workspace: string,
  allowNetwork = false,
  readOnlyRoots: readonly string[] = [],
): SandboxPolicy {
  return {
    workspace,
    deniedReadRoots: defaultDeniedRoots(),
    readOnlyRoots: [...readOnlyRoots],
    allowNetwork,
  };
}

export interface SandboxSelfTest {
  ok: boolean;
  detail: string;
}

/**
 * Proves the sandbox actually enforces: a write outside the workspace must fail
 * and a write inside must succeed. Runs the real backend, not a simulation.
 */
export async function selfTest(workspace: string): Promise<SandboxSelfTest> {
  const status = detectBackend();
  if (status.backend === 'none') return { ok: false, detail: status.detail };

  fs.mkdirSync(workspace, { recursive: true });
  const policy = buildPolicy(workspace);
  // Must be outside every allowed root: `/tmp` is deliberately writable for Node
  // scratch files, so the escape target is the home directory instead.
  const outside = path.join(os.homedir(), `opc-sandbox-escape-${Date.now()}.txt`);
  const inside = path.join(workspace, 'sandbox-ok.txt');

  const run = (command: string) =>
    new Promise<number>((resolve) => {
      const [file, ...args] = wrapCommand(status.backend, policy, command);
      execFile(file ?? '', args, { timeout: 10_000 }, (error) => {
        resolve(error ? Number((error as { code?: number }).code ?? 1) : 0);
      });
    });

  const escapeExit = await run(`printf x > '${outside}'`);
  const insideExit = await run(`printf ok > '${inside}'`);

  const escaped = fs.existsSync(outside);
  if (escaped) fs.rmSync(outside, { force: true });

  const ok = escapeExit !== 0 && !escaped && insideExit === 0;
  return {
    ok,
    detail: `backend=${status.backend} · 越界写入 exit=${escapeExit}${escaped ? '（写入成功！）' : '（已阻止）'} · 工作区写入 exit=${insideExit}`,
  };
}
