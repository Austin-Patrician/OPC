import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SkillPackCatalogView,
  SkillPackEnvState,
  SkillPackEnvStatus,
  SkillPackProgress,
  SkillPackView,
} from '@opc/shared/ipc';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { NetworkClient } from '../network/networkClient';
import type { RuntimeService } from '../runtime/service';
import { detectBackend } from '../sandbox/detect';
import { promptTokens } from './host';
import { splitFrontmatter } from './scanner';

const SETTINGS_KEY = 'skill_packs.settings';
const STAMP_FILE = '.pack-stamp.json';
export const OFFICE_ENV_ID = 'office-py';
const DEFAULT_PACK_ORDER = [
  'office-pdf',
  'office-word',
  'office-excel',
  'office-ppt',
  'office-convert',
] as const;

export const OFFICE_PYTHON_PACKAGES = [
  'pypdf>=5.0,<7',
  'pdfplumber>=0.11,<1',
  'pypdfium2>=4.30,<6',
  'reportlab>=4.2,<5',
  'openpyxl>=3.1,<4',
  'python-docx>=1.1,<2',
  'mammoth>=1.8,<2',
  'markdown>=3.7,<4',
  'beautifulsoup4>=4.12,<5',
  'pillow>=10.0,<13',
] as const;

export const OFFICE_IMPORT_MODULES = [
  { module: 'pypdf', dist: 'pypdf' },
  { module: 'pdfplumber', dist: 'pdfplumber' },
  { module: 'pypdfium2', dist: 'pypdfium2' },
  { module: 'reportlab', dist: 'reportlab' },
  { module: 'openpyxl', dist: 'openpyxl' },
  { module: 'docx', dist: 'python-docx' },
  { module: 'mammoth', dist: 'mammoth' },
  { module: 'markdown', dist: 'markdown' },
  { module: 'bs4', dist: 'beautifulsoup4' },
  { module: 'PIL', dist: 'pillow' },
] as const;

/**
 * Clean MIT/BSD/Apache engine dependencies for native editable PPTX generation
 * (hugohe3/ppt-master). AGPL-3.0 PyMuPDF is intentionally excluded; PDF parsing
 * reuses OPC's built-in `office-pdf` pack instead.
 */
export const PPT_PYTHON_PACKAGES = [
  'PyYAML>=6.0,<7',
  'python-pptx>=1.0,<2',
  'XlsxWriter>=3.2,<4',
  'skia-pathops>=0.9.2,<2',
  'uharfbuzz>=0.50,<1',
] as const;

export const PPT_IMPORT_MODULES = [
  { module: 'yaml', dist: 'PyYAML' },
  { module: 'pptx', dist: 'python-pptx' },
  { module: 'xlsxwriter', dist: 'XlsxWriter' },
  { module: 'pathops', dist: 'skia-pathops' },
  { module: 'uharfbuzz', dist: 'uharfbuzz' },
] as const;

export const PYPI_FALLBACK_MIRRORS = [
  {
    label: '清华 PyPI 镜像',
    url: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    host: 'pypi.tuna.tsinghua.edu.cn',
  },
  {
    label: '阿里云 PyPI 镜像',
    url: 'https://mirrors.aliyun.com/pypi/simple/',
    host: 'mirrors.aliyun.com',
  },
] as const;

const SAFE_UNZIP_SCRIPT = [
  'import os, sys, zipfile',
  'zip_path, dest_dir = os.path.abspath(sys.argv[1]), os.path.realpath(sys.argv[2])',
  'os.makedirs(dest_dir, exist_ok=True)',
  'with zipfile.ZipFile(zip_path, "r") as zf:',
  '  for info in zf.infolist():',
  '    target = os.path.realpath(os.path.join(dest_dir, info.filename))',
  '    if target != dest_dir and not target.startswith(dest_dir + os.sep):',
  '      raise ValueError(f"Unsafe zip path: {info.filename}")',
  '    if info.is_dir():',
  '      os.makedirs(target, exist_ok=True)',
  '      continue',
  '    os.makedirs(os.path.dirname(target), exist_ok=True)',
  '    with zf.open(info, "r") as src, open(target, "wb") as dst:',
  '      dst.write(src.read())',
].join('\n');

export type SkillPackTier = 'core' | 'ppt';

