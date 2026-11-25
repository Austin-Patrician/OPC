import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type {
  ExecutionError,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from '@earendil-works/pi-durable/env';
import type { Context } from '@earendil-works/chord';

const UTF8_OUTPUT = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const;
const POWERSHELL_CANDIDATES = ['pwsh', 'powershell'] as const;

/**
 * NodeExecutionEnv with a Windows PowerShell fallback when Git Bash / `bash.exe`
 * is not installed on the user's machine (`shell_unavailable`).
 */
export class OpcExecutionEnv extends NodeExecutionEnv {
  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const primary = await super.exec(command, options, context);
    if (
      process.platform !== 'win32' ||
      primary.ok ||
      primary.error.code !== 'shell_unavailable' ||
      typeof command !== 'string'
    ) {
      return primary;
    }

    const script = `${UTF8_OUTPUT}\n${command}`;
    let fallbackResult: Result<ShellExecResult, ExecutionError> = primary;
    for (const program of POWERSHELL_CANDIDATES) {
      fallbackResult = await super.exec([program, ...POWERSHELL_ARGS, script], options, context);
      if (fallbackResult.ok || fallbackResult.error.code !== 'spawn_error') {
        return fallbackResult;
      }
    }
    return fallbackResult;
  }
}
