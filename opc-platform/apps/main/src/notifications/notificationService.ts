import { randomUUID } from 'node:crypto';
import { app, Notification, type BrowserWindow } from 'electron';
import type {
  NotificationActionEvent,
  NotificationCategory,
  NotificationContextUpdate,
  NotificationLocale,
  NotificationRouteScope,
  NotificationSettingsPatch,
  NotificationStatus,
} from '@opc/shared/domain';
import {
  DEDUPE_TTL_MS,
  formatNotificationCopy,
  formatTestNotificationCopy,
  isWindowActivelyFocused,
  shouldDeliverNotification,
  type NotificationWindowContext,
} from './notificationPolicy';
import type { NotificationSettingsStore } from './settings';

export interface NativeNotificationHandle {
  show(): void;
  close(): void;
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
}

export interface NativeNotificationCreateOptions {
  title: string;
  body: string;
  silent: boolean;
  icon?: string;
  urgency?: 'normal' | 'critical' | 'low';
}

export interface NotificationRuntimeAdapter {
  platform: 'darwin' | 'win32' | 'linux';
  isSupported(): boolean;
  create(options: NativeNotificationCreateOptions): NativeNotificationHandle;
  setBadgeCount(count: number): void;
  bounceDock(type: 'critical' | 'informational'): void;
}

function normalizePlatform(raw: NodeJS.Platform): 'darwin' | 'win32' | 'linux' {
  if (raw === 'darwin' || raw === 'win32') return raw;
  return 'linux';
}

function createElectronRuntimeAdapter(): NotificationRuntimeAdapter {
  const platform = normalizePlatform(process.platform);
  return {
    platform,
    isSupported: () => Notification.isSupported(),
    create: (options) =>
      new Notification({
        title: options.title,
        body: options.body,
        silent: options.silent,
        ...(options.icon ? { icon: options.icon } : {}),
        ...(options.urgency ? { urgency: options.urgency } : {}),
      }),
    setBadgeCount: (count) => {
      try {
        app.setBadgeCount(count);
      } catch {
        // Ignore platforms without badge support.
      }
    },
    bounceDock: (type) => {
      try {
        app.dock?.bounce(type);
      } catch {
        // Ignore on non-macOS platforms.
      }
    },
  };
}

export interface NotificationServiceOptions {
  settingsStore: NotificationSettingsStore;
  getAssistantName: () => string;
  getWindow: () => BrowserWindow | null;
  getWindowState: () => Pick<NotificationWindowContext, 'windowVisible' | 'windowFocused' | 'windowMinimized'>;
  isHeadless?: boolean;
  resolveIconPath?: () => string | undefined;
  now?: () => number;
  runtime?: NotificationRuntimeAdapter;
}

/**
 * Coordinates OS desktop notifications, GC keep-alive references, click-to-focus
 * deep linking, and taskbar/Dock attention cues from the main process.
 */
export class NotificationService {
  private readonly runtime: NotificationRuntimeAdapter;
  private readonly now: () => number;
  private route: NotificationRouteScope = 'chat';
  private locale: NotificationLocale = 'zh-CN';
  /** Keep native instances strongly referenced until close/fail so V8 GC never drops `click`. */
  private readonly activeNotifications = new Map<
    string,
    { handle: NativeNotificationHandle; category: NotificationCategory }
  >();
  private readonly recentDedupeAt = new Map<string, number>();
  private readonly lastSentByCategory = new Map<NotificationCategory, number>();
  private unreadCount = 0;
  private readonly actionListeners = new Set<(event: NotificationActionEvent) => void>();

  constructor(private readonly options: NotificationServiceOptions) {
    this.runtime = options.runtime ?? createElectronRuntimeAdapter();
    this.now = options.now ?? (() => Date.now());
  }

  getStatus = (): NotificationStatus => ({
    supported: this.runtime.isSupported(),
    platform: this.runtime.platform,
    settings: this.options.settingsStore.get(),
  });

  updateSettings = (patch: NotificationSettingsPatch): NotificationStatus => {
    const settings = this.options.settingsStore.update(patch);
    if (!settings.enabled || !settings.attentionCue) {
      this.clearAttentionCues();
    }
    return {
      supported: this.runtime.isSupported(),
      platform: this.runtime.platform,
      settings,
    };
  };

  setContext = (context: NotificationContextUpdate): void => {
    if (context.route === 'chat' || context.route === 'other') {
      this.route = context.route;
    }
    if (context.locale === 'zh-CN' || context.locale === 'en-US') {
      this.locale = context.locale;
    }
    if (context.route === 'chat' && isWindowActivelyFocused(this.options.getWindowState())) {
      this.clearAttentionCues();
      this.closeReplyNotifications();
    }
  };

