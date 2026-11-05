import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * Watchdog 自己的模型（`11-watchdog-spec.md` W5 的「独立模型配置」）。
 *
 * 为什么单独配：它干的是低频、短输入、要求"少说话"的活，和写代码的执行体
 * 需要的模型不是一个取舍。用默认 LLM 也能跑，但那是"能用"，不是"配好了"。
 *
 * 存储用 `app_setting` 而不是 `ModelDefaults`：角色表（llm/router/image/…）
 * 是给"谁的活用什么模型"用的，Watchdog 现在还没到需要一整套角色 UI 的体量；
 * 一个单值引用够用，也不会在删 Provider 时留下悬空角色。
 */

export interface WatchdogModelRef {
  providerId: string;
  modelId: string;
}

const KEY = 'watchdog.model';

export function readWatchdogModel(db: CompanyDatabase): WatchdogModelRef | null {
  try {
    const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as { providerId?: unknown; modelId?: unknown };
    if (typeof parsed.providerId !== 'string' || typeof parsed.modelId !== 'string') return null;
    if (!parsed.providerId || !parsed.modelId) return null;
    return { providerId: parsed.providerId, modelId: parsed.modelId };
  } catch {
    return null;
  }
}

export class WatchdogModelStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): WatchdogModelRef | null => readWatchdogModel(this.db);

  /** `null` = 回到默认 LLM。 */
  set = (ref: WatchdogModelRef | null): WatchdogModelRef | null => {
    if (!ref) {
      this.db.prepare('DELETE FROM app_setting WHERE key = ?').run(KEY);
      return null;
    }
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify({ providerId: ref.providerId, modelId: ref.modelId }), Date.now());
    return this.get();
  };
}
