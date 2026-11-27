import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import type { WindowsShellMode } from '@opc/shared/domain';
import { buildPolicy, defaultDeniedRoots, detectBackend, type SandboxStatus } from './detect';
import { isInside, resolveRealPathOrAncestor, resolveToolPath } from './policy';
import { sandboxedShellCommand, workspaceOf } from './workspaces';

const WRITE_PATH_TOOLS = new Set(['write', 'edit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

export interface SandboxExtensionOptions {
  enforce?: boolean;
  /** Isolates `conversationId` workspace lookups per worker/runtime SQLite file. */
  scopeKey?: string;
  readOnlyRoots?: () => readonly string[];
  /** Windows shell execution policy; defaults to `'ask'` when omitted. */
  windowsShellMode?: () => WindowsShellMode;
  /**
   * Authorizes a shell command when `windowsShellMode()` is `'ask'`.
   * Return `true` to allow (permit present or consumed); return `false` when
   * an approval card has been queued and the call should be blocked.
   */
  authorizeShell?: (input: {
    conversationId: unknown;
    tool: 'bash';
    command: string;
    cwd: string;
  }) => boolean;
  /** Optional backend override for deterministic unit testing across platforms. */
  backend?: SandboxStatus;
}

function isReadablePath(
  target: string,
  workspace: string,
  readOnlyRoots: readonly string[],
): boolean {
  const resolved = resolveToolPath(workspace, target);
  const resolvedReal = resolveRealPathOrAncestor(resolved);
  const workspaceReal = resolveRealPathOrAncestor(workspace);

  if (isInside(workspace, resolved) && isInside(workspaceReal, resolvedReal)) {
    return true;
  }

  const denied = defaultDeniedRoots();
  const inDenied = (candidate: string) => denied.some((root) => isInside(root, candidate));
  if (inDenied(resolved) || inDenied(resolvedReal)) {
    return false;
  }

  return readOnlyRoots.some((root) => {
    if (!root) return false;
    const rootReal = resolveRealPathOrAncestor(root);
    return isInside(root, resolved) && isInside(rootReal, resolvedReal);
  });
}

/**
 * The sandbox as a pi extension.
 *
 * pi's extension API gives exactly one place where every tool call passes through
 * (`beforeTool`), which is where a security policy belongs:
 *   - `write` / `edit` may not leave the conversation's workspace;
 *   - `read` allows the workspace (including `inputs/` copies) and non-denied `readOnlyRoots`;
 *   - `bash` / `powershell` run under `sandbox-exec` (macOS), `bwrap` (Linux), or
 *     user-configured approval/auto/disabled policy on Windows (`windows-guarded`).
 */
export function createSandboxExtension(options: SandboxExtensionOptions = {}) {
  const status = options.backend ?? detectBackend();
  const enforce = options.enforce ?? process.env.OPC_SANDBOX !== 'off';

  return defineExtension({
    name: 'opc.sandbox',
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          if (!enforce) return undefined;

          const workspace = workspaceOf(api.conversationId, options.scopeKey);
          if (!workspace) {
            return { block: '沙箱未就绪：该会话没有登记工作区，拒绝执行工具' };
          }

          const args = (call.arguments ?? {}) as Record<string, unknown>;

          if (WRITE_PATH_TOOLS.has(call.name)) {
            const target = typeof args.path === 'string' ? args.path : '';
            if (!target) return { block: '拒绝：缺少 path 参数' };
            const resolved = resolveToolPath(workspace, target);
            const resolvedReal = resolveRealPathOrAncestor(resolved);
            const workspaceReal = resolveRealPathOrAncestor(workspace);
            if (!isInside(workspace, resolved) || !isInside(workspaceReal, resolvedReal)) {
              return { block: `拒绝越界访问：${target}` };
            }
            return undefined;
          }

          if (call.name === 'read') {
            const target = typeof args.path === 'string' ? args.path : '';
            if (!target) return { block: '拒绝：缺少 path 参数' };
            const readOnlyRoots = options.readOnlyRoots?.() ?? [];
            if (!isReadablePath(target, workspace, readOnlyRoots)) {
              return { block: `拒绝越界访问：${target}` };
            }
            return undefined;
          }

          if (SHELL_TOOLS.has(call.name)) {
            if (status.backend === 'none') {
              return { block: `沙箱不可用：${status.detail}` };
            }
            const command = typeof args.command === 'string' ? args.command : '';
            if (!command) return { block: '拒绝：缺少 command 参数' };

            if (status.backend === 'windows-guarded') {
              const mode = options.windowsShellMode?.() ?? 'ask';
              if (mode === 'disabled') {
                return { block: '终端命令执行已在「设置 → 运行时」中禁用。' };
              }
              if (
                mode === 'ask' &&
                options.authorizeShell &&
                !options.authorizeShell({
                  conversationId: api.conversationId,
                  tool: 'bash',
                  command,
                  cwd: workspace,
                })
              ) {
                return {
                  block:
                    '当前模式为「按任务审批」，已向用户弹出执行确认卡片：请暂停等待用户批准，不要换路绕过或重复请求同一命令。',
                };
              }
              return undefined;
            }

            if (call.name === 'powershell') {
              return { block: '当前系统不支持 powershell 工具，请使用 bash' };
            }

            const readOnlyRoots = options.readOnlyRoots?.() ?? [];
            return {
              arguments: {
                ...args,
                command: sandboxedShellCommand(
                  status.backend,
                  buildPolicy(workspace, false, readOnlyRoots),
                  command,
                ),
              },
            };
          }

          return undefined;
        },
      }),
    ],
  });
}