export interface SkillPackManifest {
  id: string;
  name: string;
  title: string;
  description: string;
  category: 'office';
  tier: SkillPackTier;
  archive?: string;
  version: string;
  envId: string;
  commands: string[];
  sourceDir: string;
  files: number;
  promptTokens: number;
}

interface StoredSkillPackSettings {
  enabled: Record<string, boolean>;
}

interface PackStamp {
  id: string;
  version: string;
  sourceSignature: string;
}

export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<ExecResult>;

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeout ?? 180_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter((item) => item && item.trim()).join('\n');
          reject(new Error(detail || `执行 ${file} 失败`));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

/**
 * Resolves the bundled `resources/skill-packs` directory in both dev and packaged builds.
 */
export function resolveSkillPacksSourceDir(input: {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, 'skill-packs');
  const candidate = path.join(input.appPath, 'resources', 'skill-packs');
  if (fs.existsSync(candidate)) return candidate;
  return path.join(process.cwd(), 'resources', 'skill-packs');
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) total += fs.statSync(target).size;
      } catch {
        // Skip transient files during sizing.
      }
    }
  }
  return total;
}

function countSkillFiles(dir: string): number {
  let count = 0;
  const walk = (current: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else if (entry.isFile() && entry.name !== 'SKILL.md' && entry.name !== 'manifest.json') count += 1;
    }
  };
  walk(dir, 0);
  return count;
}

