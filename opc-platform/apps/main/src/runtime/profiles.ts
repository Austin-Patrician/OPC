import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeKind, RuntimeProfile, RuntimeProfileDraft } from '@opc/shared/domain';

/** JSON blobs in `app_setting`: no table for a handful of global choices. */
export const RUNTIME_PROFILES_KEY = 'runtime.profiles';
export const RUNTIME_ACTIVE_KEY = 'runtime.active';

const MAX_NAME = 40;
const MAX_BINARY = 1_024;
const MAX_BIN_DIRS = 16;
const MAX_ENV_KEYS = 32;

/**
 * Built-ins come from code, never from the database: a catalog update can then
 * improve detection without leaving stale rows behind.
 */
export const BUILTIN_PROFILES: readonly RuntimeProfile[] = [
  {
    id: 'node-system',
    name: '系统 Node',
    kind: 'node',
    binary: '',
    binDirs: [],
    env: {},
    isCustom: false,
    createdAt: 0,
  },
  {
    id: 'node-bundled',
    name: '内置 Node（Electron）',
    kind: 'node',
    binary: '',
    binDirs: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    isCustom: false,
    createdAt: 0,
  },
  {
    id: 'python-system',
    name: '系统 Python 3',
    kind: 'python',
    binary: '',
    binDirs: [],
    env: {},
    isCustom: false,
    createdAt: 0,
  },
];

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === 'node' || value === 'python';
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export interface DerivedProfile {
  binary: string;
  binDirs: string[];
  env: Record<string, string>;
}

/**
 * A venv/conda interpreter carries its environment in its layout, not in a flag:
 * `env/bin/python` next to `pyvenv.cfg` is a venv, next to `conda-meta` a conda
 * env. Deriving `VIRTUAL_ENV` here means the settings page only asks for a file.
 */
export function deriveEnvironment(binary: string): DerivedProfile {
  const resolved = path.resolve(binary.trim());
  const binDir = path.dirname(resolved);
  const binDirs = [binDir];
  const env: Record<string, string> = {};

  if (path.basename(binDir) === 'bin') {
    const root = path.dirname(binDir);
    if (isFile(path.join(root, 'pyvenv.cfg'))) {
      env.VIRTUAL_ENV = root;
      env.PIP_REQUIRE_VIRTUALENV = 'true';
    } else if (isDir(path.join(root, 'conda-meta'))) {
      env.CONDA_PREFIX = root;
      env.CONDA_DEFAULT_ENV = path.basename(root);
    }
  }

  // NODE_OPTIONS / PYTHON* are cleared at spawn time, not stored per profile.
  return { binary: resolved, binDirs, env };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return isFile(file);
  } catch {
    return false;
  }
}

function defaultName(kind: RuntimeKind, binary: string): string {
  const binDir = path.dirname(binary);
  const root = path.basename(binDir) === 'bin' ? path.dirname(binDir) : binDir;
  const label = path.basename(root) || path.basename(binary);
  return `${kind === 'node' ? 'Node' : 'Python'} · ${label}`.slice(0, MAX_NAME);
}

/** Validates a renderer draft and turns it into a persisted profile. Throws with a user-facing message. */
export function buildCustomProfile(draft: RuntimeProfileDraft): RuntimeProfile {
  if (!isRuntimeKind(draft.kind)) throw new Error('运行环境类型只能是 node 或 python');
  const binary = typeof draft.binary === 'string' ? draft.binary.trim() : '';
  if (!binary) throw new Error('请选择解释器');
  if (binary.length > MAX_BINARY) throw new Error('解释器路径过长');
  if (!path.isAbsolute(binary)) throw new Error('解释器必须是绝对路径');
  if (!isExecutable(binary)) throw new Error(`解释器不可执行：${binary}`);

  const name = (typeof draft.name === 'string' ? draft.name.trim() : '').slice(0, MAX_NAME);
  const derived = deriveEnvironment(binary);
  return {
    id: `rt-${crypto.randomUUID()}`,
    name: name || defaultName(draft.kind, derived.binary),
    kind: draft.kind,
    binary: derived.binary,
    binDirs: derived.binDirs,
    env: derived.env,
    isCustom: true,
    createdAt: Date.now(),
  };
}

/** Defensive read of `runtime.profiles`: one bad row must not break the settings page. */
export function normalizeStoredProfile(raw: unknown): RuntimeProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const kind = value.kind;
  const binary = typeof value.binary === 'string' ? value.binary.trim() : '';
  if (!id || !id.startsWith('rt-') || !isRuntimeKind(kind) || !path.isAbsolute(binary)) return null;

  const binDirs = Array.isArray(value.binDirs)
    ? value.binDirs
        .filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry))
        .slice(0, MAX_BIN_DIRS)
    : [];
  const env: Record<string, string> = {};
  if (value.env && typeof value.env === 'object') {
    for (const [key, entry] of Object.entries(value.env as Record<string, unknown>).slice(0, MAX_ENV_KEYS)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string') continue;
      env[key] = entry.slice(0, 2_048);
    }
  }

  const name = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_NAME) : '';
  return {
    id,
    name: name || defaultName(kind, binary),
    kind,
    binary,
    binDirs: binDirs.length > 0 ? binDirs : [path.dirname(binary)],
    env,
    isCustom: true,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
  };
}
