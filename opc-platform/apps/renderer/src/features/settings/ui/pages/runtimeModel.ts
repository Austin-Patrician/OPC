import type {
  BundledRuntime,
  RuntimeKind,
  RuntimeProfile,
  RuntimeSnapshot,
  RuntimeStatus,
  ShellExecutionStatus,
  WindowsShellMode,
} from '@opc/shared/domain';
import type { OcrSettings } from '@opc/shared/ocr';

export type RuntimeTab = 'node' | 'python' | 'ocr' | 'shell';

export interface InterpreterSummary {
  mode: 'auto' | 'manual';
  profile: RuntimeProfile | null;
  status: RuntimeStatus | null;
  available: boolean;
  version: string | null;
  profileCount: number;
  availableCount: number;
}

export type OverviewTone = 'green' | 'amber' | 'red' | 'gray';

export interface OcrCardSummary {
  state: 'loading' | 'missing' | 'broken' | 'on' | 'off';
  tone: OverviewTone;
  engine: BundledRuntime | null;
  detail: OcrSettings['detail'] | null;
}

export interface ShellCardSummary {
  state: 'loading' | 'windows' | 'none' | 'sandbox';
  tone: OverviewTone;
  windowsMode: WindowsShellMode | null;
  backend: ShellExecutionStatus['sandboxBackend'] | null;
}

/**
 * Mirrors backend `RuntimeService.activeFor` semantics:
 * - An explicitly selected profile stays selected even if broken.
 * - Auto-select picks the first available profile of the given kind.
 */
export function summarizeInterpreter(
  snapshot: RuntimeSnapshot | null,
  kind: RuntimeKind,
): InterpreterSummary {
  if (!snapshot) {
    return {
      mode: 'auto',
      profile: null,
      status: null,
      available: false,
      version: null,
      profileCount: 0,
      availableCount: 0,
    };
  }

  const profiles = snapshot.profiles.filter((entry) => entry.kind === kind);
  const statusById = new Map(snapshot.statuses.map((entry) => [entry.profileId, entry]));
  const availableCount = profiles.filter((entry) => statusById.get(entry.id)?.available).length;
  const activeId = snapshot.active[kind];
  const preferred = activeId ? (profiles.find((entry) => entry.id === activeId) ?? null) : null;

  if (preferred) {
    const status = statusById.get(preferred.id) ?? null;
    return {
      mode: 'manual',
      profile: preferred,
      status,
      available: Boolean(status?.available),
      version: status?.version ?? null,
      profileCount: profiles.length,
      availableCount,
    };
  }

  const autoPicked = profiles.find((entry) => statusById.get(entry.id)?.available) ?? null;
  const autoStatus = autoPicked ? (statusById.get(autoPicked.id) ?? null) : null;
  return {
    mode: 'auto',
    profile: autoPicked,
    status: autoStatus,
    available: Boolean(autoStatus?.available),
    version: autoStatus?.version ?? null,
    profileCount: profiles.length,
    availableCount,
  };
}

export function summarizeOcrCard(
  bundled: readonly BundledRuntime[] | null,
  ocr: OcrSettings | null,
): OcrCardSummary {
  if (ocr === null || bundled === null) {
    return { state: 'loading', tone: 'gray', engine: null, detail: null };
  }
  const engine = bundled[0] ?? null;
  if (!engine) {
    return { state: 'missing', tone: 'red', engine: null, detail: ocr.detail };
  }
  if (engine.state !== 'ok') {
    return { state: 'broken', tone: 'red', engine, detail: ocr.detail };
  }
  return {
    state: ocr.enabled ? 'on' : 'off',
    tone: ocr.enabled ? 'green' : 'gray',
    engine,
    detail: ocr.detail,
  };
}

export function summarizeShellCard(shell: ShellExecutionStatus | null): ShellCardSummary {
  if (!shell) {
    return { state: 'loading', tone: 'gray', windowsMode: null, backend: null };
  }
  if (shell.sandboxBackend === 'windows-guarded') {
    const mode = shell.settings.windowsMode;
    const tone: OverviewTone = mode === 'ask' ? 'green' : mode === 'auto' ? 'amber' : 'gray';
    return {
      state: 'windows',
      tone,
      windowsMode: mode,
      backend: shell.sandboxBackend,
    };
  }
  if (shell.sandboxBackend === 'none') {
    return {
      state: 'none',
      tone: 'amber',
      windowsMode: null,
      backend: 'none',
    };
  }
  return {
    state: 'sandbox',
    tone: 'green',
    windowsMode: null,
    backend: shell.sandboxBackend,
  };
}

export function binaryPathPlaceholder(kind: RuntimeKind, platform?: string): string {
  if (platform === 'win32') {
    return kind === 'node'
      ? 'C:\\Program Files\\nodejs\\node.exe'
      : 'C:\\Users\\me\\project\\.venv\\Scripts\\python.exe';
  }
  return kind === 'node'
    ? '/Users/me/.nvm/versions/node/v22.0.0/bin/node'
    : '/Users/me/.venv/bin/python';
}
