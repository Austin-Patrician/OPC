import { describe, expect, it } from 'vitest';
import type { NotificationCategory, NotificationSettings } from '@opc/shared/domain';
import {
  formatNotificationCopy,
  formatTestNotificationCopy,
  sanitizePreviewText,
  shouldDeliverNotification,
  type NotificationWindowContext,
} from './notificationPolicy';
import { DEFAULT_NOTIFICATION_SETTINGS } from './settings';

function makeWindow(overrides: Partial<NotificationWindowContext> = {}): NotificationWindowContext {
  return {
    windowVisible: true,
    windowFocused: false,
    windowMinimized: false,
    route: 'chat',
    locale: 'zh-CN',
    ...overrides,
  };
}

function makeSettings(
  overrides: Partial<Omit<NotificationSettings, 'events'>> & {
    events?: Partial<NotificationSettings['events']>;
  } = {},
): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...overrides,
    events: {
      ...DEFAULT_NOTIFICATION_SETTINGS.events,
      ...(overrides.events ?? {}),
    },
  };
}

describe('shouldDeliverNotification', () => {
  it('blocks when global toggle or category toggle is off', () => {
    const emptyMap = new Map<string, number>();
    const emptyCat = new Map<NotificationCategory, number>();

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ enabled: false }),
        category: 'approval',
        window: makeWindow(),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: false, reason: 'disabled' });

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ events: { needsAction: false } }),
        category: 'question',
        window: makeWindow(),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: false, reason: 'category_disabled' });

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ events: { replies: false } }),
        category: 'reply',
        window: makeWindow(),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: false, reason: 'category_disabled' });
  });

  it('suppresses notifications on focused /chat in background mode, but delivers urgent ones on /settings', () => {
    const emptyMap = new Map<string, number>();
    const emptyCat = new Map<NotificationCategory, number>();

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'background' }),
        category: 'approval',
        window: makeWindow({ windowFocused: true, route: 'chat' }),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: false, reason: 'focused_chat' });

    // Focused on non-chat route: ordinary replies stay quiet, blocking prompts/errors deliver.
    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'background' }),
        category: 'reply',
        window: makeWindow({ windowFocused: true, route: 'other' }),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: false, reason: 'focused_non_urgent' });

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'background' }),
        category: 'approval',
        window: makeWindow({ windowFocused: true, route: 'other' }),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: true });

    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'background' }),
        category: 'error',
        window: makeWindow({ windowFocused: true, route: 'other' }),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: true });

    // Minimized window counts as background even if windowFocused wasn't flipped yet.
    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'background' }),
        category: 'reply',
        window: makeWindow({ windowFocused: true, windowMinimized: true, route: 'chat' }),
        now: 100_000,
        recentDedupeAt: emptyMap,
        lastSentByCategory: emptyCat,
      }),
    ).toEqual({ deliver: true });
  });

  it('delivers even on focused /chat when set to "always"', () => {
    expect(
      shouldDeliverNotification({
        settings: makeSettings({ when: 'always' }),
        category: 'reply',
        window: makeWindow({ windowFocused: true, route: 'chat' }),
        now: 100_000,
        recentDedupeAt: new Map(),
        lastSentByCategory: new Map(),
      }),
    ).toEqual({ deliver: true });
  });

  it('deduplicates keys, applies reply/error cooldowns, suppresses reply right after error, and never throttles distinct approvals', () => {
    const dedupe = new Map<string, number>([['approval:rep-1', 90_000]]);
    const cats = new Map<NotificationCategory, number>([
      ['reply', 96_000],
      ['error', 94_000],
    ]);

    expect(
      shouldDeliverNotification({
        settings: makeSettings(),
        category: 'approval',
        window: makeWindow(),
        dedupeKey: 'approval:rep-1',
        now: 100_000,
        recentDedupeAt: dedupe,
        lastSentByCategory: cats,
      }),
    ).toEqual({ deliver: false, reason: 'duplicate' });

    // Distinct blocking question is NOT throttled even right after prior notifications.
    expect(
      shouldDeliverNotification({
        settings: makeSettings(),
        category: 'question',
        window: makeWindow(),
        dedupeKey: 'question:rep-2',
        now: 100_000,
        recentDedupeAt: dedupe,
        lastSentByCategory: cats,
      }),
    ).toEqual({ deliver: true });

    // Reply suppressed right after error.
    expect(
      shouldDeliverNotification({
        settings: makeSettings(),
        category: 'reply',
        window: makeWindow(),
        now: 100_000,
        recentDedupeAt: dedupe,
        lastSentByCategory: cats,
      }),
    ).toEqual({ deliver: false, reason: 'suppressed_after_error' });

    // Reply cooldown after error suppression window passes.
    expect(
      shouldDeliverNotification({
        settings: makeSettings(),
        category: 'reply',
        window: makeWindow(),
        now: 101_000,
        recentDedupeAt: dedupe,
        lastSentByCategory: new Map([['reply', 98_000]]),
      }),
    ).toEqual({ deliver: false, reason: 'cooldown' });
  });
});

describe('sanitizePreviewText & formatNotificationCopy', () => {
  it('strips markdown formatting and truncates cleanly', () => {
    const raw = '## 报告完成\n请查看 [交付文件](file:///a.md) 和 `status=ok`\n```ts\nconsole.log(1)\n```\n后续建议继续观察。';
    const cleaned = sanitizePreviewText(raw, 28);
    expect(cleaned).not.toContain('##');
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('file:///');
    expect(cleaned.length).toBeLessThanOrEqual(28);
    expect(cleaned.endsWith('…')).toBe(true);
  });

  it('masks previews when showPreview is false and localizes both zh-CN and en-US', () => {
    const zhHidden = formatNotificationCopy({
      category: 'reply',
      locale: 'zh-CN',
      assistantName: '小助手',
      showPreview: false,
      body: '机密财务数据 9999 万',
    });
    expect(zhHidden.title).toBe('小助手');
    expect(zhHidden.body).not.toContain('9999');

    const enApproval = formatNotificationCopy({
      category: 'approval',
      locale: 'en-US',
      assistantName: 'Buddy',
      showPreview: true,
      tool: 'bash',
      body: 'Run `pnpm test` in workspace',
    });
    expect(enApproval.title).toBe('Buddy · Approval required');
    expect(enApproval.body).toContain('[bash]');
    expect(enApproval.body).toContain('Run pnpm test in workspace');

    const testCopy = formatTestNotificationCopy('en-US', 'Buddy');
    expect(testCopy.title).toContain('Test notification');
  });
});