function copyPackContents(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyPackContents(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

function computeSourceSignature(manifest: SkillPackManifest): string {
  const parts: string[] = [manifest.version];
  const statToken = (filePath: string) => {
    try {
      const st = fs.statSync(filePath);
      return `${path.basename(filePath)}:${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      return `${path.basename(filePath)}:missing`;
    }
  };

  parts.push(statToken(path.join(manifest.sourceDir, 'manifest.json')));
  if (manifest.archive) {
    parts.push(statToken(path.join(manifest.sourceDir, manifest.archive)));
  } else {
    parts.push(statToken(path.join(manifest.sourceDir, 'SKILL.md')));
    const scriptsDir = path.join(manifest.sourceDir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir).sort();
      for (const name of files) {
        parts.push(statToken(path.join(scriptsDir, name)));
      }
    }
  }
  return parts.join('|');
}

function readStamp(destDir: string): PackStamp | null {
  try {
    const raw = fs.readFileSync(path.join(destDir, STAMP_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PackStamp>;
    if (typeof parsed.id === 'string' && typeof parsed.version === 'string' && typeof parsed.sourceSignature === 'string') {
      return { id: parsed.id, version: parsed.version, sourceSignature: parsed.sourceSignature };
    }
  } catch {
    // Missing or malformed stamp triggers clean resync.
  }
  return null;
}

function writeStamp(destDir: string, stamp: PackStamp): void {
  fs.writeFileSync(path.join(destDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

export function loadSkillPackCatalog(sourceDir: string): SkillPackManifest[] {
  if (!fs.existsSync(sourceDir)) return [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const manifests: SkillPackManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packDir = path.join(sourceDir, entry.name);
    const manifestPath = path.join(packDir, 'manifest.json');
    const skillPath = path.join(packDir, 'SKILL.md');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(skillPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const archive = typeof raw.archive === 'string' && raw.archive.trim() ? raw.archive.trim() : undefined;
      if (archive && !fs.existsSync(path.join(packDir, archive))) {
        console.warn(`[skill-packs] 技能包归档不存在，已跳过：${path.join(packDir, archive)}`);
        continue;
      }

      const skillRaw = fs.readFileSync(skillPath, 'utf8');
      const { frontmatter, body } = splitFrontmatter(skillRaw);
      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : entry.name;
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : frontmatter.name ?? id;
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name;
      const description =
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : frontmatter.description ?? '';
      const tier: SkillPackTier = raw.tier === 'ppt' ? 'ppt' : 'core';
      const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '1.0.0';
      const envId = typeof raw.envId === 'string' && raw.envId.trim() ? raw.envId.trim() : OFFICE_ENV_ID;
      const commands = Array.isArray(raw.commands)
        ? raw.commands.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const files = countSkillFiles(packDir);
      const tokens = promptTokens({
        id: skillPath,
        name,
        description,
        scope: 'managed',
        dir: packDir,
        file: skillPath,
        files: [],
        body,
        mtime: 0,
      });
      manifests.push({
        id,
        name,
        title,
        description,
        category: 'office',
        tier,
        ...(archive ? { archive } : {}),
        version,
        envId,
        commands,
        sourceDir: packDir,
        files,
        promptTokens: tokens,
      });
    } catch (error) {
      console.warn(`[skill-packs] 读取技能包清单失败：${packDir}`, error);
    }
  }

  const orderIndex = new Map<string, number>(DEFAULT_PACK_ORDER.map((id, index) => [id, index]));
  manifests.sort((a, b) => {
    const left = orderIndex.get(a.id) ?? 999;
    const right = orderIndex.get(b.id) ?? 999;
    if (left !== right) return left - right;
    return a.id.localeCompare(b.id);
  });
  return manifests;
}

export interface SkillPackServiceOptions {
  db: CompanyDatabase;
  userDataDir: string;
  sourceDir: string;
  runtime: RuntimeService;
  network?: NetworkClient;
  exec?: ExecFn;
  onSkillsChanged?: () => void;
}

interface PrepareOptions {
  includePpt?: boolean;
}

/**
 * Manages built-in local office skill packs and their shared isolated Python venv.
 *
 * Key properties:
 * - Two-tier isolated install inside one `office-py` venv: core office packs
 *   (`office-pdf`, `office-word`, `office-excel`, `office-convert`) remain healthy
 *   even if optional native PPTX wheels (`office-ppt`) encounter an error.
 * - Archive packs (`payload.zip`) extract offline with Zip-Slip protection and
 *   attribution-guard verification.
 * - `.pack-stamp.json` skips redundant recursive copies on startup.
 */
export class SkillPackService {
  readonly managedSkillsDir: string;
  readonly skillEnvsDir: string;
  readonly officeVenvDir: string;

  private readonly exec: ExecFn;
  private readonly manifests: SkillPackManifest[];
  private readonly listeners = new Set<(catalog: SkillPackCatalogView) => void>();
  private envState: SkillPackEnvState = 'uninstalled';
  private coreReady = false;
  private pptReady = false;
  private pptAttempted = false;
  private envError?: string;
  private pptError?: string;
  private pythonVersion?: string;
  private installedPackages: Record<string, string> = {};
  private diskUsageCache: { checkedAt: number; bytes: number } = { checkedAt: 0, bytes: 0 };
  private inFlightPrepare: Promise<SkillPackCatalogView> | null = null;
  onSkillsChanged?: () => void;

  constructor(private readonly options: SkillPackServiceOptions) {
    this.managedSkillsDir = path.join(options.userDataDir, 'skills-managed');
    this.skillEnvsDir = path.join(options.userDataDir, 'skill-envs');
    this.officeVenvDir = path.join(this.skillEnvsDir, OFFICE_ENV_ID);
    this.exec = options.exec ?? defaultExec;
    this.manifests = loadSkillPackCatalog(options.sourceDir);
    this.onSkillsChanged = options.onSkillsChanged;
  }

  venvPythonPath(): string {
    return process.platform === 'win32'
      ? path.join(this.officeVenvDir, 'Scripts', 'python.exe')
      : path.join(this.officeVenvDir, 'bin', 'python');
  }

  private sitePackagesDirs(): string[] {
    if (!fs.existsSync(this.officeVenvDir)) return [];
    if (process.platform === 'win32') {
      const winSite = path.join(this.officeVenvDir, 'Lib', 'site-packages');
      return fs.existsSync(winSite) ? [winSite] : [];
    }
    const libDir = path.join(this.officeVenvDir, 'lib');
    if (!fs.existsSync(libDir)) return [];
    const dirs: string[] = [];
    for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
      const site = path.join(libDir, entry.name, 'site-packages');
      if (fs.existsSync(site)) dirs.push(site);
    }
    return dirs;
  }

  private readSettings(): StoredSkillPackSettings {
    const row = this.options.db
      .prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(SETTINGS_KEY) as { value?: string } | undefined;
    if (!row?.value) return { enabled: {} };
    try {
      const parsed = JSON.parse(row.value) as { enabled?: Record<string, unknown> };
      const enabled: Record<string, boolean> = {};
      if (parsed?.enabled && typeof parsed.enabled === 'object') {
        for (const [key, value] of Object.entries(parsed.enabled)) {
          if (typeof value === 'boolean') enabled[key] = value;
        }
      }
      return { enabled };
    } catch {
      return { enabled: {} };
    }
  }

  private writeSettings(settings: StoredSkillPackSettings): void {
    this.options.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
  }

  onChanged(listener: (catalog: SkillPackCatalogView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChanged(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore subscriber UI errors.
      }
    }
  }

  private isPackTierReady(manifest: SkillPackManifest): boolean {
    return manifest.tier === 'ppt' ? this.pptReady : this.coreReady;
  }

  /** Fast startup check: probes any pre-existing venv and reconciles `skills-managed/`. */
  async initialize(): Promise<SkillPackCatalogView> {
    const settings = this.readSettings();
    const hasPptEnabled = this.manifests.some((m) => m.tier === 'ppt' && settings.enabled[m.id] === true);
    if (fs.existsSync(this.venvPythonPath())) {
      await this.probeEnv();
      if (hasPptEnabled && !this.pptReady) {
        this.pptAttempted = true;
      }
    } else {
      this.envState = 'uninstalled';
      this.coreReady = false;
      this.pptReady = false;
      this.pptAttempted = false;
      this.installedPackages = {};
      this.pythonVersion = undefined;
    }
    await this.syncManagedSkills();
    return this.list();
  }

  async probeEnv(): Promise<boolean> {
    const python = this.venvPythonPath();
    if (!fs.existsSync(python)) {
      this.envState = 'uninstalled';
      this.coreReady = false;
      this.pptReady = false;
      this.installedPackages = {};
      this.pythonVersion = undefined;
      return false;
    }
    const probeScript = [
      'import importlib, importlib.metadata, json, platform',
      `core_checks = ${JSON.stringify(OFFICE_IMPORT_MODULES)}`,
      `ppt_checks = ${JSON.stringify(PPT_IMPORT_MODULES)}`,
      'versions = {}',
      'core_missing = []',
      'ppt_missing = []',
      'def check(items, missing):',
      '  for item in items:',
      '    try:',
      '      importlib.import_module(item["module"])',
      '      versions[item["dist"]] = importlib.metadata.version(item["dist"])',
      '    except Exception as exc:',
      '      missing.append(f"{item[\'dist\']}: {exc}")',
      'check(core_checks, core_missing)',
      'check(ppt_checks, ppt_missing)',
      'print(json.dumps({"pythonVersion": platform.python_version(), "versions": versions, "coreMissing": core_missing, "pptMissing": ppt_missing}))',
    ].join('\n');
    try {
      const result = await this.exec(python, ['-c', probeScript], {
        timeout: 20_000,
        env: this.pipChildEnv(),
      });
      const parsed = JSON.parse(result.stdout.trim()) as {
        pythonVersion?: string;
        versions?: Record<string, string>;
        missing?: string[];
        coreMissing?: string[];
        pptMissing?: string[];
      };
      this.pythonVersion = parsed.pythonVersion;
      this.installedPackages = parsed.versions ?? {};
      const coreMissing = parsed.coreMissing ?? parsed.missing ?? [];
      const pptMissing = parsed.pptMissing ?? parsed.missing ?? [];

      this.coreReady = coreMissing.length === 0;
      this.pptReady = this.coreReady && pptMissing.length === 0;

      if (!this.coreReady) {
        this.envState = 'error';
        this.envError = `缺少办公依赖包：${coreMissing.join('；')}`;
        this.pptError = this.envError;
        return false;
      }

      this.envState = 'ready';
      this.envError = undefined;
      if (pptMissing.length > 0) {
        this.pptError = `缺少 PPT 引擎依赖包：${pptMissing.join('；')}`;
      } else {
        this.pptError = undefined;
        this.pptAttempted = false;
      }
      return true;
    } catch (error) {
      this.envState = 'error';
      this.coreReady = false;
      this.pptReady = false;
      this.envError = error instanceof Error ? error.message : String(error);
      this.pptError = this.envError;
      return false;
    }
  }

  private pipChildEnv(): NodeJS.ProcessEnv {
    const base = { ...(this.options.network ? this.options.network.childEnv() : process.env) };
    base.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    base.PYTHONUNBUFFERED = '1';
    base.PYTHONIOENCODING = 'utf-8';
    base.PIP_REQUIRE_VIRTUALENV = undefined;
    return base;
  }

  private async runPipInstall(
    venvPython: string,
    packages: readonly string[],
    upgrade: boolean,
    onProgress?: (progress: SkillPackProgress) => void,
    percent = 50,
  ): Promise<void> {
    const childEnv = this.pipChildEnv();
    const baseArgs = [
      '-m',
      'pip',
      'install',
      '--no-input',
      '--disable-pip-version-check',
      '--timeout',
      '45',
      '--retries',
      '2',
      ...(upgrade ? ['--upgrade'] : []),
    ];

    const hasExplicitRouting = Boolean(
      childEnv.PIP_INDEX_URL ||
        childEnv.HTTPS_PROXY ||
        childEnv.HTTP_PROXY ||
        childEnv.ALL_PROXY ||
        childEnv.https_proxy ||
        childEnv.http_proxy ||
        childEnv.all_proxy,
    );

    try {
      await this.exec(venvPython, [...baseArgs, ...packages], { timeout: 300_000, env: childEnv });
      return;
    } catch (primaryError) {
      if (hasExplicitRouting) throw primaryError;

      let lastError: unknown = primaryError;
      for (const mirror of PYPI_FALLBACK_MIRRORS) {
        onProgress?.({
          phase: 'packages',
          percent,
          message: `直连 PyPI 失败，正在切换${mirror.label}安装…`,
        });
        try {
          await this.exec(
            venvPython,
            [...baseArgs, '-i', mirror.url, '--trusted-host', mirror.host, ...packages],
            { timeout: 300_000, env: childEnv },
          );
          return;
        } catch (mirrorError) {
          lastError = mirrorError;
        }
      }
      throw lastError;
    }
  }

  private diskUsageBytes(): number | undefined {
    if (!fs.existsSync(this.officeVenvDir)) return undefined;
    const now = Date.now();
    if (now - this.diskUsageCache.checkedAt < 30_000) return this.diskUsageCache.bytes;
    const bytes = directoryBytes(this.officeVenvDir);
    this.diskUsageCache = { checkedAt: now, bytes };
    return bytes;
  }

  envStatus(): SkillPackEnvStatus {
    const sandbox = detectBackend();
    const python = this.venvPythonPath();
    return {
      id: OFFICE_ENV_ID,
      state: this.envState,
      ...(fs.existsSync(python) ? { pythonBinary: python } : {}),
      ...(this.pythonVersion ? { pythonVersion: this.pythonVersion } : {}),
      venvDir: this.officeVenvDir,
      packages: [...OFFICE_PYTHON_PACKAGES, ...PPT_PYTHON_PACKAGES],
      installedPackages: { ...this.installedPackages },
      ...(this.diskUsageBytes() !== undefined ? { diskUsageBytes: this.diskUsageBytes() } : {}),
      sandboxBackend: sandbox.backend,
      sandboxDetail: sandbox.detail,
      ...(this.envError ? { error: this.envError } : {}),
    };
  }

  list(): SkillPackCatalogView {
    const settings = this.readSettings();
    const env = this.envStatus();
    const packs: SkillPackView[] = this.manifests.map((manifest) => {
      const enabled = settings.enabled[manifest.id] === true;
      const syncedDir = path.join(this.managedSkillsDir, manifest.id);
      const tierReady = this.isPackTierReady(manifest);
      const ready = tierReady && enabled && fs.existsSync(path.join(syncedDir, 'SKILL.md'));
      const packError =
        manifest.tier === 'ppt' && this.pptAttempted && !this.pptReady && this.pptError
          ? this.pptError
          : undefined;
      return {
        id: manifest.id,
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        category: manifest.category,
        tier: manifest.tier,
        version: manifest.version,
        envId: manifest.envId,
        enabled,
        ready,
        ...(packError ? { error: packError } : {}),
        commands: [...manifest.commands],
        dir: ready ? syncedDir : manifest.sourceDir,
        files: manifest.files,
        promptTokens: manifest.promptTokens,
      };
    });
    return { generatedAt: Date.now(), env, packs };
  }

  async prepareEnv(
    onProgress?: (progress: SkillPackProgress) => void,
    options?: PrepareOptions,
  ): Promise<SkillPackCatalogView> {
    if (this.inFlightPrepare) return this.inFlightPrepare;
    const settings = this.readSettings();
    const includePpt =
      options?.includePpt ?? this.manifests.some((m) => m.tier === 'ppt' && settings.enabled[m.id] === true);
    this.inFlightPrepare = this.runPrepareOrUpgrade(false, includePpt, onProgress).finally(() => {
      this.inFlightPrepare = null;
    });
    return this.inFlightPrepare;
  }

  async upgradeEnv(onProgress?: (progress: SkillPackProgress) => void): Promise<SkillPackCatalogView> {
    if (this.inFlightPrepare) return this.inFlightPrepare;
    const settings = this.readSettings();
    const includePpt =
      this.pptReady || this.manifests.some((m) => m.tier === 'ppt' && settings.enabled[m.id] === true);
    if (!fs.existsSync(this.venvPythonPath())) return this.prepareEnv(onProgress, { includePpt });
    this.inFlightPrepare = this.runPrepareOrUpgrade(true, includePpt, onProgress).finally(() => {
      this.inFlightPrepare = null;
    });
    return this.inFlightPrepare;
  }

  private async runPrepareOrUpgrade(
    upgrade: boolean,
    includePpt: boolean,
    onProgress?: (progress: SkillPackProgress) => void,
  ): Promise<SkillPackCatalogView> {
    const previousState = this.envState;
    this.envState = 'installing';
    this.envError = undefined;
    if (includePpt) {
      this.pptAttempted = true;
      this.pptError = undefined;
    }
    this.emitChanged();

    const report = (phase: SkillPackProgress['phase'], percent: number, message: string) => {
      onProgress?.({ phase, percent, message });
    };

    try {
      const resolvedPython = this.options.runtime.activeFor('python');
      if (!resolvedPython?.binary) {
        throw new Error('未找到可用的 Python 3 解释器，请先在「设置 → 运行环境」配置 Python 3');
      }

      const venvPython = this.venvPythonPath();
      if (!fs.existsSync(venvPython) || !upgrade) {
        report('venv', 12, '正在创建隔离的 Python 虚拟环境…');
        if (!fs.existsSync(venvPython)) {
          fs.rmSync(this.officeVenvDir, { recursive: true, force: true });
          fs.mkdirSync(this.skillEnvsDir, { recursive: true });
          try {
            await this.exec(resolvedPython.binary, ['-m', 'venv', this.officeVenvDir], {
              timeout: 60_000,
              env: this.pipChildEnv(),
            });
          } catch (error) {
            fs.rmSync(this.officeVenvDir, { recursive: true, force: true });
            throw error;
          }
        }
      }

      if (!this.coreReady || upgrade) {
        report(
          'packages',
          35,
          upgrade ? '正在升级基础办公依赖包…' : '正在安装基础办公依赖包（pypdf / openpyxl / python-docx 等）…',
        );
        await this.runPipInstall(venvPython, OFFICE_PYTHON_PACKAGES, upgrade, onProgress, 40);
      }

      if (includePpt && (!this.pptReady || upgrade)) {
        report(
          'packages',
          62,
          upgrade
            ? '正在升级 PPT 大师引擎依赖…'
            : '正在安装 PPT 大师引擎依赖（python-pptx / skia-pathops / uharfbuzz 等）…',
        );
        try {
          await this.runPipInstall(venvPython, PPT_PYTHON_PACKAGES, upgrade, onProgress, 68);
        } catch (pptInstallError) {
          // Probe core tier first so core office packs still become ready when only PPT tier failed.
          await this.probeEnv();
          if (this.coreReady) {
            this.pptReady = false;
            this.pptAttempted = true;
            this.pptError = pptInstallError instanceof Error ? pptInstallError.message : String(pptInstallError);
            this.diskUsageCache.checkedAt = 0;
            await this.syncManagedSkills(onProgress);
            this.onSkillsChanged?.();
            this.emitChanged();
            return this.list();
          }
          throw pptInstallError;
        }
      }

      report('verify', 82, '正在校验办公组件是否可正常导入…');
      await this.probeEnv();
      if (!this.coreReady) {
        throw new Error(this.envError ?? '依赖安装后自检失败');
      }

      report('sync', 92, '正在准备已启用的办公技能包…');
      this.diskUsageCache.checkedAt = 0;
      await this.syncManagedSkills(onProgress);
      report('sync', 100, '办公技能环境已就绪');
    } catch (error) {
      this.envState = fs.existsSync(this.venvPythonPath()) || previousState === 'error' ? 'error' : 'uninstalled';
      this.coreReady = false;
      this.pptReady = false;
      this.envError = error instanceof Error ? error.message : String(error);
      if (includePpt) this.pptError = this.envError;
      await this.syncManagedSkills();
    }

    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  async setEnabled(
    packId: string,
    enabled: boolean,
    onProgress?: (progress: SkillPackProgress) => void,
  ): Promise<SkillPackCatalogView> {
    const manifest = this.manifests.find((item) => item.id === packId);
    if (!manifest) throw new Error(`未知办公技能包：${packId}`);

    if (enabled) {
      const needsPpt = manifest.tier === 'ppt';
      if (needsPpt) this.pptAttempted = true;
      if ((needsPpt && !this.pptReady) || (!needsPpt && !this.coreReady)) {
        const prepared = await this.prepareEnv(onProgress, { includePpt: needsPpt });
        if (prepared.env.state !== 'ready') {
          throw new Error(prepared.env.error ?? '办公 Python 环境准备失败');
        }
        if (needsPpt && !this.pptReady) {
          throw new Error(this.pptError ?? 'PPT 大师依赖环境准备失败');
        }
      }
    }

    const settings = this.readSettings();
    const prevEnabled = settings.enabled[packId] === true;
    settings.enabled[packId] = enabled;
    this.writeSettings(settings);
    try {
      await this.syncManagedSkills(onProgress);
    } catch (error) {
      settings.enabled[packId] = prevEnabled;
      this.writeSettings(settings);
      if (manifest.tier === 'ppt') {
        this.pptAttempted = true;
        this.pptError = error instanceof Error ? error.message : String(error);
      }
      this.emitChanged();
      throw error;
    }

    if (manifest.tier === 'ppt' && !enabled && !this.pptReady) {
      this.pptAttempted = false;
      this.pptError = undefined;
    }
    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  async enableAll(onProgress?: (progress: SkillPackProgress) => void): Promise<SkillPackCatalogView> {
    // Stage 1: ensure core tier is ready and core packs are immediately enabled.
    if (!this.coreReady) {
      const preparedCore = await this.prepareEnv(onProgress, { includePpt: false });
      if (preparedCore.env.state !== 'ready') {
        throw new Error(preparedCore.env.error ?? '办公 Python 环境准备失败');
      }
    }

    const settings = this.readSettings();
    for (const manifest of this.manifests) {
      if (manifest.tier === 'core') settings.enabled[manifest.id] = true;
    }
    this.writeSettings(settings);
    await this.syncManagedSkills(onProgress);

    // Stage 2: install PPT tier + extract archive; keep core packs ready even if PPT fails.
    const pptPacks = this.manifests.filter((manifest) => manifest.tier === 'ppt');
    if (pptPacks.length > 0) {
      this.pptAttempted = true;
      if (!this.pptReady) {
        await this.prepareEnv(onProgress, { includePpt: true });
      }
      if (this.pptReady) {
        const nextSettings = this.readSettings();
        for (const manifest of pptPacks) {
          nextSettings.enabled[manifest.id] = true;
        }
        this.writeSettings(nextSettings);
        try {
          await this.syncManagedSkills(onProgress);
        } catch (error) {
          const rollback = this.readSettings();
          for (const manifest of pptPacks) rollback.enabled[manifest.id] = false;
          this.writeSettings(rollback);
          this.pptError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  uninstallEnv(): SkillPackCatalogView {
    const settings = this.readSettings();
    for (const manifest of this.manifests) {
      settings.enabled[manifest.id] = false;
    }
    this.writeSettings(settings);
    fs.rmSync(this.officeVenvDir, { recursive: true, force: true });
    fs.rmSync(this.managedSkillsDir, { recursive: true, force: true });
    this.envState = 'uninstalled';
    this.coreReady = false;
    this.pptReady = false;
    this.pptAttempted = false;
    this.envError = undefined;
    this.pptError = undefined;
    this.pythonVersion = undefined;
    this.installedPackages = {};
    this.diskUsageCache.checkedAt = 0;
    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  /**
   * Keeps `<userData>/skills-managed/` aligned with `{ tierReady && enabled }`.
   * Uses `.pack-stamp.json` so unchanged packs (including 12k-file PPT icon assets)
   * skip redundant recursive copies or archive extractions on startup.
   */
  async syncManagedSkills(onProgress?: (progress: SkillPackProgress) => void): Promise<void> {
    const settings = this.readSettings();
    const python = this.venvPythonPath();
    if (!this.coreReady || !fs.existsSync(python)) {
      fs.rmSync(this.managedSkillsDir, { recursive: true, force: true });
      return;
    }

    fs.mkdirSync(this.managedSkillsDir, { recursive: true });
    const wanted = new Set(
      this.manifests
        .filter((item) => settings.enabled[item.id] === true && this.isPackTierReady(item))
        .map((item) => item.id),
    );

    for (const existing of fs.readdirSync(this.managedSkillsDir, { withFileTypes: true })) {
      if (!wanted.has(existing.name)) {
        fs.rmSync(path.join(this.managedSkillsDir, existing.name), { recursive: true, force: true });
      }
    }

    for (const manifest of this.manifests) {
      if (!wanted.has(manifest.id)) continue;
      const dest = path.join(this.managedSkillsDir, manifest.id);
      const signature = computeSourceSignature(manifest);
      const currentStamp = readStamp(dest);
      if (
        fs.existsSync(path.join(dest, 'SKILL.md')) &&
        currentStamp &&
        currentStamp.id === manifest.id &&
        currentStamp.version === manifest.version &&
        currentStamp.sourceSignature === signature
      ) {
        continue;
      }

      if (manifest.archive) {
        const archivePath = path.join(manifest.sourceDir, manifest.archive);
        const tmpDir = path.join(this.managedSkillsDir, `.${manifest.id}.tmp-${Date.now()}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        onProgress?.({
          phase: 'extract',
          percent: 88,
          message: `正在解压内置 ${manifest.title} 技能资源…`,
        });
        try {
          await this.exec(python, ['-c', SAFE_UNZIP_SCRIPT, archivePath, tmpDir], {
            timeout: 120_000,
            env: this.pipChildEnv(),
          });
          const guardScript = path.join(tmpDir, 'scripts', 'attribution_guard.py');
          if (fs.existsSync(guardScript)) {
            onProgress?.({
              phase: 'verify',
              percent: 94,
              message: `正在校验 ${manifest.title} 完整性…`,
            });
            await this.exec(python, [guardScript], {
              timeout: 20_000,
              env: this.pipChildEnv(),
              cwd: tmpDir,
            });
          }
          fs.rmSync(dest, { recursive: true, force: true });
          fs.renameSync(tmpDir, dest);
          writeStamp(dest, { id: manifest.id, version: manifest.version, sourceSignature: signature });
        } catch (error) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          throw error;
        }
      } else {
        fs.rmSync(dest, { recursive: true, force: true });
        copyPackContents(manifest.sourceDir, dest);
        writeStamp(dest, { id: manifest.id, version: manifest.version, sourceSignature: signature });
      }
    }
  }

  /** Extra environment variables injected into `RuntimeService.envFor()` when ready. */
  envOverlay(): Record<string, string> {
    if (!this.coreReady) return {};
    const python = this.venvPythonPath();
    if (!fs.existsSync(python)) return {};
    const sites = this.sitePackagesDirs();
    const settings = this.readSettings();
    const pptDir = path.join(this.managedSkillsDir, 'office-ppt');
    const pptEnabledAndSynced =
      this.pptReady &&
      settings.enabled['office-ppt'] === true &&
      fs.existsSync(path.join(pptDir, 'SKILL.md'));

    return {
      OPC_OFFICE_PYTHON: python,
      ...(sites.length > 0 ? { PYTHONPATH: sites.join(path.delimiter) } : {}),
      ...(pptEnabledAndSynced ? { OPC_PPT_SKILL_DIR: pptDir } : {}),
    };
  }

  /**
   * Read-only roots required inside `opc.sandbox` so workers can read managed
   * skill scripts and execute the isolated venv without opening `userData` wholesale.
   */
  sandboxReadOnlyRoots(): string[] {
    const roots: string[] = [];
    for (const candidate of [this.managedSkillsDir, this.skillEnvsDir]) {
      if (!fs.existsSync(candidate)) continue;
      roots.push(candidate);
      try {
        const real = fs.realpathSync(candidate);
        if (real !== candidate) roots.push(real);
      } catch {
        // Keep the unresolved path when realpath fails.
      }
    }
    return roots;
  }

  /** Active managed skill summaries exposed to Router for delegation decisions. */
  enabledSummaries(): Array<{ id: string; name: string; title: string; summary: string }> {
    if (!this.coreReady) return [];
    const settings = this.readSettings();
    return this.manifests
      .filter((manifest) => settings.enabled[manifest.id] === true && this.isPackTierReady(manifest))
      .map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        title: manifest.title,
        summary: manifest.description,
      }));
  }
}
