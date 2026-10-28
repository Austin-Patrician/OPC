import { execFile } from 'node:child_process';
import path from 'node:path';
import type { NetworkClient } from '../network/networkClient';
import { resolveExecutable } from '../runtime/detect';

export interface CommandResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 20_000;

/**
 * Runs an argv array with `shell: false` — never a shell string, so no quoting
 * bugs and no accidental `&& rm -rf`.
 *
 * Without a runtime, `node` is mapped to the Electron binary in
 * `ELECTRON_RUN_AS_NODE` mode, so the app can execute JavaScript with its bundled
 * runtime instead of requiring a system Node on Windows/Linux. With a runtime
 * (`RuntimeService.envFor`), the child gets that environment's PATH and `node`
 * means the interpreter the company actually selected.
 */
export function runCommand(
  argv: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /** When present, the child inherits this process's proxy policy, not the ambient env. */
    network?: NetworkClient;
    /** PATH/变量 from the company base environment; disables the Electron `node` shortcut. */
    runtime?: { env: NodeJS.ProcessEnv };
  },
): Promise<CommandResult> {
  const [head, ...rest] = argv;
  if (!head) return Promise.reject(new Error('空命令'));

  // `childEnv()` is the single source of truth for spawned-process proxy
  // variables: `direct` clears inherited ones, manual/system overlay them.
  const baseEnv = options.runtime
    ? options.runtime.env
    : options.network
      ? options.network.childEnv()
      : process.env;
  const env = { ...baseEnv, ...options.env };

  const electronNode = head === 'node' && !options.runtime;
  const file = electronNode
    ? process.execPath
    : options.runtime
      ? resolveExecutable(head, env)
      : head;

  const startedAt = performance.now();

  return new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      rest,
      {
        cwd: path.resolve(options.cwd),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
        shell: false,
        maxBuffer: MAX_OUTPUT * 4,
        windowsHide: true,
        env: electronNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
      },
      (error, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - startedAt);
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? null
              : 0;

        resolve({
          command: [...argv],
          exitCode,
          stdout: tail(stdout),
          stderr: tail(stderr),
          durationMs,
          timedOut: Boolean(error && (error as { killed?: boolean }).killed),
        });
      },
    );
  });
}

function tail(value: string): string {
  return value.length > 4000 ? `…${value.slice(-4000)}` : value;
}
