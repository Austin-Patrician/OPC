import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { NotificationActionEvent } from '@opc/shared/domain';
import { openCompanyDatabase } from '../data/companyDatabase';
import { NotificationSettingsStore } from './settings';
import {
  NotificationService,
  type NativeNotificationCreateOptions,
  type NativeNotificationHandle,
  type NotificationRuntimeAdapter,
} from './notificationService';

interface FakeNotificationRecord {
  options: NativeNotificationCreateOptions;
  shown: boolean;
  closed: boolean;
  emit: (event: 'click' | 'close' | 'failed') => void;
}

function createFakeRuntime(platform: 'darwin' | 'win32' | 'linux' = 'win32') {
  const created: FakeNotificationRecord[] = [];
  const badgeCounts: number[] = [];
  const bounces: string[] = [];

  const runtime: NotificationRuntimeAdapter = {
    platform,
    isSupported: () => true,
    create: (options) => {
      const listeners: Record<'click' | 'close' | 'failed', Array<() => void>> = {
        click: [],
        close: [],
        failed: [],
      };
      const record: FakeNotificationRecord = {
        options,
        shown: false,
        closed: false,
        emit: (event) => {
          for (const fn of [...listeners[event]]) fn();
        },
      };
      created.push(record);
      const handle: NativeNotificationHandle = {
        show: () => {
          record.shown = true;
        },
        close: () => {
          record.closed = true;
        },
        on: (event, listener) => {
          listeners[event].push(listener);
        },
      };
      return handle;
    },
    setBadgeCount: (count) => {
      badgeCounts.push(count);
    },
    bounceDock: (type) => {
      bounces.push(type);
    },
  };

  return { runtime, created, badgeCounts, bounces };
}

function createFakeWindow() {
  let minimized = true;
  let visible = false;
  const calls: string[] = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => {
      minimized = false;
      calls.push('restore');
    },
    show: () => {
      visible = true;
      calls.push('show');
    },
    focus: () => {
      calls.push('focus');
    },
    flashFrame: (flag: boolean) => {
      calls.push(`flash:${String(flag)}`);
    },
  };
  return { win: win as unknown as BrowserWindow, calls };
}

describe('NotificationSettingsStore', () => {
  it('persists patches in app_setting and recovers safely from corrupt JSON', () => {
    const db = openCompanyDatabase(':memory:');
    const store = new NotificationSettingsStore(db);

    expect(store.get()).toEqual({
      enabled: true,
      when: 'background',
      sound: true,
      showPreview: true,
      attentionCue: true,
      events: { needsAction: true, replies: true, errors: true },
    });

    const updated = store.update({
      when: 'always',
      showPreview: false,
      events: { replies: false },
    });
    expect(updated.when).toBe('always');
    expect(updated.showPreview).toBe(false);
    expect(updated.events).toEqual({ needsAction: true, replies: false, errors: true });
    expect(store.get()).toEqual(updated);

    db.prepare('UPDATE app_setting SET value = ? WHERE key = ?').run('{broken-json', 'notifications');
    expect(store.get().enabled).toBe(true);
    db.close();
  });
});

describe('NotificationService', () => {
  it('does nothing in headless probe mode', () => {
    const db = openCompanyDatabase(':memory:');
    const store = new NotificationSettingsStore(db);
    const fake = createFakeRuntime('win32');
    const service = new NotificationService({
      settingsStore: store,
      getAssistantName: () => 'Buddy',
      getWindow: () => null,
      getWindowState: () => ({ windowVisible: false, windowFocused: false, windowMinimized: false }),
      isHeadless: true,
      runtime: fake.runtime,
    });

    expect(service.notifyApproval({ reportId: 'r1', title: 'bash', body: 'ls' })).toBe(false);
    expect(service.sendTest()).toEqual({ ok: false, reason: 'headless' });
    expect(fake.created).toHaveLength(0);
    service.dispose();
    db.close();
  });

  it('triggers taskbar flash, focuses window and emits deep-link action on click, and clears cues on focus', () => {
    const db = openCompanyDatabase(':memory:');
    const store = new NotificationSettingsStore(db);
    const fake = createFakeRuntime('win32');
    const fakeWin = createFakeWindow();
    const actions: NotificationActionEvent[] = [];
    let nowMs = 50_000;
    let windowState = { windowVisible: false, windowFocused: false, windowMinimized: true };

    const service = new NotificationService({
      settingsStore: store,
      getAssistantName: () => '小助手',
      getWindow: () => fakeWin.win,
      getWindowState: () => windowState,
      resolveIconPath: () => 'C:\\app\\favicon.png',
      now: () => nowMs,
      runtime: fake.runtime,
    });
    service.subscribeAction((event) => actions.push(event));

    expect(
      service.notifyError({
        dedupeId: 'task-9',
        threadId: 'thread-1',
        taskId: 'task-9',
        title: '构建失败',
        body: 'exit code 1',
      }),
    ).toBe(true);

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.shown).toBe(true);
    expect(fake.created[0]?.options.icon).toBe('C:\\app\\favicon.png');
    expect(fakeWin.calls).toContain('flash:true');
    expect(fake.badgeCounts).toEqual([1]);

    // Simulate click -> restores & focuses window, clears cues, dispatches observatory deep-link.
    fake.created[0]?.emit('click');
    expect(fakeWin.calls).toEqual(['flash:true', 'restore', 'show', 'focus', 'flash:false']);
    expect(fake.badgeCounts).toEqual([1, 0]);
    expect(actions).toEqual([
      {
        category: 'error',
        target: { kind: 'observatory', threadId: 'thread-1', taskId: 'task-9' },
      },
    ]);

    // Next reply notification (past the post-error suppression window) auto-closes on focus.
    nowMs = 65_000;
    windowState = { windowVisible: false, windowFocused: false, windowMinimized: false };
    expect(service.notifyReply({ conversationId: 'dm-router', text: '处理完成了' })).toBe(true);
    expect(fake.created[1]?.closed).toBe(false);
    service.onWindowFocused();
    expect(fake.created[1]?.closed).toBe(true);

    service.dispose();
    db.close();
  });

  it('omits icon on macOS, bounces dock on urgent alerts, and lets sendTest bypass background suppression', () => {
    const db = openCompanyDatabase(':memory:');
    const store = new NotificationSettingsStore(db);
    const fake = createFakeRuntime('darwin');
    const spyIcon = vi.fn(() => '/Applications/OPC/favicon.png');
    const service = new NotificationService({
      settingsStore: store,
      getAssistantName: () => 'Buddy',
      getWindow: () => null,
      getWindowState: () => ({ windowVisible: true, windowFocused: true, windowMinimized: false }),
      resolveIconPath: spyIcon,
      runtime: fake.runtime,
    });

    service.setContext({ route: 'chat', locale: 'en-US' });
    // Suppressed in focused chat.
    expect(service.notifyReply({ conversationId: 'dm-router', text: 'hello' })).toBe(false);
    // Test notification still fires cleanly.
    expect(service.sendTest()).toEqual({ ok: true });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.options.icon).toBeUndefined();
    expect(spyIcon).not.toHaveBeenCalled();

    // Non-chat focused + urgent approval triggers Dock bounce & omits icon.
    service.setContext({ route: 'other', locale: 'en-US' });
    expect(
      service.notifyApproval({ reportId: 'rep-2', tool: 'shell', body: 'rm -rf dist' }),
    ).toBe(true);
    expect(fake.created[1]?.options.icon).toBeUndefined();

    service.dispose();
    db.close();
  });
});