  subscribeAction = (listener: (event: NotificationActionEvent) => void): (() => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  notifyApproval = (input: {
    reportId: string;
    threadId?: string;
    taskId?: string;
    title?: string;
    body?: string;
    tool?: string;
  }): boolean => {
    return this.dispatch({
      category: 'approval',
      dedupeKey: `approval:${input.reportId}`,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      action: { category: 'approval', target: { kind: 'chat' } },
    });
  };

  notifyQuestion = (input: {
    reportId: string;
    threadId?: string;
    taskId?: string;
    title?: string;
    body?: string;
  }): boolean => {
    return this.dispatch({
      category: 'question',
      dedupeKey: `question:${input.reportId}`,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      action: { category: 'question', target: { kind: 'chat' } },
    });
  };

  notifyReply = (input: { conversationId: string; text: string }): boolean => {
    if (!input.text.trim()) return false;
    return this.dispatch({
      category: 'reply',
      dedupeKey: undefined,
      body: input.text,
      action: {
        category: 'reply',
        target: { kind: 'chat', conversationId: input.conversationId },
      },
    });
  };

  notifyError = (input: {
    dedupeId: string;
    threadId?: string;
    taskId?: string;
    title?: string;
    body?: string;
  }): boolean => {
    const target: NotificationActionEvent['target'] = input.threadId
      ? {
          kind: 'observatory',
          threadId: input.threadId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
        }
      : { kind: 'chat' };
    return this.dispatch({
      category: 'error',
      dedupeKey: `error:${input.dedupeId}`,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      action: { category: 'error', target },
    });
  };

  sendTest = (): { ok: boolean; reason?: string } => {
    if (this.options.isHeadless) {
      return { ok: false, reason: 'headless' };
    }
    if (!this.runtime.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    const settings = this.options.settingsStore.get();
    const copy = formatTestNotificationCopy(this.locale, this.options.getAssistantName());
    const shown = this.spawnNativeNotification({
      category: 'reply',
      title: copy.title,
      body: copy.body,
      silent: !settings.sound,
      action: { category: 'reply', target: { kind: 'chat' } },
    });
    return shown ? { ok: true } : { ok: false, reason: 'spawn_failed' };
  };

  onWindowFocused = (): void => {
    this.clearAttentionCues();
    if (this.route === 'chat') {
      this.closeReplyNotifications();
    }
  };

  dispose = (): void => {
    for (const { handle } of this.activeNotifications.values()) {
      try {
        handle.close();
      } catch {
        // Ignore teardown close errors.
      }
    }
    this.activeNotifications.clear();
    this.actionListeners.clear();
    this.recentDedupeAt.clear();
    this.lastSentByCategory.clear();
    this.clearAttentionCues();
  };

  private dispatch(input: {
    category: NotificationCategory;
    dedupeKey: string | undefined;
    title?: string;
    body?: string;
    tool?: string;
    action: NotificationActionEvent;
  }): boolean {
    if (this.options.isHeadless || !this.runtime.isSupported()) return false;

    const settings = this.options.settingsStore.get();
    const windowState = this.options.getWindowState();
    const windowContext: NotificationWindowContext = {
      ...windowState,
      route: this.route,
      locale: this.locale,
    };
    const now = this.now();

    const decision = shouldDeliverNotification({
      settings,
      category: input.category,
      window: windowContext,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      now,
      recentDedupeAt: this.recentDedupeAt,
      lastSentByCategory: this.lastSentByCategory,
    });
    if (!decision.deliver) return false;

    const copy = formatNotificationCopy({
      category: input.category,
      locale: this.locale,
      assistantName: this.options.getAssistantName(),
      showPreview: settings.showPreview,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
    });

    const shown = this.spawnNativeNotification({
      category: input.category,
      title: copy.title,
      body: copy.body,
      silent: !settings.sound,
      action: input.action,
    });
    if (!shown) return false;

    this.lastSentByCategory.set(input.category, now);
    if (input.dedupeKey) {
      this.recentDedupeAt.set(input.dedupeKey, now);
      this.pruneDedupeCache(now);
    }

    if (settings.attentionCue && !isWindowActivelyFocused(windowState)) {
      this.triggerAttentionCues(input.category);
    }

    return true;
  }

  private spawnNativeNotification(input: {
    category: NotificationCategory;
    title: string;
    body: string;
    silent: boolean;
    action: NotificationActionEvent;
  }): boolean {
    try {
      // macOS already shows the app bundle icon; passing `icon` adds a redundant badge thumbnail.
      const icon =
        this.runtime.platform !== 'darwin' ? this.options.resolveIconPath?.() : undefined;
      const urgency =
        this.runtime.platform === 'linux'
          ? input.category === 'reply'
            ? 'normal'
            : 'critical'
          : undefined;

      const handle = this.runtime.create({
        title: input.title,
        body: input.body,
        silent: input.silent,
        ...(icon ? { icon } : {}),
        ...(urgency ? { urgency } : {}),
      });

      const id = randomUUID();
      this.activeNotifications.set(id, { handle, category: input.category });

      handle.on('click', () => {
        this.activeNotifications.delete(id);
        this.focusMainWindow();
        this.onWindowFocused();
        for (const listener of this.actionListeners) {
          listener(input.action);
        }
      });
      handle.on('close', () => {
        this.activeNotifications.delete(id);
      });
      handle.on('failed', () => {
        this.activeNotifications.delete(id);
      });

      handle.show();
      return true;
    } catch {
      return false;
    }
  }

  private focusMainWindow(): void {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  private triggerAttentionCues(category: NotificationCategory): void {
    this.unreadCount += 1;
    this.runtime.setBadgeCount(this.unreadCount);

    const win = this.options.getWindow();
    if (this.runtime.platform === 'win32' && win && !win.isDestroyed()) {
      try {
        win.flashFrame(true);
      } catch {
        // Ignore window flash errors.
      }
    } else if (this.runtime.platform === 'darwin' && category !== 'reply') {
      this.runtime.bounceDock('informational');
    }
  }

  private clearAttentionCues(): void {
    this.unreadCount = 0;
    this.runtime.setBadgeCount(0);
    const win = this.options.getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.flashFrame(false);
      } catch {
        // Ignore flash reset errors.
      }
    }
  }

  private closeReplyNotifications(): void {
    for (const [id, entry] of [...this.activeNotifications.entries()]) {
      if (entry.category !== 'reply') continue;
      this.activeNotifications.delete(id);
      try {
        entry.handle.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  private pruneDedupeCache(now: number): void {
    if (this.recentDedupeAt.size <= 200) return;
    for (const [key, at] of this.recentDedupeAt.entries()) {
      if (now - at >= DEDUPE_TTL_MS) {
        this.recentDedupeAt.delete(key);
      }
    }
  }
}
