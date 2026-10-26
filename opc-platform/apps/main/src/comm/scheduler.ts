import type { InboxItem } from '../data/commRepository';
import type { CommService } from './commService';

export interface WakeInput {
  employeeId: string;
  /** Everything waiting for this employee, already claimed for the run. */
  items: readonly InboxItem[];
  /** `heartbeat` = its turn came up; `signal` = someone needed it now; `manual` = the boss. */
  reason: 'heartbeat' | 'signal' | 'manual';
  now: number;
}

/** A signalled message should not wait for the next heartbeat tick. */
const NUDGE_MS = 50;

export interface ManualWakeResult {
  ok: boolean;
  message: string;
  items: number;
}

export interface TickResult {
  /** Employees whose batch was handed to a run in this tick. */
  woken: { employeeId: string; reason: WakeInput['reason']; items: number }[];
  /** Employees with waiting work that was left for later, and why. */
  skipped: { employeeId: string; pending: number; reason: 'not_due' }[];
}

export interface CommSchedulerDeps {
  comm: CommService;
  /** Runs one employee with its claim; must not throw for a single bad employee. */
  onWake: (input: WakeInput) => Promise<void> | void;
  /** Injected so tests can drive the clock instead of sleeping. */
  now?: () => number;
}

/**
 * The heartbeat (§10.3, P5).
 *
 * Cost control is the whole design here: an employee with an empty inbox is not
 * woken at all, so an idle company costs zero tokens. An employee with work is woken
 * when something marked `requires_wake` arrived (a colleague or a manager needs it
 * now) or when its heartbeat is due — never on every tick.
 *
 * Last-wake times are in memory on purpose: after a restart the first tick wakes
 * whoever has work, which is the recovery behaviour we want. Nothing is lost by it,
 * because the work itself is in `inbox_item`.
 */
export class CommScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastWakeAt = new Map<string, number>();

  constructor(private readonly deps: CommSchedulerDeps) {}

  start(intervalMs = this.deps.comm.settings.heartbeatMs): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error('heartbeat tick failed', error));
    }, intervalMs);
    this.timer.unref?.();
  }

  /** A signal arrived: run one tick soon, coalescing bursts (a boss @ wakes people now). */
  nudge = (): void => {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.tick().catch((error) => console.error('nudged tick failed', error));
    }, NUDGE_MS);
    this.nudgeTimer.unref?.();
  };

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
  }

  /** One pass over every active employee. Exported for probes and tests. */
  tick = async (): Promise<TickResult> => {
    const now = this.deps.now?.() ?? Date.now();
    const settings = this.deps.comm.settings;
    const result: TickResult = { woken: [], skipped: [] };

    for (const employee of this.deps.comm.activeEmployees()) {
      const pending = this.deps.comm.inbox(employee.id);
      if (pending.length === 0) continue;

      const signalled = pending.some((item) => item.requiresWake);
      const last = this.lastWakeAt.get(employee.id);
      const due = last === undefined || now - last >= settings.heartbeatMs;
      if (!signalled && !due) {
        result.skipped.push({ employeeId: employee.id, pending: pending.length, reason: 'not_due' });
        continue;
      }

      const items = this.deps.comm.claim(employee.id, now);
      if (items.length === 0) continue;

      this.lastWakeAt.set(employee.id, now);
      const reason: WakeInput['reason'] = signalled ? 'signal' : 'heartbeat';
      try {
        await this.deps.onWake({ employeeId: employee.id, items, reason, now });
      } catch (error) {
        // A failed run must not strand its items: put them back for the next tick.
        this.deps.comm.requeue(employee.id, now);
        console.error(`wake failed for ${employee.id}`, error);
        continue;
      }
      result.woken.push({ employeeId: employee.id, reason, items: items.length });
    }

    return result;
  };

  /** Test seam: forget the heartbeat clock so the next tick is due. */
  resetClock(): void {
    this.lastWakeAt.clear();
  }

  /**
   * 老板手动唤醒一个人 (§7.2 P0: 老板特权，不计配额).
   *
   * Same claim → run path as the heartbeat, so the items are marked processing and a
   * failure puts them back. Not gated by quota or the heartbeat clock on purpose: the
   * boss asking *is* the highest-priority signal there is.
   */
  wakeNow = async (employeeId: string): Promise<ManualWakeResult> => {
    const now = this.deps.now?.() ?? Date.now();
    if (this.deps.comm.inbox(employeeId).length === 0) {
      return { ok: false, message: '这个人现在没有待办', items: 0 };
    }

    const items = this.deps.comm.claim(employeeId, now);
    if (items.length === 0) {
      return { ok: false, message: '待办刚被处理掉了', items: 0 };
    }

    this.lastWakeAt.set(employeeId, now);
    try {
      await this.deps.onWake({ employeeId, items, reason: 'manual', now });
    } catch (error) {
      this.deps.comm.requeue(employeeId, now);
      return {
        ok: false,
        message: `唤醒失败：${error instanceof Error ? error.message : String(error)}`,
        items: 0,
      };
    }

    return { ok: true, message: `已唤醒，处理了 ${items.length} 条`, items: items.length };
  };
}
