import { describe, expect, it } from 'vitest';
import type { BundledRuntime, RuntimeSnapshot, ShellExecutionStatus } from '@opc/shared/domain';
import {
  binaryPathPlaceholder,
  summarizeInterpreter,
  summarizeOcrCard,
  summarizeShellCard,
} from './runtimeModel';

function makeSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    profiles: [
      {
        id: 'node-system',
        name: '系统 Node',
        kind: 'node',
        binary: '',
        binDirs: [],
        env: {},
        isCustom: false,
        createdAt: 1,
      },
      {
        id: 'node-custom',
        name: 'nvm v22',
        kind: 'node',
        binary: '/nvm/node',
        binDirs: ['/nvm'],
        env: {},
        isCustom: true,
        createdAt: 2,
      },
      {
        id: 'python-system',
        name: '系统 Python',
        kind: 'python',
        binary: '',
        binDirs: [],
        env: {},
        isCustom: false,
        createdAt: 1,
      },
    ],
    active: { node: null, python: null },
    statuses: [
      { profileId: 'node-system', available: false, detail: 'missing' },
      { profileId: 'node-custom', available: true, version: '22.14.0' },
      { profileId: 'python-system', available: true, version: '3.12.5' },
    ],
    ...overrides,
  };
}

describe('runtimeModel', () => {
  it('resolves auto-selected and manual interpreters accurately', () => {
    const autoNode = summarizeInterpreter(makeSnapshot(), 'node');
    expect(autoNode.mode).toBe('auto');
    expect(autoNode.profile?.id).toBe('node-custom');
    expect(autoNode.available).toBe(true);
    expect(autoNode.version).toBe('22.14.0');
    expect(autoNode.profileCount).toBe(2);
    expect(autoNode.availableCount).toBe(1);

    // Explicit broken profile should remain marked unavailable without fallback
    const manualBroken = summarizeInterpreter(
      makeSnapshot({ active: { node: 'node-system', python: null } }),
      'node',
    );
    expect(manualBroken.mode).toBe('manual');
    expect(manualBroken.profile?.id).toBe('node-system');
    expect(manualBroken.available).toBe(false);
    expect(manualBroken.version).toBeNull();
  });

  it('summarizes OCR states across loading, missing, broken, on, and off', () => {
    const okEngine: BundledRuntime = {
      id: 'paddleocr',
      name: 'PaddleOCR',
      engine: 'onnxruntime-web',
      version: 'v4',
      state: 'ok',
      broken: 0,
    };

    expect(summarizeOcrCard(null, null).state).toBe('loading');
    expect(summarizeOcrCard([], { enabled: true, detail: 'text' }).state).toBe('missing');
    expect(
      summarizeOcrCard([{ ...okEngine, state: 'incomplete', broken: 2 }], {
        enabled: true,
        detail: 'text',
      }),
    ).toMatchObject({ state: 'broken', tone: 'red' });
    expect(summarizeOcrCard([okEngine], { enabled: true, detail: 'lines' })).toMatchObject({
      state: 'on',
      tone: 'green',
      detail: 'lines',
    });
    expect(summarizeOcrCard([okEngine], { enabled: false, detail: 'text' })).toMatchObject({
      state: 'off',
      tone: 'gray',
    });
  });

  it('summarizes Shell execution modes across Windows, OS sandbox, and unguarded host', () => {
    const base: ShellExecutionStatus = {
      settings: { windowsMode: 'ask' },
      platform: 'win32',
      sandboxBackend: 'windows-guarded',
      sandboxDetail: 'guarded',
    };

    expect(summarizeShellCard(null).state).toBe('loading');
    expect(summarizeShellCard(base)).toMatchObject({
      state: 'windows',
      tone: 'green',
      windowsMode: 'ask',
    });
    expect(
      summarizeShellCard({ ...base, settings: { windowsMode: 'auto' } }),
    ).toMatchObject({ state: 'windows', tone: 'amber', windowsMode: 'auto' });
    expect(
      summarizeShellCard({ ...base, platform: 'darwin', sandboxBackend: 'seatbelt' }),
    ).toMatchObject({ state: 'sandbox', tone: 'green', backend: 'seatbelt' });
    expect(
      summarizeShellCard({ ...base, platform: 'linux', sandboxBackend: 'none' }),
    ).toMatchObject({ state: 'none', tone: 'amber', backend: 'none' });
  });

  it('returns OS-aware interpreter path placeholders', () => {
    expect(binaryPathPlaceholder('node', 'win32')).toContain('node.exe');
    expect(binaryPathPlaceholder('python', 'win32')).toContain('python.exe');
    expect(binaryPathPlaceholder('python', 'darwin')).toContain('.venv/bin/python');
  });
});
