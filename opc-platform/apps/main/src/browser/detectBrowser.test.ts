import { describe, expect, it } from 'vitest';
import { detectInstalledBrowsers, resolvePreferredBrowser } from './detectBrowser';

describe('detectInstalledBrowsers', () => {
  it('Windows 下按 Chrome -> Edge -> Brave 优先级探测并去重', () => {
    const existing = new Set([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\demo\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]);

    const found = detectInstalledBrowsers({
      platform: 'win32',
      env: {
        ProgramW6432: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
      },
      exists: (candidate) => existing.has(candidate),
    });

    expect(found.map((item) => item.id)).toEqual(['chrome', 'edge', 'brave']);
    expect(found[0]?.name).toBe('Google Chrome');
    expect(found[1]?.name).toBe('Microsoft Edge');
  });

  it('macOS 与 Linux 下正确识别常见真实浏览器路径', () => {
    const macFound = detectInstalledBrowsers({
      platform: 'darwin',
      exists: (candidate) =>
        candidate === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' ||
        candidate === '/Applications/Chromium.app/Contents/MacOS/Chromium',
    });
    expect(macFound.map((item) => item.id)).toEqual(['edge', 'chromium']);

    const linuxFound = detectInstalledBrowsers({
      platform: 'linux',
      exists: (candidate) => candidate === '/usr/bin/google-chrome-stable',
    });
    expect(linuxFound).toEqual([
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePath: '/usr/bin/google-chrome-stable',
      },
    ]);
  });

  it('resolvePreferredBrowser 优先匹配自定义路径并在不存在时回退到探测列表首位', () => {
    const detected = [
      { id: 'chrome' as const, name: 'Google Chrome', executablePath: 'C:\\Chrome\\chrome.exe' },
      { id: 'edge' as const, name: 'Microsoft Edge', executablePath: 'C:\\Edge\\msedge.exe' },
    ];

    expect(resolvePreferredBrowser(detected)?.id).toBe('chrome');
    expect(resolvePreferredBrowser(detected, 'C:\\Edge\\msedge.exe')?.id).toBe('edge');
    expect(
      resolvePreferredBrowser(detected, 'D:\\Custom\\chromium.exe', (p) => p === 'D:\\Custom\\chromium.exe'),
    ).toEqual({
      id: 'custom',
      name: 'chromium.exe',
      executablePath: 'D:\\Custom\\chromium.exe',
    });
    expect(resolvePreferredBrowser(detected, 'D:\\Missing\\chrome.exe', () => false)?.id).toBe('chrome');
  });
});
