import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * Watchdog 的规则（`11-watchdog-spec.md` W7）。
 *
 * 为什么这些数要能改：它们全是**代价**的旋钮。判得勤 = 花更多模型调用；
 * 冷却长 = 少打扰但慢半拍；阈值严 = 少误报但漏得早。哪个合适取决于这台机器
 * 跑的是什么活，所以它属于设置，不属于代码。
 *
 * 两条纪律：
 *
 * 1. **保存即确认。** 这是设置页，不是聊天——按"保存"就是人点过头了。
 * 2. **留上一版。** 回退不是"恢复默认"，是"回到我改之前"。默认值只在你从没
 *    改过的时候才是对的。
 */

export interface WatchdogPolicy {
  /** 总开关。关掉之后子进程照常跑（证据还在），但不再报警、不再调模型。 */
  enabled: boolean;
  /** 运行中的任务多久没有新动作算停住。 */
  idleTaskMs: number;
  /** 同一个动作失败几次算原地打转。 */
  repeatFailure: number;
  /** 主进程心跳多久没更新算不响应。 */
  staleMainMs: number;
  /** 持续多久从 active 升到 rechecking。 */
  recheckAfterMs: number;
  /** 再多久升到 escalated（= 要人看）。 */
  escalateAfterMs: number;
  /** 同一条 incident 两次语义判断的间隔。 */
  judgeCooldownMs: number;
  /** 同一条 incident 两次动作请求的间隔。 */
  actionCooldownMs: number;
}

export interface WatchdogPolicyView extends WatchdogPolicy {
  /** 这一版是什么时候存的；`null` = 从没改过，正在用默认值。 */
  updatedAt: number | null;
  /** 是否存在可回退的上一版。 */
  hasPrevious: boolean;
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  enabled: true,
  idleTaskMs: 30 * 60_000,
  repeatFailure: 3,
  staleMainMs: 90_000,
  recheckAfterMs: 2 * 60_000,
  escalateAfterMs: 15 * 60_000,
  judgeCooldownMs: 30 * 60_000,
  actionCooldownMs: 10 * 60_000,
};

const KEY = 'watchdog.policy';
const PREVIOUS_KEY = 'watchdog.policy.previous';
/** 最近若干版，只用于审计；回退仍然只回上一版。 */
const HISTORY_KEY = 'watchdog.policy.history';
const HISTORY_LIMIT = 10;

const MINUTE = 60_000;

/** 范围写死在这里，界面上也照着写：改到一个会让它失灵的数是更糟的结果。 */
function minutes(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function normalizeWatchdogPolicy(raw: unknown): WatchdogPolicy {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WatchdogPolicy>;
  return {
    enabled: input.enabled !== false,
    idleTaskMs: minutes(input.idleTaskMs, DEFAULT_WATCHDOG_POLICY.idleTaskMs, 5 * MINUTE, 24 * 60 * MINUTE),
    repeatFailure:
      typeof input.repeatFailure === 'number' && Number.isFinite(input.repeatFailure)
        ? Math.round(Math.min(20, Math.max(2, input.repeatFailure)))
        : DEFAULT_WATCHDOG_POLICY.repeatFailure,
    staleMainMs: minutes(input.staleMainMs, DEFAULT_WATCHDOG_POLICY.staleMainMs, 30_000, 30 * MINUTE),
    recheckAfterMs: minutes(input.recheckAfterMs, DEFAULT_WATCHDOG_POLICY.recheckAfterMs, MINUTE, 6 * 60 * MINUTE),
    escalateAfterMs: minutes(
      input.escalateAfterMs,
      DEFAULT_WATCHDOG_POLICY.escalateAfterMs,
      2 * MINUTE,
      24 * 60 * MINUTE,
    ),
    judgeCooldownMs: minutes(
      input.judgeCooldownMs,
      DEFAULT_WATCHDOG_POLICY.judgeCooldownMs,
      MINUTE,
      24 * 60 * MINUTE,
    ),
    actionCooldownMs: minutes(
      input.actionCooldownMs,
      DEFAULT_WATCHDOG_POLICY.actionCooldownMs,
      MINUTE,
      24 * 60 * MINUTE,
    ),
  };
}

/** 子进程用：它读同一个 `app_setting`，但只读。读不到就当默认——它没有迁移权。 */
export function readWatchdogPolicy(db: CompanyDatabase): WatchdogPolicy {
  try {
    const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return DEFAULT_WATCHDOG_POLICY;
    return normalizeWatchdogPolicy(JSON.parse(row.value));
  } catch {
    // 表不存在（老库、探针的临时库）或 JSON 坏了：默认值比"崩掉观测者"好。
    return DEFAULT_WATCHDOG_POLICY;
  }
}

export class WatchdogPolicyStore {
  constructor(
    private readonly db: CompanyDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  view = (): WatchdogPolicyView => ({
    ...readWatchdogPolicy(this.db),
    updatedAt: this.updatedAt(KEY),
    hasPrevious: this.read(PREVIOUS_KEY) !== null,
  });

  /** 保存 = 确认。当前这一版先存成"上一版"，再写新值；两步在同一个事务里。 */
  save = (patch: unknown): WatchdogPolicyView => {
    const current = readWatchdogPolicy(this.db);
    const next = normalizeWatchdogPolicy({ ...current, ...(patch as Partial<WatchdogPolicy>) });
    this.db.transaction(() => {
      this.pushHistory(current);
      this.write(PREVIOUS_KEY, JSON.stringify(current));
      this.write(KEY, JSON.stringify(next));
    })();
    return this.view();
  };

  /** 回到上一版。没有上一版就什么都不做——不拿默认值冒充"你的上一版"。 */
  rollback = (): WatchdogPolicyView => {
    const previous = this.read(PREVIOUS_KEY);
    if (!previous) return this.view();
    const current = readWatchdogPolicy(this.db);
    this.db.transaction(() => {
      this.pushHistory(current);
      this.write(PREVIOUS_KEY, JSON.stringify(current));
      this.write(KEY, previous);
    })();
    return this.view();
  };

  /** 审计用：最近改过的几版（新的在前）。 */
  history = (): { at: number; policy: WatchdogPolicy }[] => {
    const raw = this.read(HISTORY_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { at?: unknown; policy?: unknown }[];
      return parsed.map((entry) => ({
        at: typeof entry.at === 'number' ? entry.at : 0,
        policy: normalizeWatchdogPolicy(entry.policy),
      }));
    } catch {
      return [];
    }
  };

  private pushHistory(policy: WatchdogPolicy): void {
    const list = [{ at: this.now(), policy }, ...this.history()].slice(0, HISTORY_LIMIT);
    this.write(HISTORY_KEY, JSON.stringify(list));
  }

  private read(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  private updatedAt(key: string): number | null {
    const row = this.db.prepare('SELECT updated_at FROM app_setting WHERE key = ?').get(key) as
      | { updated_at: number }
      | undefined;
    return row?.updated_at ?? null;
  }
}
