import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { RuntimeService } from '../runtime/service';
import {
  loadSkillPackCatalog,
  OFFICE_PYTHON_PACKAGES,
  PPT_PYTHON_PACKAGES,
  PYPI_FALLBACK_MIRRORS,
  resolveSkillPacksSourceDir,
  SkillPackService,
  type ExecFn,
} from './packs';

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
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  makeExe(path.join(binDir, `node${exeSuffix}`));
  makeExe(path.join(binDir, `python3${exeSuffix}`));
  db = openCompanyDatabase(path.join(root, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface FakeExecOptions {
  failPip?: boolean;
  failPptPip?: boolean;
  failDirectPipOnce?: boolean;
  failGuard?: boolean;
}

function createFakeExec(options: FakeExecOptions = {}): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  let coreInstalled = false;
  let pptInstalled = false;
  let failedDirectOnce = false;

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
      const isPptInstall = PPT_PYTHON_PACKAGES.some((pkg) => args.includes(pkg));
      if (isPptInstall && options.failPptPip) {
        throw new Error('ppt wheel download failed');
      }
      const isMirror = args.includes('-i');
      if (!isMirror && options.failDirectPipOnce && !failedDirectOnce) {
        failedDirectOnce = true;
        throw new Error('direct pypi timeout');
      }
      if (isPptInstall) pptInstalled = true;
      else coreInstalled = true;
      return { stdout: 'Successfully installed', stderr: '' };
    }

    // Safe unzip invocation: python -c <script> <zipPath> <tmpDir>
    if (args[0] === '-c' && args.length >= 4) {
      const destDir = args[3]!;
      mkdirSync(path.join(destDir, 'scripts'), { recursive: true });
      writeFileSync(path.join(destDir, 'SKILL.md'), '---\nname: ppt-master\n---\n# PPT Master\n', 'utf8');
      writeFileSync(path.join(destDir, 'LICENSE'), 'MIT', 'utf8');
      writeFileSync(path.join(destDir, 'scripts', 'attribution_guard.py'), 'print("ok")\n', 'utf8');
      return { stdout: '', stderr: '' };
    }

    // Attribution guard invocation
    if (args[0]?.endsWith('attribution_guard.py')) {
      if (options.failGuard) throw new Error('integrity check failed');
      return { stdout: '', stderr: '' };
    }

    if (args[0] === '-c') {
      return {
        stdout: JSON.stringify({
          pythonVersion: '3.12.3',
          versions: {
            ...(coreInstalled ? { pypdf: '5.0.0', openpyxl: '3.1.5', 'python-docx': '1.1.2' } : {}),
            ...(pptInstalled ? { 'python-pptx': '1.0.2', PyYAML: '6.0.4', 'skia-pathops': '0.9.2' } : {}),
          },
          coreMissing: coreInstalled ? [] : ['pypdf: missing'],
          pptMissing: pptInstalled ? [] : ['python-pptx: missing'],
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
  it('ships all five valid office packs including built-in office-ppt payload', () => {
    const manifests = loadSkillPackCatalog(realSourceDir);
    expect(manifests.map((item) => item.id)).toEqual([
      'office-pdf',
      'office-word',
      'office-excel',
      'office-ppt',
      'office-convert',
    ]);
    for (const pack of manifests) {
      expect(pack.files).toBeGreaterThanOrEqual(1);
      expect(pack.promptTokens).toBeGreaterThan(0);
      expect(existsSync(path.join(pack.sourceDir, 'SKILL.md'))).toBe(true);
    }
    const ppt = manifests.find((item) => item.id === 'office-ppt')!;
    expect(ppt.tier).toBe('ppt');
    expect(ppt.archive).toBe('payload.zip');
    expect(existsSync(path.join(ppt.sourceDir, 'payload.zip'))).toBe(true);
  });

  it('keeps AGPL PyMuPDF excluded from PPT dependencies', () => {
    expect(PPT_PYTHON_PACKAGES.some((pkg) => /pymupdf|fitz/i.test(pkg))).toBe(false);
    expect(OFFICE_PYTHON_PACKAGES.some((pkg) => /pymupdf|fitz/i.test(pkg))).toBe(false);
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

  it('installs only core packages when enabling a core pack, then installs PPT tier on demand', async () => {
    const { exec, calls } = createFakeExec();
    let invalidated = 0;
    const { runtime, service } = createService(exec, () => {
      invalidated += 1;
    });

    const catalog = await service.setEnabled('office-pdf', true);
    expect(catalog.env.state).toBe('ready');
    expect(catalog.env.pythonVersion).toBe('3.12.3');
    expect(catalog.packs.find((p) => p.id === 'office-pdf')).toMatchObject({ enabled: true, ready: true });
    expect(catalog.packs.find((p) => p.id === 'office-ppt')).toMatchObject({ enabled: false, ready: false });
    expect(catalog.packs.find((p) => p.id === 'office-ppt')?.error).toBeUndefined();
    expect(existsSync(path.join(service.managedSkillsDir, 'office-pdf', 'scripts', 'pdf_tool.py'))).toBe(true);
    expect(existsSync(path.join(service.managedSkillsDir, 'office-excel'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes(PPT_PYTHON_PACKAGES[0]))).toBe(false);
    expect(invalidated).toBeGreaterThan(0);

    const childEnv = runtime.envFor(['python']);
    expect(childEnv.OPC_OFFICE_PYTHON).toBe(service.venvPythonPath());
    expect(childEnv.OPC_PPT_SKILL_DIR).toBeUndefined();
    expect(childEnv.PYTHONPATH?.toLowerCase()).toContain(path.join(service.officeVenvDir, 'lib').toLowerCase());

    // Now enable office-ppt: extracts payload.zip, checks attribution_guard, sets OPC_PPT_SKILL_DIR.
    const withPpt = await service.setEnabled('office-ppt', true);
    expect(withPpt.packs.find((p) => p.id === 'office-ppt')).toMatchObject({ enabled: true, ready: true });
    expect(calls.some((cmd) => cmd.includes(PPT_PYTHON_PACKAGES[0]))).toBe(true);
    expect(calls.some((cmd) => cmd[1]?.endsWith('attribution_guard.py'))).toBe(true);
    expect(existsSync(path.join(service.managedSkillsDir, 'office-ppt', '.pack-stamp.json'))).toBe(true);
    expect(runtime.envFor(['python']).OPC_PPT_SKILL_DIR).toBe(path.join(service.managedSkillsDir, 'office-ppt'));

    // Incremental stamp skips re-extracting office-ppt on subsequent syncs.
    const callsBeforeSync = calls.length;
    await service.syncManagedSkills();
    expect(calls.length).toBe(callsBeforeSync);

    const roots = runtime.sandboxRoots();
    expect(roots).toContain(realpathSync(service.managedSkillsDir));
    expect(roots).toContain(realpathSync(service.skillEnvsDir));
    expect(service.enabledSummaries().map((s) => s.id)).toEqual(['office-pdf', 'office-ppt']);
  });

  it('skips recursive copy when .pack-stamp.json matches on initialize()', async () => {
    const { exec } = createFakeExec();
    const { service } = createService(exec);
    await service.setEnabled('office-pdf', true);

    const sentinelFile = path.join(service.managedSkillsDir, 'office-pdf', 'scripts', 'pdf_tool.py');
    const past = new Date(Date.now() - 120_000);
    utimesSync(sentinelFile, past, past);
    const beforeMtime = statSync(sentinelFile).mtimeMs;

    await service.syncManagedSkills();
    expect(statSync(sentinelFile).mtimeMs).toBe(beforeMtime);
  });

  it('supports enableAll across all 5 packs including office-ppt, toggle off, upgradeEnv and uninstallEnv', async () => {
    const { exec } = createFakeExec();
    const { service } = createService(exec);

    const allEnabled = await service.enableAll();
    expect(allEnabled.packs).toHaveLength(5);
    expect(allEnabled.packs.every((pack) => pack.enabled && pack.ready)).toBe(true);
    expect(service.enabledSummaries()).toHaveLength(5);

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

  it('isolates PPT tier failure during enableAll so core packs stay ready', async () => {
    const { exec } = createFakeExec({ failPptPip: true });
    const { service } = createService(exec);

    const result = await service.enableAll();
    expect(result.env.state).toBe('ready');
    for (const coreId of ['office-pdf', 'office-word', 'office-excel', 'office-convert']) {
      expect(result.packs.find((p) => p.id === coreId)).toMatchObject({ enabled: true, ready: true });
    }
    const ppt = result.packs.find((p) => p.id === 'office-ppt')!;
    expect(ppt.enabled).toBe(false);
    expect(ppt.ready).toBe(false);
    expect(ppt.error).toMatch(/ppt wheel download failed/);
  });

  it('falls back to PyPI mirror when direct pip fails without proxy or custom index', async () => {
    const savedEnv = {
      PIP_INDEX_URL: process.env.PIP_INDEX_URL,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
    };
    delete process.env.PIP_INDEX_URL;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;

    try {
      const { exec, calls } = createFakeExec({ failDirectPipOnce: true });
      const { service } = createService(exec);
      const progressMsgs: string[] = [];
      const catalog = await service.setEnabled('office-pdf', true, (p) => progressMsgs.push(p.message));
      expect(catalog.env.state).toBe('ready');
      expect(calls.some((cmd) => cmd.includes(PYPI_FALLBACK_MIRRORS[0].url))).toBe(true);
      expect(progressMsgs.some((msg) => msg.includes(PYPI_FALLBACK_MIRRORS[0].label))).toBe(true);
    } finally {
      Object.assign(process.env, savedEnv);
    }
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
