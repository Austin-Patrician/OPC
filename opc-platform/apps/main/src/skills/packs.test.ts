import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { RuntimeService } from '../runtime/service';
import { loadSkillPackCatalog, resolveSkillPacksSourceDir, SkillPackService, type ExecFn } from './packs';

let root: string;
let userDataDir: string;
let binDir: string;
let db: CompanyDatabase;
const realSourceDir = path.resolve(process.cwd(), 'resources', 'skill-packs');

function makeExe(file: string): void {
  writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(file, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'opc-skill-packs-'));
  userDataDir = path.join(root, 'userData');
  binDir = path.join(root, 'bin');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  makeExe(path.join(binDir, 'node'));
  makeExe(path.join(binDir, 'python3'));
  db = openCompanyDatabase(path.join(root, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function createFakeExec(options: { failPip?: boolean } = {}): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === '-m' && args[1] === 'venv') {
      const venvDir = args[2]!;
      const pythonBin =
        process.platform === 'win32'
          ? path.join(venvDir, 'Scripts', 'python.exe')
          : path.join(venvDir, 'bin', 'python');
      const siteDir =
        process.platform === 'win32'
          ? path.join(venvDir, 'Lib', 'site-packages')
          : path.join(venvDir, 'lib', 'python3.12', 'site-packages');
      mkdirSync(path.dirname(pythonBin), { recursive: true });
      mkdirSync(siteDir, { recursive: true });
      makeExe(pythonBin);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '-m' && args[1] === 'pip') {
      if (options.failPip) throw new Error('pip network error');
      return { stdout: 'Successfully installed', stderr: '' };
    }
    if (args[0] === '-c') {
      return {
        stdout: JSON.stringify({
          pythonVersion: '3.12.3',
          versions: { pypdf: '5.0.0', openpyxl: '3.1.5', 'python-docx': '1.1.2' },
          missing: [],
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function createService(exec: ExecFn, onSkillsChanged?: () => void) {
  const runtime = new RuntimeService(db, {
    userDataDir,
    searchDirs: [binDir],
    probeVersion: async () => ({ ok: true, version: '3.12.3' }),
  });
  const service = new SkillPackService({
    db,
    userDataDir,
    sourceDir: realSourceDir,
    runtime,
    exec,
    onSkillsChanged,
  });
  runtime.registerSkillEnvProvider({
    envOverlay: () => service.envOverlay(),
    sandboxRoots: () => service.sandboxReadOnlyRoots(),
  });
  return { runtime, service };
}

describe('office skill pack resources', () => {
  it('ships all four valid office packs with SKILL.md and scripts', () => {
    const manifests = loadSkillPackCatalog(realSourceDir);
    expect(manifests.map((item) => item.id)).toEqual([
      'office-pdf',
      'office-excel',
      'office-word',
      'office-convert',
    ]);
    for (const pack of manifests) {
      expect(pack.files).toBeGreaterThanOrEqual(1);
      expect(pack.promptTokens).toBeGreaterThan(0);
      expect(existsSync(path.join(pack.sourceDir, 'SKILL.md'))).toBe(true);
    }
  });

  it('resolves source directory for dev and packaged builds', () => {
    expect(
      resolveSkillPacksSourceDir({
        packaged: true,
        appPath: '/app',
        resourcesPath: '/Applications/OPC.app/Contents/Resources',
      }),
    ).toBe(path.join('/Applications/OPC.app/Contents/Resources', 'skill-packs'));
    expect(
      resolveSkillPacksSourceDir({
        packaged: false,
        appPath: process.cwd(),
        resourcesPath: '/unused',
      }),
    ).toBe(realSourceDir);
  });
});

describe('SkillPackService', () => {
  it('starts uninstalled and keeps managed skills off disk until ready and enabled', async () => {
    const { exec } = createFakeExec();
    const { runtime, service } = createService(exec);
    const catalog = await service.initialize();

    expect(catalog.env.state).toBe('uninstalled');
    expect(catalog.packs.every((pack) => !pack.enabled && !pack.ready)).toBe(true);
    expect(existsSync(service.managedSkillsDir)).toBe(false);
    expect(service.envOverlay()).toEqual({});
    expect(runtime.envFor(['python']).OPC_OFFICE_PYTHON).toBeUndefined();
  });

  it('auto-prepares isolated venv when enabling a pack, injects env/sandbox roots, and syncs only enabled packs', async () => {
    const { exec, calls } = createFakeExec();
    let invalidated = 0;
    const { runtime, service } = createService(exec, () => {
      invalidated += 1;
    });

    const catalog = await service.setEnabled('office-pdf', true);
    expect(catalog.env.state).toBe('ready');
    expect(catalog.env.pythonVersion).toBe('3.12.3');
    expect(catalog.packs.find((p) => p.id === 'office-pdf')).toMatchObject({ enabled: true, ready: true });
    expect(catalog.packs.find((p) => p.id === 'office-excel')).toMatchObject({ enabled: false, ready: false });
    expect(existsSync(path.join(service.managedSkillsDir, 'office-pdf', 'scripts', 'pdf_tool.py'))).toBe(true);
    expect(existsSync(path.join(service.managedSkillsDir, 'office-excel'))).toBe(false);
    expect(calls.some((cmd) => cmd[1] === '-m' && cmd[2] === 'venv')).toBe(true);
    expect(invalidated).toBeGreaterThan(0);

    const childEnv = runtime.envFor(['python']);
    expect(childEnv.OPC_OFFICE_PYTHON).toBe(service.venvPythonPath());
    expect(childEnv.PYTHONPATH).toContain(path.join(service.officeVenvDir, 'lib'));

    const roots = runtime.sandboxRoots();
    expect(roots).toContain(realpathSync(service.managedSkillsDir));
    expect(roots).toContain(realpathSync(service.skillEnvsDir));
    expect(service.enabledSummaries().map((s) => s.id)).toEqual(['office-pdf']);
  });

  it('supports enableAll, toggle off, upgradeEnv and clean uninstallEnv', async () => {
    const { exec } = createFakeExec();
    const { service } = createService(exec);

    const allEnabled = await service.enableAll();
    expect(allEnabled.packs.every((pack) => pack.enabled && pack.ready)).toBe(true);
    expect(service.enabledSummaries()).toHaveLength(4);

    const afterDisable = await service.setEnabled('office-word', false);
    expect(afterDisable.packs.find((p) => p.id === 'office-word')).toMatchObject({ enabled: false, ready: false });
    expect(existsSync(path.join(service.managedSkillsDir, 'office-word'))).toBe(false);

    const upgraded = await service.upgradeEnv();
    expect(upgraded.env.state).toBe('ready');

    const uninstalled = service.uninstallEnv();
    expect(uninstalled.env.state).toBe('uninstalled');
    expect(uninstalled.packs.every((pack) => !pack.enabled && !pack.ready)).toBe(true);
    expect(existsSync(service.officeVenvDir)).toBe(false);
    expect(existsSync(service.managedSkillsDir)).toBe(false);
  });

  it('does not mark a pack enabled when environment installation fails', async () => {
    const { exec } = createFakeExec({ failPip: true });
    const { service } = createService(exec);

    await expect(service.setEnabled('office-excel', true)).rejects.toThrow(/pip network error/);
    const catalog = service.list();
    expect(catalog.env.state).toBe('error');
    expect(catalog.packs.find((p) => p.id === 'office-excel')).toMatchObject({ enabled: false, ready: false });
    expect(existsSync(service.managedSkillsDir)).toBe(false);
  });
});
