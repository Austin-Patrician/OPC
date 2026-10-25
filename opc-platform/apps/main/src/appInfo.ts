import type { AppInfo } from '@opc/shared/ipc';
import { app } from 'electron';
import { appPaths } from './paths';

export function getAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform as AppInfo['platform'],
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    userDataPath: appPaths.userData,
  };
}
