import type {
  ShellExecutionSettings,
  ShellExecutionStatus,
  WindowsShellMode,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { detectBackend } from './detect';

const KEY = 'sandbox.shellExecution';

export const DEFAULT_SHELL_EXECUTION_SETTINGS: ShellExecutionSettings = {
  windowsMode: 'ask',
};

function normalizeMode(value: unknown): WindowsShellMode {
  return value === 'auto' || value === 'disabled' ? value : 'ask';
}

/**
 * Workspace-wide shell execution policy stored in `app_setting`.
 * Primarily governs Windows, where no OS-level container sandbox exists.
 */
export class ShellExecutionSettingsStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): ShellExecutionSettings => {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return { ...DEFAULT_SHELL_EXECUTION_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<ShellExecutionSettings>;
      return {
        windowsMode: normalizeMode(parsed.windowsMode),
      };
    } catch {
      return { ...DEFAULT_SHELL_EXECUTION_SETTINGS };
    }
  };

  set = (next: ShellExecutionSettings): ShellExecutionSettings => {
    const clean: ShellExecutionSettings = {
      windowsMode: normalizeMode(next.windowsMode),
    };
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(clean), Date.now());
    return clean;
  };

  status = (): ShellExecutionStatus => {
    const backend = detectBackend();
    return {
      settings: this.get(),
      platform: process.platform,
      sandboxBackend: backend.backend,
      sandboxDetail: backend.detail,
    };
  };
}
