import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFilePlatform, usesWindowsCommandShim } from './execFilePlatform';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('platform executable selection', () => {
  it.each([
    ['win32', 'agent-browser.cmd', true],
    ['win32', 'agent-desktop.BAT', true],
    ['win32', 'agent-desktop.exe', false],
    ['darwin', 'agent-browser.cmd', false],
    ['linux', 'agent-browser.cmd', false],
    ['darwin', 'agent-browser', false],
    ['linux', 'agent-browser', false],
  ] as const)('selects the command-shim path for %s / %s', (platform, file, expected) => {
    expect(usesWindowsCommandShim(file, platform)).toBe(expected);
  });
});

describe('execFilePlatform', () => {
  it('runs native executables and preserves piped stdin', async () => {
    const child = execFilePlatform(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      timeout: 5_000,
      maxBuffer: 1024,
      windowsHide: true,
    });
    child.child.stdin?.end('input with spaces');
    await expect(child).resolves.toMatchObject({ stdout: 'input with spaces', stderr: '' });
  });

  it.skipIf(process.platform !== 'win32')('runs a .cmd shim with arguments safely preserved', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opc runtime with spaces '));
    tempDirs.push(directory);
    const shimDirectory = path.join(directory, 'node_modules', '.bin');
    await fs.mkdir(shimDirectory, { recursive: true });
    const shim = path.join(shimDirectory, 'echo-args.cmd');
    await fs.writeFile(
      shim,
      `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
    );

    const result = await execFilePlatform(shim, ['value with spaces', 'value&with&metacharacters'], {
      timeout: 5_000,
      maxBuffer: 1024,
      windowsHide: true,
    });

    expect(JSON.parse(result.stdout)).toEqual(['value with spaces', 'value&with&metacharacters']);
  });
});
