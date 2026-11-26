import type {
  NotificationCategory,
  NotificationLocale,
  NotificationRouteScope,
  NotificationSettings,
} from '@opc/shared/domain';

export const REPLY_COOLDOWN_MS = 8_000;
export const ERROR_COOLDOWN_MS = 10_000;
export const ERROR_SUPPRESSES_REPLY_MS = 10_000;
export const DEDUPE_TTL_MS = 10 * 60 * 1000;
export const PREVIEW_MAX_CHARS = 120;

export interface NotificationWindowContext {
  windowVisible: boolean;
  windowFocused: boolean;
  windowMinimized: boolean;
  route: NotificationRouteScope;
  locale: NotificationLocale;
}

export type NotificationDecision =
  | { deliver: true }
  | {
      deliver: false;
      reason:
        | 'disabled'
        | 'category_disabled'
        | 'focused_chat'
        | 'focused_non_urgent'
        | 'duplicate'
        | 'suppressed_after_error'
        | 'cooldown';
    };

/** Returns true when the main window is visible, unminimized, and focused by the user. */
export function isWindowActivelyFocused(window: Pick<NotificationWindowContext, 'windowVisible' | 'windowFocused' | 'windowMinimized'>): boolean {
  return window.windowFocused && window.windowVisible && !window.windowMinimized;
}

/** Strips Markdown formatting noise and clamps preview body length for OS toasts. */
export function sanitizePreviewText(raw: string, maxChars = PREVIEW_MAX_CHARS): string {
  if (!raw) return '';
  let text = raw
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>+|\*|-|\d+\.)\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  }
  return text;
}

/** Maps a notification category to its settings toggle. */
export function isCategoryEnabled(
  settings: NotificationSettings,
  category: NotificationCategory,
): boolean {
  switch (category) {
    case 'approval':
    case 'question':
      return settings.events.needsAction;
    case 'reply':
      return settings.events.replies;
    case 'error':
      return settings.events.errors;
  }
}

/**
 * Pure delivery gate balancing timely intervention with zero notification spam.
 * Blocking actions (`approval`, `question`) and `error` still surface when the window
 * is focused on non-chat views (e.g. Settings) in default `background` mode.
 */
export function shouldDeliverNotification(input: {
  settings: NotificationSettings;
  category: NotificationCategory;
  window: NotificationWindowContext;
  dedupeKey?: string;
  now: number;
  recentDedupeAt: ReadonlyMap<string, number>;
  lastSentByCategory: ReadonlyMap<NotificationCategory, number>;
}): NotificationDecision {
  const { settings, category, window, dedupeKey, now, recentDedupeAt, lastSentByCategory } = input;

  if (!settings.enabled) {
    return { deliver: false, reason: 'disabled' };
  }
  if (!isCategoryEnabled(settings, category)) {
    return { deliver: false, reason: 'category_disabled' };
  }

  if (settings.when === 'background' && isWindowActivelyFocused(window)) {
    if (window.route === 'chat') {
      return { deliver: false, reason: 'focused_chat' };
    }
    if (category === 'reply') {
      return { deliver: false, reason: 'focused_non_urgent' };
    }
  }

  if (dedupeKey) {
    const previousAt = recentDedupeAt.get(dedupeKey);
    if (previousAt !== undefined && now - previousAt < DEDUPE_TTL_MS) {
      return { deliver: false, reason: 'duplicate' };
    }
  }

  if (category === 'reply') {
    const lastErrorAt = lastSentByCategory.get('error');
    if (lastErrorAt !== undefined && now - lastErrorAt < ERROR_SUPPRESSES_REPLY_MS) {
      return { deliver: false, reason: 'suppressed_after_error' };
    }
    const lastReplyAt = lastSentByCategory.get('reply');
    if (lastReplyAt !== undefined && now - lastReplyAt < REPLY_COOLDOWN_MS) {
      return { deliver: false, reason: 'cooldown' };
    }
  }

  if (category === 'error') {
    const lastErrorAt = lastSentByCategory.get('error');
    if (lastErrorAt !== undefined && now - lastErrorAt < ERROR_COOLDOWN_MS) {
      return { deliver: false, reason: 'cooldown' };
    }
  }

  return { deliver: true };
}

/** Formats localized title and privacy-respecting body copy for OS notifications. */
export function formatNotificationCopy(input: {
  category: NotificationCategory;
  locale: NotificationLocale;
  assistantName: string;
  showPreview: boolean;
  title?: string;
  body?: string;
  tool?: string;
}): { title: string; body: string } {
  const name = input.assistantName.trim() || 'Buddy';
  const en = input.locale === 'en-US';
  const cleanedBody = sanitizePreviewText(input.body ?? '');
  const cleanedTitle = sanitizePreviewText(input.title ?? '');
  const cleanedTool = sanitizePreviewText(input.tool ?? '', 40);

  switch (input.category) {
    case 'approval': {
      const title = en ? `${name} · Approval required` : `${name} · 等待你的审批`;
      if (!input.showPreview) {
        return {
          title,
          body: en
            ? 'An action is waiting for your approval. Click to review.'
            : '有一项操作正在等待你的审批，点击查看。',
        };
      }
      const detail = cleanedBody || cleanedTitle;
      const body = cleanedTool && detail
        ? `[${cleanedTool}] ${detail}`
        : detail || (cleanedTool ? `[${cleanedTool}]` : (en ? 'An operation needs your approval' : '有操作需要你的确认'));
      return { title, body: sanitizePreviewText(body) };
    }
    case 'question': {
      const title = en ? `${name} · Needs your input` : `${name} · 需要你的确认`;
      if (!input.showPreview) {
        return {
          title,
          body: en
            ? 'A running task needs your reply. Click to respond.'
            : '任务执行中需要你补充信息，点击回复。',
        };
      }
      return {
        title,
        body: cleanedBody || cleanedTitle || (en ? 'A worker is waiting for your reply' : '执行体正在等待你的回复'),
      };
    }
    case 'reply': {
      const title = name;
      if (!input.showPreview) {
        return {
          title,
          body: en ? 'You have a new reply. Click to view.' : '收到一条新回复，点击查看。',
        };
      }
      return {
        title,
        body: cleanedBody || (en ? 'Sent you a new message' : '发来一条新消息'),
      };
    }
    case 'error': {
      const title = en ? `${name} · Task attention needed` : `${name} · 任务异常`;
      if (!input.showPreview) {
        return {
          title,
          body: en
            ? 'A background task encountered an issue. Click to inspect.'
            : '有后台任务出现异常，点击查看详情。',
        };
      }
      const combined = cleanedTitle && cleanedBody && cleanedTitle !== cleanedBody
        ? `${cleanedTitle}: ${cleanedBody}`
        : cleanedBody || cleanedTitle;
      return {
        title,
        body: combined
          ? sanitizePreviewText(combined)
          : (en ? 'A task failed. Click to inspect.' : '任务执行异常，请检查执行透视'),
      };
    }
  }
}

/** Copy used by the "Send test notification" settings button. */
export function formatTestNotificationCopy(
  locale: NotificationLocale,
  assistantName: string,
): { title: string; body: string } {
  const name = assistantName.trim() || 'Buddy';
  if (locale === 'en-US') {
    return {
      title: `${name} · Test notification`,
      body: 'Desktop notifications are working. Click to bring the workspace to focus.',
    };
  }
  return {
    title: `${name} · 通知测试`,
    body: '桌面通知工作正常，点击可唤起工作台窗口。',
  };
}
