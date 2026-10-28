import path from 'node:path';
import type {
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfile,
  RuntimeProfileDraft,
  RuntimeSnapshot,
  RuntimeState,
  RuntimeStatus,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { NetworkClient } from '../network/networkClient';
import {
  isExecutableFile,
  probeVersion as defaultProbeVersion,
  realBinaryPath,
  resolveBuiltinBinary,
  runtimeSearchDirs,
  type VersionProbe,
} from './detect';
import {
  BUILTIN_PROFILES,
  buildCustomProfile,
  deriveEnvironment,
  isRuntimeKind,
  normalizeStoredProfile,
  RUNTIME_ACTIVE_KEY,
  RUNTIME_PROFILES_KEY,
} from './profiles';
import { removeShims, shimDirFor, writeShims } from './shims';

const KINDS: readonly RuntimeKind[] = ['node', 'python'];
const VERSION_TTL_MS = 60_000;

/** A profile plus the parts only a probe can know. */
export interface ResolvedRuntime {
  profile: RuntimeProfile;
  /** Resolved, executable interpreter; absent when the profile is unusable. */
  binary?: string;
  detail?: string;
  sandboxRoots: string[];
}

export interface RuntimeServiceOptions {
  /** App-owned directory; shim symlinks live under `<userData>/runtimes/`. */
  userDataDir: string;
  /** Supplies the proxy-aware child environment. */
  network?: NetworkClient;
  /** Test seam: defaults to PATH + the usual install locations. */
  searchDirs?: string[];
  /** Test seam: defaults to spawning `--version` with a 3s timeout. */
  probeVersion?: (binary: string, kind: RuntimeKind) => Promise<VersionProbe>;
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function labelOf(kind: RuntimeKind): string {
  return kind === 'node' ? 'Node' : 'Python';
}

/**
 * The company-wide base environment.
 *
 * All employees share it: there is no per-employee or per-task override, so a
 * single settings change takes effect on the next tool call. Resolution is cheap
 * (file existence); version detection is cached and only runs for the settings
 * page.
 */
export class RuntimeService {
  private readonly searchDirs: string[];
  private readonly probeVersion: (binary: string, kind: RuntimeKind) => Promise<VersionProbe>;
  private readonly versions = new Map<string, { probe: VersionProbe; at: number }>();
  /** Profile + binary → shim dir. Rewriting symlinks on every tool call would race. */
  private readonly shims = new Map<string, string>();

  constructor(
    private readonly db: CompanyDatabase,
    private readonly options: RuntimeServiceOptions,
  ) {
    this.searchDirs = options.searchDirs ?? runtimeSearchDirs();
    this.probeVersion = options.probeVersion ?? defaultProbeVersion;
  }

  // ── persistence ────────────────────────────────────────────────────────

  private readSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private writeSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  private customProfiles(): RuntimeProfile[] {
    const raw = this.readSetting(RUNTIME_PROFILES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const builtinIds = new Set(BUILTIN_PROFILES.map((profile) => profile.id));
      const seen = new Set<string>();
      const result: RuntimeProfile[] = [];
      for (const entry of parsed) {
        const profile = normalizeStoredProfile(entry);
        if (!profile || builtinIds.has(profile.id) || seen.has(profile.id)) continue;
        seen.add(profile.id);
        result.push(profile);
      }
      return result;
    } catch {
      // A corrupt blob must not take the settings page down.
      return [];
    }
  }

  private persistCustom(profiles: readonly RuntimeProfile[]): void {
    this.writeSetting(RUNTIME_PROFILES_KEY, JSON.stringify(profiles));
  }

  private rawActive(): Record<RuntimeKind, string | null> {
    const fallback: Record<RuntimeKind, string | null> = { node: null, python: null };
    const raw = this.readSetting(RUNTIME_ACTIVE_KEY);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        node: typeof parsed.node === 'string' ? parsed.node : null,
        python: typeof parsed.python === 'string' ? parsed.python : null,
      };
    } catch {
      return fallback;
    }
  }

  private sanitizedActive(profiles: readonly RuntimeProfile[]): Record<RuntimeKind, string | null> {
    const ids = new Set(profiles.map((profile) => profile.id));
    const raw = this.rawActive();
    return {
      node: raw.node && ids.has(raw.node) ? raw.node : null,
      python: raw.python && ids.has(raw.python) ? raw.python : null,
    };
  }

  // ── catalogue ──────────────────────────────────────────────────────────

  listProfiles = (): RuntimeProfile[] => [...BUILTIN_PROFILES, ...this.customProfiles()];

  getState = (): RuntimeState => {
    const profiles = this.listProfiles();
    return { profiles, active: this.sanitizedActive(profiles) };
  };

  /**
   * Cheap resolution: does the profile point at an executable right now?
   * Version detection is deliberately separate so tool calls never spawn a probe.
   */
  resolveProfile = (profile: RuntimeProfile): ResolvedRuntime => {
    const binary = resolveBuiltinBinary(profile, this.searchDirs);
    if (!binary) {
      return {
        profile,
        detail: `未找到 ${labelOf(profile.kind)} 解释器`,
        sandboxRoots: [],
      };
    }
    if (!isExecutableFile(binary)) {
      return { profile, detail: `不可执行：${binary}`, sandboxRoots: [] };
    }
    const real = realBinaryPath(binary);
    return { profile, binary: real, sandboxRoots: this.sandboxRootsFor(profile, real) };
  };

  private sandboxRootsFor(profile: RuntimeProfile, binary: string): string[] {
    const roots = new Set<string>([path.dirname(binary)]);
    if (profile.binary) roots.add(path.dirname(profile.binary));
    for (const dir of profile.binDirs) roots.add(dir);
    // `<prefix>/bin/python` needs `<prefix>` readable too (stdlib, site-packages).
    for (const dir of [...roots]) {
      if (path.basename(dir) === 'bin') roots.add(path.dirname(dir));
    }
    roots.add(shimDirFor(this.options.userDataDir, profile.id));
    roots.delete(path.parse(binary).root);
    return [...roots];
  };

  /**
   * The profile in force for a language.
   *
   * An explicitly selected profile never silently falls back: if it is broken the
   * caller gets a resolved runtime without a binary, and `envFor` shadows the
   * command with a failing shim. Only a *dangling* selection (profile deleted)
   * falls back to the first usable built-in.
   */
  activeFor = (kind: RuntimeKind): ResolvedRuntime | null => {
    const profiles = this.listProfiles().filter((profile) => profile.kind === kind);
    if (profiles.length === 0) return null;
    const activeId = this.sanitizedActive(this.listProfiles())[kind];
    const preferred = activeId ? profiles.find((profile) => profile.id === activeId) : undefined;

    if (preferred) return this.resolveProfile(preferred);

    for (const profile of profiles) {
      const resolved = this.resolveProfile(profile);
      if (resolved.binary) return resolved;
    }
    return null;
  };

  // ── probing ────────────────────────────────────────────────────────────

  private async probeFor(
    profile: RuntimeProfile,
    resolved: ResolvedRuntime,
    force: boolean,
  ): Promise<VersionProbe> {
    if (profile.id === 'node-bundled') {
      return { ok: true, version: process.versions.node, detail: 'Electron 内置' };
    }
    if (!resolved.binary) return { ok: false, detail: resolved.detail ?? '解释器不可用' };

    const key = `${profile.id}::${resolved.binary}`;
    const cached = this.versions.get(key);
    if (!force && cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.probe;

    const probe = await this.probeVersion(resolved.binary, profile.kind);
    this.versions.set(key, { probe, at: Date.now() });
    return probe;
  }

  private async statusFor(profile: RuntimeProfile, force: boolean): Promise<RuntimeStatus> {
    const resolved = this.resolveProfile(profile);
    const probe = await this.probeFor(profile, resolved, force);
    const detail = probe.detail ?? resolved.detail;
    return {
      profileId: profile.id,
      available: Boolean(resolved.binary) && probe.ok,
      ...(resolved.binary ? { binary: resolved.binary } : {}),
      ...(probe.version ? { version: probe.version } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  snapshot = async (force = false): Promise<RuntimeSnapshot> => {
    const profiles = this.listProfiles();
    if (force) this.versions.clear();
    const statuses = await Promise.all(profiles.map((profile) => this.statusFor(profile, force)));
    return { profiles, active: this.sanitizedActive(profiles), statuses };
  };

  probe = (): Promise<RuntimeSnapshot> => this.snapshot(true);

  // ── mutations ──────────────────────────────────────────────────────────

  setActive = (kind: RuntimeKind, profileId: string | null): RuntimeState => {
    if (!isRuntimeKind(kind)) throw new Error('运行环境类型只能是 node 或 python');
    const profiles = this.listProfiles();
    if (profileId) {
      const target = profiles.find((profile) => profile.id === profileId);
      if (!target) throw new Error('未知运行环境');
      if (target.kind !== kind) throw new Error('运行环境类型不匹配');
    }

    const active = this.rawActive();
    active[kind] = profileId || null;
    this.writeSetting(RUNTIME_ACTIVE_KEY, JSON.stringify(active));
    return { profiles, active: this.sanitizedActive(profiles) };
  };

  /** Adds a custom profile and makes it current: choosing a file is the intent. */
  saveProfile = (draft: RuntimeProfileDraft): RuntimeState => {
    const profile = buildCustomProfile(draft);
    const custom = this.customProfiles();
    const duplicate = custom.find(
      (entry) =>
        entry.kind === profile.kind &&
        realBinaryPath(entry.binary) === realBinaryPath(profile.binary),
    );

    if (!duplicate) {
      this.persistCustom([...custom, profile]);
      this.versions.clear();
      this.shims.clear();
    }

    const target = duplicate ?? profile;
    const active = this.rawActive();
    active[target.kind] = target.id;
    this.writeSetting(RUNTIME_ACTIVE_KEY, JSON.stringify(active));
    const profiles = this.listProfiles();
    return { profiles, active: this.sanitizedActive(profiles) };
  };

  removeProfile = (profileId: string): RuntimeState => {
    const custom = this.customProfiles();
    const target = custom.find((profile) => profile.id === profileId);
    if (!target) {
      if (BUILTIN_PROFILES.some((profile) => profile.id === profileId)) {
        throw new Error('内置运行环境不可删除，只能切换');
      }
      return this.getState();
    }

    this.persistCustom(custom.filter((profile) => profile.id !== profileId));
    const active = this.rawActive();
    for (const kind of KINDS) {
      if (active[kind] === profileId) active[kind] = null;
    }
    this.writeSetting(RUNTIME_ACTIVE_KEY, JSON.stringify(active));
    removeShims(this.options.userDataDir, profileId);
    this.versions.clear();
    this.shims.clear();
    return this.getState();
  };

  /** Preview an interpreter before saving it (version + derived venv env). */
  inspect = async (draft: { kind: RuntimeKind; binary: string }): Promise<RuntimeInspection> => {
    if (!isRuntimeKind(draft.kind)) throw new Error('运行环境类型只能是 node 或 python');
    const binary = typeof draft.binary === 'string' ? draft.binary.trim() : '';
    if (!binary || !path.isAbsolute(binary)) throw new Error('解释器必须是绝对路径');
    if (!isExecutableFile(binary)) {
      return {
        ok: false,
        binary,
        detail: '文件不存在或不可执行',
        binDirs: [],
        env: {},
      };
    }

    const real = realBinaryPath(binary);
    const derived = deriveEnvironment(binary);
    const probe = await this.probeVersion(real, draft.kind);
    return {
      ok: probe.ok,
      // Keep the selected path, not its realpath: a venv's `bin/python` is a
      // symlink, and saving the target would lose VIRTUAL_ENV / binDirs.
      binary: path.resolve(binary),
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.detail ? { detail: probe.detail } : {}),
      binDirs: derived.binDirs,
      env: derived.env,
    };
  };

  // ── execution ──────────────────────────────────────────────────────────

  private ensureShims(
    profileId: string,
    kind: RuntimeKind,
    binary: string | undefined,
    message?: string,
  ): string {
    const key = `${profileId}::${binary ?? ''}::${message ?? ''}`;
    const cached = this.shims.get(key);
    if (cached !== undefined) return cached;
    const dir = writeShims(this.options.userDataDir, profileId, kind, binary, message);
    this.shims.set(key, dir);
    return dir;
  }

  /**
   * The child environment every tool and command should inherit.
   *
   * PATH order: shims for the active interpreters, their bin directories, then
   * whatever the app inherited. Node and Python coexist, so a polyglot task does
   * not need to switch environments halfway.
   */
  envFor = (kinds: readonly RuntimeKind[] = KINDS): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...(this.options.network ? this.options.network.childEnv() : process.env),
    };
    const dirs: string[] = [];
    const overlay: Record<string, string> = {};

    for (const kind of KINDS) {
      if (!kinds.includes(kind)) continue;
      const resolved = this.activeFor(kind);

      if (!resolved?.binary) {
        // No usable interpreter: a failing shim reports the reason instead of
        // letting the command reach an unrelated interpreter on the host PATH.
        const message = resolved?.detail ?? `未配置可用的 ${labelOf(kind)} 环境`;
        const broken = this.ensureShims(`unavailable-${kind}`, kind, undefined, message);
        if (broken) dirs.push(broken);
        continue;
      }

      const shim = this.ensureShims(
        resolved.profile.id,
        kind,
        resolved.binary,
      );
      if (shim) dirs.push(shim);
      dirs.push(path.dirname(resolved.binary));
      for (const dir of resolved.profile.binDirs) dirs.push(dir);
      Object.assign(overlay, resolved.profile.env);

      if (kind === 'node') {
        // `undefined` (not delete) beats pi's `{...process.env, ...shellEnv}`
        // merge: the own key hides the app's own NODE_OPTIONS / Electron flag.
        env.NODE_OPTIONS = undefined;
        env.ELECTRON_RUN_AS_NODE = undefined;
        if (resolved.profile.id === 'node-bundled') overlay.ELECTRON_RUN_AS_NODE = '1';
      } else {
        env.PYTHONHOME = undefined;
        env.PYTHONPATH = undefined;
        // An inherited venv must not leak into a system-Python profile; a venv
        // profile re-adds these through `overlay` below.
        env.VIRTUAL_ENV = undefined;
        env.CONDA_PREFIX = undefined;
        env.CONDA_DEFAULT_ENV = undefined;
        env.PIP_REQUIRE_VIRTUALENV = undefined;
        overlay.PYTHONUNBUFFERED = overlay.PYTHONUNBUFFERED ?? '1';
        overlay.PYTHONIOENCODING = overlay.PYTHONIOENCODING ?? 'utf-8';
        overlay.PYTHONDONTWRITEBYTECODE = overlay.PYTHONDONTWRITEBYTECODE ?? '1';
        if (overlay.VIRTUAL_ENV) {
          overlay.PIP_REQUIRE_VIRTUALENV = overlay.PIP_REQUIRE_VIRTUALENV ?? 'true';
        }
      }
    }

    Object.assign(env, overlay);
    const key = pathKeyOf(env);
    const merged = uniquePaths([...dirs, env[key] ?? '']);
    if (merged.length > 0) env[key] = merged.join(path.delimiter);
    return env;
  };

  /** `undefined` keeps `runCommand`'s legacy Electron-node fallback. */
  acceptanceEnv = (): NodeJS.ProcessEnv | undefined => {
    const resolved = this.activeFor('node');
    if (!resolved?.binary) return undefined;
    return this.envFor(['node']);
  };

  sandboxRoots = (): string[] => {
    const roots: string[] = [];
    for (const kind of KINDS) {
      const resolved = this.activeFor(kind);
      if (!resolved) continue;
      if (resolved.profile.id) {
        roots.push(shimDirFor(this.options.userDataDir, resolved.profile.id));
      }
      roots.push(...resolved.sandboxRoots);
    }
    return uniquePaths(roots);
  };
}
