import { describe, expect, it } from 'vitest';
import {
  classifyDesktopActionRisk,
  DEFAULT_DESKTOP_APPROVALS,
  isAppBlocked,
} from './policy';

describe('desktop app blacklist policy', () => {
  it('allows all apps when blockedApps is empty', () => {
    expect(isAppBlocked('Keychain Access', [])).toBe(false);
    expect(isAppBlocked({ app: 'WeChat', bundleId: 'com.tencent.xinWeChat' }, [])).toBe(false);
  });

  it('matches names case-insensitively and across CN/EN aliases and bundle IDs', () => {
    expect(isAppBlocked('Keychain Access', ['钥匙串访问'])).toBe(true);
    expect(isAppBlocked({ app: '微信', bundleId: 'com.tencent.xinWeChat' }, ['wechat'])).toBe(true);
    expect(isAppBlocked({ app: 'System Settings.app' }, ['系统设置'])).toBe(true);
    expect(isAppBlocked({ app: 'Notes', bundleId: 'com.apple.Notes' }, ['钥匙串访问'])).toBe(false);
  });
});

describe('desktop high-risk action classification', () => {
  it('flags send/submit actions, destructive deletions, payments, and quit actions by default', () => {
    expect(
      classifyDesktopActionRisk(
        {
          action: 'click',
          app: 'WeChat',
          refMeta: { ref: '@s1:e5', role: 'button', name: '发送', app: 'WeChat' },
        },
        DEFAULT_DESKTOP_APPROVALS,
      ),
    ).toMatchObject({ risky: true, category: 'send-message' });

    expect(
      classifyDesktopActionRisk(
        {
          action: 'click',
          refMeta: { ref: '@s1:e8', role: 'button', name: '移到废纸篓', app: 'Finder' },
        },
        DEFAULT_DESKTOP_APPROVALS,
      ),
    ).toMatchObject({ risky: true, category: 'destructive' });

    expect(
      classifyDesktopActionRisk(
        { action: 'click', refMeta: { ref: '@s1:e9', role: 'button', name: '立即支付 ¥199' } },
        DEFAULT_DESKTOP_APPROVALS,
      ),
    ).toMatchObject({ risky: true, category: 'payment' });

    expect(
      classifyDesktopActionRisk({ action: 'press', combo: 'cmd+q', app: 'Notes' }, DEFAULT_DESKTOP_APPROVALS),
    ).toMatchObject({ risky: true, category: 'quit-app' });

    expect(
      classifyDesktopActionRisk({ action: 'close-app', app: 'Notes' }, DEFAULT_DESKTOP_APPROVALS),
    ).toMatchObject({ risky: true, category: 'quit-app' });
  });

  it('respects user category toggles including optional system-settings guard', () => {
    expect(
      classifyDesktopActionRisk(
        { action: 'click', app: 'System Settings', refMeta: { ref: '@s1:e1', name: '隐私' } },
        DEFAULT_DESKTOP_APPROVALS,
      ),
    ).toEqual({ risky: false });

    expect(
      classifyDesktopActionRisk(
        { action: 'click', app: 'System Settings', refMeta: { ref: '@s1:e1', name: '隐私' } },
        ['system-settings'],
      ),
    ).toMatchObject({ risky: true, category: 'system-settings' });

    expect(
      classifyDesktopActionRisk(
        { action: 'snapshot', app: 'System Settings' },
        ['system-settings'],
      ),
    ).toEqual({ risky: false });
  });
});
