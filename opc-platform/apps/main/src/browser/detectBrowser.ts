import fs from 'node:fs';
import path from 'node:path';
import type { DetectedBrowser } from '@opc/shared/ipc';

export interface DetectBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

interface CandidateSpec {
  id: DetectedBrowser['id'];
  name: string;
  paths: string[];
}

function normalizeDedupKey(executablePath: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(executablePath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function candidateSpecs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CandidateSpec[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || '';
    const withLocal = (subPath: string) =>
      localAppData ? [path.join(localAppData, subPath)] : [];

    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        paths: [
          path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ...withLocal(path.join('Google', 'Chrome', 'Application', 'chrome.exe')),
        ],
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        paths: [
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ...withLocal(path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')),
        ],
      },
      {
        id: 'brave',
        name: 'Brave',
        paths: [
          path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          ...withLocal(path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
        ],
      },
    ];
  }

  if (platform === 'darwin') {
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      },
      {
        id: 'brave',
        name: 'Brave',
        paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      },
      {
        id: 'chromium',
        name: 'Chromium',
        paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      },
    ];
  }

  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    {
      id: 'brave',
      name: 'Brave',
      paths: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    },
    {
      id: 'chromium',
      name: 'Chromium',
      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
  ];
}

/**
 * Discovers genuine desktop Chromium browsers already installed on the host
 * in priority order (Chrome -> Edge -> Brave -> Chromium) without spawning shells.
 */
export function detectInstalledBrowsers(options: DetectBrowserOptions = {}): DetectedBrowser[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;

  const found: DetectedBrowser[] = [];
  const seenPaths = new Set<string>();

  for (const spec of candidateSpecs(platform, env)) {
    for (const candidate of spec.paths) {
      if (!candidate) continue;
      const key = normalizeDedupKey(candidate, platform);
      if (seenPaths.has(key)) continue;
      try {
        if (!exists(candidate)) continue;
      } catch {
        continue;
      }
      seenPaths.add(key);
      found.push({
        id: spec.id,
        name: spec.name,
        executablePath: candidate,
      });
      break;
    }
  }

  return found;
}

/**
 * Resolves the user's selected browser binary or falls back to the highest-priority
 * detected real browser on the host.
 */
export function resolvePreferredBrowser(
  detected: readonly DetectedBrowser[],
  customPath?: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): DetectedBrowser | undefined {
  const trimmed = customPath?.trim();
  if (trimmed) {
    const matched = detected.find(
      (item) => normalizeDedupKey(item.executablePath, process.platform) === normalizeDedupKey(trimmed, process.platform),
    );
    if (matched) return matched;
    try {
      if (exists(trimmed)) {
        return {
          id: 'custom',
          name: path.basename(trimmed) || 'Custom Browser',
          executablePath: trimmed,
        };
      }
    } catch {
      // Ignore inaccessible custom path and fall back to detected browser.
    }
  }
  return detected[0];
}
