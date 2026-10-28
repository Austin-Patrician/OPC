import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from './exec';

/**
 * With a runtime, `node` must mean the interpreter the company selected — not
 * Electron's bundled one, which is only the no-runtime fallback.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-exec-'));
  const fake = path.join(dir, 'node');
  writeFileSync(fake, '#!/bin/sh\necho "runtime:$OPC_RUNTIME_MARKER"\n', 'utf8');
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runCommand', () => {
  it('resolves node through the runtime PATH and passes its variables', async () => {
    const result = await runCommand(['node', 'ignored.js'], {
      cwd: dir,
      runtime: { env: { PATH: dir, OPC_RUNTIME_MARKER: 'selected' } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('runtime:selected');
  });

  it('lets explicit env override runtime variables', async () => {
    const result = await runCommand(['node', 'ignored.js'], {
      cwd: dir,
      runtime: { env: { PATH: dir, OPC_RUNTIME_MARKER: 'runtime' } },
      env: { OPC_RUNTIME_MARKER: 'explicit' },
    });
    expect(result.stdout.trim()).toBe('runtime:explicit');
  });

  it('rejects an empty argv without spawning', async () => {
    await expect(runCommand([], { cwd: dir })).rejects.toThrow('空命令');
  });
});
