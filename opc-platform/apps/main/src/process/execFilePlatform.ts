import { createRequire } from 'node:module';
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const crossSpawn = createRequire(import.meta.url)('cross-spawn') as typeof import('node:child_process').spawn;

export interface ExecFileOutput {
  stdout: string;
  stderr: string;
}

export type ExecFileTask = Promise<ExecFileOutput> & { child: ChildProcess };

export function usesWindowsCommandShim(file: string, platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
}

/** Runs native binaries directly and routes Windows command shims through cross-spawn's escaping. */
export function execFilePlatform(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): ExecFileTask {
  if (!usesWindowsCommandShim(file)) {
    return execFileAsync(file, [...args], options) as ExecFileTask;
  }

  const child = crossSpawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const promise = new Promise<ExecFileOutput>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const finishError = (error: Error & { code?: string | number; stdout?: string; stderr?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      error.stdout = Buffer.concat(stdout).toString();
      error.stderr = Buffer.concat(stderr).toString();
      reject(error);
    };
    const timer = options.timeout
      ? setTimeout(() => {
          const error = Object.assign(new Error(`Command timed out after ${options.timeout} ms`), { code: 'ETIMEDOUT' });
          finishError(error);
          child.kill(options.killSignal ?? 'SIGTERM');
        }, options.timeout)
      : undefined;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        const error = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        finishError(error);
        child.kill(options.killSignal ?? 'SIGTERM');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        const error = Object.assign(new Error('stderr maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        finishError(error);
        child.kill(options.killSignal ?? 'SIGTERM');
      }
    });
    child.once('error', (caught) => finishError(caught as Error & { code?: string | number }));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      if (code === 0) {
        settled = true;
        resolve(output);
        return;
      }
      const error = Object.assign(
        new Error(signal ? `Command terminated by signal ${signal}` : `Command exited with code ${code}`),
        { code: code ?? signal ?? 'UNKNOWN', ...output },
      );
      settled = true;
      reject(error);
    });
  });

  return Object.assign(promise, { child });
}
