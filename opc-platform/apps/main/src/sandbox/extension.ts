import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { buildPolicy, detectBackend } from './detect';
import { isInside, resolveToolPath } from './policy';
import { sandboxedShellCommand, workspaceOf } from './workspaces';

const PATH_TOOLS = new Set(['read', 'write', 'edit']);

/**
 * The sandbox as a pi extension.
 *
 * pi's extension API gives exactly one place where every tool call passes through
 * (`beforeTool`), which is where a security policy belongs:
 *   - `read` / `write` / `edit` may not leave the conversation's workspace;
 *   - `bash` is rewritten to run under `sandbox-exec` (macOS) or `bwrap` (Linux);
 *   - if no backend is available, commands are blocked instead of running bare.
 *
 * Windows is intentionally unsupported: `detectBackend()` reports `none` and the
 * hook fails closed.
 */
export function createSandboxExtension(
  options: { enforce?: boolean; readOnlyRoots?: () => readonly string[] } = {},
) {
  const status = detectBackend();
  const enforce = options.enforce ?? process.env.OPC_SANDBOX !== 'off';

  return defineExtension({
    name: 'opc.sandbox',
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          if (!enforce) return undefined;

          const workspace = workspaceOf(api.conversationId);
          if (!workspace) {
            return { block: '沙箱未就绪：该会话没有登记工作区，拒绝执行工具' };
          }

          const args = (call.arguments ?? {}) as Record<string, unknown>;

          if (PATH_TOOLS.has(call.name)) {
            const target = typeof args.path === 'string' ? args.path : '';
            if (!target) return { block: '拒绝：缺少 path 参数' };
            if (!isInside(workspace, resolveToolPath(workspace, target))) {
              return { block: `拒绝越界访问：${target}` };
            }
            return undefined;
          }

          if (call.name === 'bash') {
            if (status.backend === 'none') {
              return { block: `沙箱不可用：${status.detail}` };
            }
            const command = typeof args.command === 'string' ? args.command : '';
            if (!command) return { block: '拒绝：缺少 command 参数' };

            return {
              arguments: {
                ...args,
                command: sandboxedShellCommand(status.backend, buildPolicy(workspace, false, options.readOnlyRoots?.() ?? []), command),
              },
            };
          }

          return undefined;
        },
      }),
    ],
  });
}
