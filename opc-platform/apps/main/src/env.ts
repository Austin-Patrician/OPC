import path from 'node:path';
import { app } from 'electron';

/**
 * All filesystem locations in one place. `packages/*` never calls `app.getPath`
 * itself — the main process injects these paths (design doc §2.2).
 */
export interface AppPaths {
  userData: string;
  database: string;
  agentsDir: string;
  artifactsDir: string;
  workspaceDir: string;
  logsDir: string;
  /** Scratch area for diagnostics that must not pollute real data. */
  probeDir: string;
  /**
   * Disposable cache (`cache/cache.db`). Unlike `userData` proper, deleting this
   * directory is a supported operation — see `apps/main/src/cache/`.
   */
  cacheDir: string;
}

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  return {
    userData,
    database: path.join(userData, 'company.db'),
    agentsDir: path.join(userData, 'agents'),
    artifactsDir: path.join(userData, 'artifacts'),
    workspaceDir: path.join(userData, 'workspace'),
    logsDir: path.join(userData, 'logs'),
    probeDir: path.join(userData, 'diagnostics'),
    cacheDir: path.join(userData, 'cache'),
  };
}
