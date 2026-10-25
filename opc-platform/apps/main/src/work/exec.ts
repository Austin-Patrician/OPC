import { execFile } from 'node:child_process';
import path from 'node:path';

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
 * `node` is mapped to the Electron binary in `ELECTRON_RUN_AS_NODE` mode, so the
 * app can execute JavaScript with its bundled runtime instead of requiring a
 * system Node on Windows/Linux.
 */
export function runCommand(
  argv: readonly string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const [head, ...rest] = argv;
  if (!head) return Promise.reject(new Error('空命令'));

  const resolved =
    head === 'node'
      ? {
          file: process.execPath,
          args: rest,
          env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' },
        }
      : {
          file: head,
          args: rest,
          env: { ...process.env, ...options.env },
        };

  const startedAt = performance.now();

  return new Promise<CommandResult>((resolve) => {
    execFile(
      resolved.file,
      resolved.args,
      {
        cwd: path.resolve(options.cwd),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
        shell: false,
        maxBuffer: MAX_OUTPUT * 4,
        windowsHide: true,
        env: resolved.env,
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
