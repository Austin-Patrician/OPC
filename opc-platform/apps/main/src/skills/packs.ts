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
export const OFFICE_ENV_ID = 'office-py';
const DEFAULT_PACK_ORDER = ['office-pdf', 'office-excel', 'office-word', 'office-convert'] as const;

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

export interface SkillPackManifest {
  id: string;
  name: string;
  title: string;
  description: string;
  category: 'office';
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
      const skillRaw = fs.readFileSync(skillPath, 'utf8');
      const { frontmatter, body } = splitFrontmatter(skillRaw);
      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : entry.name;
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : frontmatter.name ?? id;
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name;
      const description =
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : frontmatter.description ?? '';
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

/**
 * Manages built-in local office skill packs and their shared isolated Python venv.
 *
 * Key properties:
 * - Decoupled: packs live as standard `SKILL.md + scripts/*.py` folders in `resources/skill-packs/`.
 * - Isolated: packages install into `<userData>/skill-envs/office-py/` without touching system Python.
 * - Honest gating: packs are synced into `<userData>/skills-managed/` ONLY when `enabled` AND `env.state === 'ready'`.
 */
export class SkillPackService {
  readonly managedSkillsDir: string;
  readonly skillEnvsDir: string;
  readonly officeVenvDir: string;

  private readonly exec: ExecFn;
  private readonly manifests: SkillPackManifest[];
  private readonly listeners = new Set<(catalog: SkillPackCatalogView) => void>();
  private envState: SkillPackEnvState = 'uninstalled';
  private envError?: string;
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

  /** Fast startup check: probes any pre-existing venv and reconciles `skills-managed/`. */
  async initialize(): Promise<SkillPackCatalogView> {
    if (fs.existsSync(this.venvPythonPath())) {
      await this.probeEnv();
    } else {
      this.envState = 'uninstalled';
      this.installedPackages = {};
      this.pythonVersion = undefined;
    }
    this.syncManagedSkills();
    return this.list();
  }

  async probeEnv(): Promise<boolean> {
    const python = this.venvPythonPath();
    if (!fs.existsSync(python)) {
      this.envState = 'uninstalled';
      this.installedPackages = {};
      this.pythonVersion = undefined;
      return false;
    }
    const probeScript = [
      'import importlib, importlib.metadata, json, platform',
      `checks = ${JSON.stringify(OFFICE_IMPORT_MODULES)}`,
      'versions = {}',
      'missing = []',
      'for item in checks:',
      '  try:',
      '    importlib.import_module(item["module"])',
      '    versions[item["dist"]] = importlib.metadata.version(item["dist"])',
      '  except Exception as exc:',
      '    missing.append(f"{item[\'dist\']}: {exc}")',
      'print(json.dumps({"pythonVersion": platform.python_version(), "versions": versions, "missing": missing}))',
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
      };
      this.pythonVersion = parsed.pythonVersion;
      this.installedPackages = parsed.versions ?? {};
      const missing = parsed.missing ?? [];
      if (missing.length > 0) {
        this.envState = 'error';
        this.envError = `缺少办公依赖包：${missing.join('；')}`;
        return false;
      }
      this.envState = 'ready';
      this.envError = undefined;
      return true;
    } catch (error) {
      this.envState = 'error';
      this.envError = error instanceof Error ? error.message : String(error);
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
      packages: [...OFFICE_PYTHON_PACKAGES],
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
    const envReady = env.state === 'ready';
    const packs: SkillPackView[] = this.manifests.map((manifest) => {
      const enabled = settings.enabled[manifest.id] === true;
      const syncedDir = path.join(this.managedSkillsDir, manifest.id);
      const ready = envReady && enabled && fs.existsSync(path.join(syncedDir, 'SKILL.md'));
      return {
        id: manifest.id,
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        category: manifest.category,
        version: manifest.version,
        envId: manifest.envId,
        enabled,
        ready,
        commands: [...manifest.commands],
        dir: ready ? syncedDir : manifest.sourceDir,
        files: manifest.files,
        promptTokens: manifest.promptTokens,
      };
    });
    return { generatedAt: Date.now(), env, packs };
  }

  async prepareEnv(onProgress?: (progress: SkillPackProgress) => void): Promise<SkillPackCatalogView> {
    if (this.inFlightPrepare) return this.inFlightPrepare;
    this.inFlightPrepare = this.runPrepareOrUpgrade(false, onProgress).finally(() => {
      this.inFlightPrepare = null;
    });
    return this.inFlightPrepare;
  }

  async upgradeEnv(onProgress?: (progress: SkillPackProgress) => void): Promise<SkillPackCatalogView> {
    if (this.inFlightPrepare) return this.inFlightPrepare;
    if (!fs.existsSync(this.venvPythonPath())) return this.prepareEnv(onProgress);
    this.inFlightPrepare = this.runPrepareOrUpgrade(true, onProgress).finally(() => {
      this.inFlightPrepare = null;
    });
    return this.inFlightPrepare;
  }

