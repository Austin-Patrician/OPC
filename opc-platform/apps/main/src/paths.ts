import { resolveAppPaths, type AppPaths } from './env';

/** Resolved once during bootstrap, after Electron reports its userData path. */
export let appPaths: AppPaths = resolveAppPaths();

export function initAppPaths(): AppPaths {
  appPaths = resolveAppPaths();
  return appPaths;
}
