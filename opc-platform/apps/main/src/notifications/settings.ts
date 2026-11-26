import type { NotificationSettings, NotificationSettingsPatch } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';

const KEY = 'notifications';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  when: 'background',
  sound: true,
  showPreview: true,
  attentionCue: true,
  events: {
    needsAction: true,
    replies: true,
    errors: true,
  },
};

function cloneDefaults(): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    events: { ...DEFAULT_NOTIFICATION_SETTINGS.events },
  };
}

/** Merge untrusted JSON or partial updates cleanly against safe defaults. */
export function sanitizeNotificationSettings(
  raw: unknown,
  base: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
): NotificationSettings {
  if (typeof raw !== 'object' || raw === null) {
    return { ...base, events: { ...base.events } };
  }
  const input = raw as NotificationSettingsPatch;
  const rawEvents =
    typeof input.events === 'object' && input.events !== null ? input.events : undefined;

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    when: input.when === 'always' || input.when === 'background' ? input.when : base.when,
    sound: typeof input.sound === 'boolean' ? input.sound : base.sound,
    showPreview: typeof input.showPreview === 'boolean' ? input.showPreview : base.showPreview,
    attentionCue: typeof input.attentionCue === 'boolean' ? input.attentionCue : base.attentionCue,
    events: {
      needsAction:
        typeof rawEvents?.needsAction === 'boolean' ? rawEvents.needsAction : base.events.needsAction,
      replies: typeof rawEvents?.replies === 'boolean' ? rawEvents.replies : base.events.replies,
      errors: typeof rawEvents?.errors === 'boolean' ? rawEvents.errors : base.events.errors,
    },
  };
}

/**
 * Stores desktop notification preferences in the shared `app_setting` table
 * (`key = 'notifications'`) so main-process dispatch stays synchronous and durable.
 */
export class NotificationSettingsStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): NotificationSettings => {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return cloneDefaults();
    try {
      return sanitizeNotificationSettings(JSON.parse(row.value), cloneDefaults());
    } catch {
      return cloneDefaults();
    }
  };

  update = (patch: NotificationSettingsPatch): NotificationSettings => {
    const clean = sanitizeNotificationSettings(patch, this.get());
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(clean), Date.now());
    return clean;
  };
}