  private async runPrepareOrUpgrade(
    upgrade: boolean,
    onProgress?: (progress: SkillPackProgress) => void,
  ): Promise<SkillPackCatalogView> {
    const previousState = this.envState;
    this.envState = 'installing';
    this.envError = undefined;
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
        report('venv', 15, '正在创建隔离的 Python 虚拟环境…');
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

      report('packages', 45, upgrade ? '正在升级本地办公依赖包…' : '正在安装本地办公依赖包（pypdf / openpyxl / python-docx 等）…');
      await this.exec(
        venvPython,
        [
          '-m',
          'pip',
          'install',
          '--no-input',
          '--disable-pip-version-check',
          ...(upgrade ? ['--upgrade'] : []),
          ...OFFICE_PYTHON_PACKAGES,
        ],
        { timeout: 300_000, env: this.pipChildEnv() },
      );

      report('verify', 85, '正在校验所有办公库是否可正常导入…');
      const ok = await this.probeEnv();
      if (!ok) {
        throw new Error(this.envError ?? '依赖安装后自检失败');
      }

      report('sync', 95, '正在同步已启用的办公技能包…');
      this.diskUsageCache.checkedAt = 0;
      this.syncManagedSkills();
      report('sync', 100, '办公技能环境已就绪');
    } catch (error) {
      this.envState = fs.existsSync(this.venvPythonPath()) || previousState === 'error' ? 'error' : 'uninstalled';
      this.envError = error instanceof Error ? error.message : String(error);
      this.syncManagedSkills();
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

    if (enabled && this.envState !== 'ready') {
      const prepared = await this.prepareEnv(onProgress);
      if (prepared.env.state !== 'ready') {
        throw new Error(prepared.env.error ?? '办公 Python 环境准备失败');
      }
    }

    const settings = this.readSettings();
    settings.enabled[packId] = enabled;
    this.writeSettings(settings);
    this.syncManagedSkills();
    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  async enableAll(onProgress?: (progress: SkillPackProgress) => void): Promise<SkillPackCatalogView> {
    if (this.envState !== 'ready') {
      const prepared = await this.prepareEnv(onProgress);
      if (prepared.env.state !== 'ready') {
        throw new Error(prepared.env.error ?? '办公 Python 环境准备失败');
      }
    }
    const settings = this.readSettings();
    for (const manifest of this.manifests) {
      settings.enabled[manifest.id] = true;
    }
    this.writeSettings(settings);
    this.syncManagedSkills();
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
    this.envError = undefined;
    this.pythonVersion = undefined;
    this.installedPackages = {};
    this.diskUsageCache.checkedAt = 0;
    this.onSkillsChanged?.();
    this.emitChanged();
    return this.list();
  }

  /**
   * Keeps `<userData>/skills-managed/` strictly aligned with `{ ready && enabled }`.
   * Never leaves unready skills on disk for `PiSkillHost` to advertise.
   */
  syncManagedSkills(): void {
    const settings = this.readSettings();
    const envReady = this.envState === 'ready' && fs.existsSync(this.venvPythonPath());
    if (!envReady) {
      fs.rmSync(this.managedSkillsDir, { recursive: true, force: true });
      return;
    }

    fs.mkdirSync(this.managedSkillsDir, { recursive: true });
    const wanted = new Set(
      this.manifests.filter((item) => settings.enabled[item.id] === true).map((item) => item.id),
    );

    for (const existing of fs.readdirSync(this.managedSkillsDir, { withFileTypes: true })) {
      if (!wanted.has(existing.name)) {
        fs.rmSync(path.join(this.managedSkillsDir, existing.name), { recursive: true, force: true });
      }
    }

    for (const manifest of this.manifests) {
      if (!wanted.has(manifest.id)) continue;
      const dest = path.join(this.managedSkillsDir, manifest.id);
      fs.rmSync(dest, { recursive: true, force: true });
      copyPackContents(manifest.sourceDir, dest);
    }
  }

  /** Extra environment variables injected into `RuntimeService.envFor()` when ready. */
  envOverlay(): Record<string, string> {
    if (this.envState !== 'ready') return {};
    const python = this.venvPythonPath();
    if (!fs.existsSync(python)) return {};
    const sites = this.sitePackagesDirs();
    return {
      OPC_OFFICE_PYTHON: python,
      ...(sites.length > 0 ? { PYTHONPATH: sites.join(path.delimiter) } : {}),
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
    if (this.envState !== 'ready') return [];
    const settings = this.readSettings();
    return this.manifests
      .filter((manifest) => settings.enabled[manifest.id] === true)
      .map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        title: manifest.title,
        summary: manifest.description,
      }));
  }
}
