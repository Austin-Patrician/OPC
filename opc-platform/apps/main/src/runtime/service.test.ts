import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import type { NetworkClient } from '../network/networkClient';
import { findExecutable, resolveExecutable, runtimeSearchDirs } from './detect';
import { RuntimeService } from './service';

/**
 * The base environment against a real SQLite file and a real (temporary) userData
 * directory: what matters is the child PATH, the shims and the stored selection.
 */
let dir: string;
let userDataDir: string;
let binDir: string;
let db: CompanyDatabase;

function makeExe(file: string): void {
  writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(file, 0o755);
}

/** Proxy-aware stub: `envFor` must keep these variables and only prepend PATH. */
const network = {
  childEnv: () => ({
    PATH: '/usr/bin:/bin',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NODE_OPTIONS: '--inspect',
    PYTHONHOME: '/stale',
    PYTHONPATH: '/stale',
    VIRTUAL_ENV: '/stale-venv',
    CONDA_PREFIX: '/stale-conda',
  }),
} as unknown as NetworkClient;

function createService(overrides: { probeVersion?: () => Promise<{ ok: boolean; version?: string; detail?: string }> } = {}) {
  return new RuntimeService(db, {
    userDataDir,
    searchDirs: [binDir],
    network,
    probeVersion: overrides.probeVersion ?? (async () => ({ ok: true, version: '9.9.9' })),
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-runtime-'));
  userDataDir = path.join(dir, 'userData');
  binDir = path.join(dir, 'bin');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  makeExe(path.join(binDir, 'node'));
  makeExe(path.join(binDir, 'python3'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RuntimeService catalogue', () => {
  it('exposes the built-ins with no active selection by default', () => {
    const service = createService();
    const state = service.getState();
    expect(state.profiles.map((profile) => profile.id)).toEqual([
      'node-system',
      'node-bundled',
      'python-system',
    ]);
    expect(state.active).toEqual({ node: null, python: null });
  });

  it('auto-picks the first usable built-in for each language', () => {
    const service = createService();
    const node = service.activeFor('node');
    const python = service.activeFor('python');
    expect(node?.binary).toBe(realpathSync(path.join(binDir, 'node')));
    expect(python?.binary).toBe(realpathSync(path.join(binDir, 'python3')));
  });

  it('reports availability and version without spawning the real binary', async () => {
    const service = createService();
    const snapshot = await service.snapshot();
    const status = snapshot.statuses.find((entry) => entry.profileId === 'node-system');
    expect(status?.available).toBe(true);
    expect(status?.version).toBe('9.9.9');
  });

  it('surfaces a failed probe as an unavailable status, not a throw', async () => {
    const service = createService({
      probeVersion: async () => ({ ok: false, detail: 'boom' }),
    });
    const snapshot = await service.snapshot();
    const status = snapshot.statuses.find((entry) => entry.profileId === 'python-system');
    expect(status?.available).toBe(false);
    expect(status?.detail).toBe('boom');
  });
});

describe('RuntimeService environment', () => {
  it('prepends shims and interpreter directories, keeping proxy variables', () => {
    const service = createService();
    const env = service.envFor();

    const dirs = (env.PATH ?? '').split(path.delimiter);
    expect(dirs[0]).toBe(path.join(userDataDir, 'runtimes', 'node-system', 'bin'));
    expect(dirs[1]).toBe(realpathSync(binDir));
    expect(dirs).toContain('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBeUndefined();
    expect(env.CONDA_PREFIX).toBeUndefined();
  });

  it('points the shim alias at the selected interpreter', () => {
    const service = createService();
    service.envFor(['node']);
    const shim = path.join(userDataDir, 'runtimes', 'node-system', 'bin', 'node');
    expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    // The alias resolves through PATH; the symlink target is the real interpreter.
    expect(realpathSync(resolveExecutable('node', service.envFor(['node'])))).toBe(
      realpathSync(path.join(binDir, 'node')),
    );
  });

  it('keeps Node and Python active at the same time', () => {
    const service = createService();
    const env = service.envFor();
    const dirs = (env.PATH ?? '').split(path.delimiter);
    expect(dirs).toContain(path.join(userDataDir, 'runtimes', 'node-system', 'bin'));
    expect(dirs).toContain(path.join(userDataDir, 'runtimes', 'python-system', 'bin'));
    // Python defaults are applied only when Python is included.
    expect(env.PYTHONUNBUFFERED).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });

  it('derives venv variables for a custom interpreter', () => {
    const venv = path.join(dir, 'project-venv');
    mkdirSync(path.join(venv, 'bin'), { recursive: true });
    makeExe(path.join(venv, 'bin', 'python'));
    writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n', 'utf8');

    const service = createService();
    service.saveProfile({ name: '项目 venv', kind: 'python', binary: path.join(venv, 'bin', 'python') });

    const env = service.envFor(['python']);
    expect(env.VIRTUAL_ENV).toBe(venv);
    expect(env.PIP_REQUIRE_VIRTUALENV).toBe('true');
    expect(env.PYTHONPATH).toBeUndefined();
  });

  it('keeps the venv path when the interpreter itself is a symlink', async () => {
    const venv = path.join(dir, 'linked-venv');
    mkdirSync(path.join(venv, 'bin'), { recursive: true });
    const python = path.join(venv, 'bin', 'python');
    symlinkSync(path.join(binDir, 'python3'), python);
    writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n', 'utf8');

    const service = createService();
    const inspection = await service.inspect({ kind: 'python', binary: python });
    expect(inspection.ok).toBe(true);
    expect(inspection.binary).toBe(python);
    expect(inspection.env.VIRTUAL_ENV).toBe(venv);

    service.saveProfile({ name: 'linked venv', kind: 'python', binary: inspection.binary });
    const profile = service.getState().profiles.find((entry) => entry.name === 'linked venv');
    expect(profile?.binDirs).toContain(path.join(venv, 'bin'));
    expect(service.envFor(['python']).VIRTUAL_ENV).toBe(venv);
  });

  it('uses the bundled Electron Node when no system Node is installed', () => {
    const service = createService();
    expect(service.acceptanceEnv()?.PATH).toBeTruthy();

    rmSync(path.join(binDir, 'node'));
    const withoutSystem = createService();
    const env = withoutSystem.acceptanceEnv();
    expect(env?.ELECTRON_RUN_AS_NODE).toBe('1');
    const dirs = (env?.PATH ?? '').split(path.delimiter);
    expect(dirs).toContain(path.join(userDataDir, 'runtimes', 'node-bundled', 'bin'));
    expect(dirs).not.toContain(binDir);
  });

  it('does not fall back when an explicitly selected interpreter disappears', () => {
    const custom = path.join(dir, 'custom-node');
    makeExe(custom);
    const service = createService();
    service.saveProfile({ name: '自定义 Node', kind: 'node', binary: custom });
    const profileId = service.getState().active.node!;
    expect(profileId.startsWith('rt-')).toBe(true);
    rmSync(custom);

    const env = service.envFor(['node']);
    const dirs = (env.PATH ?? '').split(path.delimiter);
    expect(dirs).not.toContain(binDir);
    const shim = path.join(userDataDir, 'runtimes', 'unavailable-node', 'bin', 'node');
    expect(readFileSync(shim, 'utf8')).toContain('exit 127');
  });
});

describe('RuntimeService persistence', () => {
  it('stores a custom profile and makes it current', () => {
    const custom = path.join(dir, 'custom-node');
    makeExe(custom);
    const service = createService();
    const state = service.saveProfile({ name: 'nvm 22', kind: 'node', binary: custom });
    expect(state.active.node?.startsWith('rt-')).toBe(true);

    const reloaded = createService();
    expect(reloaded.getState().active.node).toBe(state.active.node);
    expect(reloaded.getState().profiles.some((profile) => profile.name === 'nvm 22')).toBe(true);
  });

  it('falls back to the first usable built-in after the selected profile is removed', () => {
    const custom = path.join(dir, 'custom-node');
    makeExe(custom);
    const service = createService();
    const saved = service.saveProfile({ name: 'temporary', kind: 'node', binary: custom });
    const profileId = saved.active.node!;

    const after = service.removeProfile(profileId);
    expect(after.active.node).toBeNull();
    expect(after.profiles.some((profile) => profile.id === profileId)).toBe(false);
    expect(service.activeFor('node')?.binary).toBe(realpathSync(path.join(binDir, 'node')));
    expect(() => service.removeProfile('node-system')).toThrow('内置运行环境不可删除');
  });

  it('deduplicates the same interpreter instead of adding a second row', () => {
    const custom = path.join(dir, 'custom-node');
    makeExe(custom);
    const service = createService();
    const first = service.saveProfile({ name: 'one', kind: 'node', binary: custom });
    const id = first.active.node!;
    const second = service.saveProfile({ name: 'two', kind: 'node', binary: custom });
    expect(second.active.node).toBe(id);
    expect(second.profiles.filter((profile) => profile.kind === 'node')).toHaveLength(3);
  });
});

describe('runtime detection helpers', () => {
  it('searches the inherited PATH and the usual version-manager directories', () => {
    const dirs = runtimeSearchDirs({ PATH: '/custom/bin' }, 'darwin');
    expect(dirs[0]).toBe('/custom/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/bin');
  });

  it('resolves an argv head through the child PATH, leaving absolute paths alone', () => {
    const env = { PATH: ['/nope', binDir].join(path.delimiter) };
    expect(findExecutable('node', env.PATH.split(path.delimiter))).toBe(path.join(binDir, 'node'));
    expect(resolveExecutable('node', env)).toBe(path.join(binDir, 'node'));
    expect(resolveExecutable('/absolute/tool', env)).toBe('/absolute/tool');
    expect(resolveExecutable('missing', env)).toBe('missing');
  });
});

describe('shim symlinks', () => {
  it('links both aliases for a language', () => {
    const service = createService();
    service.envFor(['python']);
    const python = path.join(userDataDir, 'runtimes', 'python-system', 'bin', 'python');
    const python3 = path.join(userDataDir, 'runtimes', 'python-system', 'bin', 'python3');
    expect(lstatSync(python).isSymbolicLink()).toBe(true);
    expect(lstatSync(python3).isSymbolicLink()).toBe(true);
    expect(realpathSync(resolveExecutable('python3', service.envFor(['python'])))).toBe(
      realpathSync(path.join(binDir, 'python3')),
    );
  });
});
