import crypto from 'node:crypto';
import type { CompanyDatabase } from './companyDatabase';
import { COMPANY_ID } from './schema';

/** 0 = boss instruction, 1 = manager/report, 2 = peer, 3 = small talk (§7.2). */
export type InboxPriority = 0 | 1 | 2 | 3;
export type InboxSourceType = 'message' | 'task' | 'approval' | 'system';
export type InboxStatus = 'pending' | 'processing' | 'done' | 'dropped';
export type GuardKind = 'wake_quota' | 'turn_limit' | 'dm_rate' | 'message_dropped';
export type RelationshipKind = 'colleague' | 'manager' | 'report' | 'collaborator';

export interface InboxItem {
  id: string;
  employeeId: string;
  sourceType: InboxSourceType;
  sourceId: string;
  conversationId?: string;
  priority: InboxPriority;
  status: InboxStatus;
  /** True when the recipient should be woken now instead of at the next heartbeat. */
  requiresWake: boolean;
  createdAt: number;
  processedAt?: number;
}

export interface WakeQuota {
  employeeId: string;
  quotaDate: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface GuardEvent {
  id: string;
  employeeId: string;
  kind: GuardKind;
  detail: Record<string, unknown>;
  conversationId?: string;
  createdAt: number;
}

export interface Relationship {
  id: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  kind: RelationshipKind;
  strength: number;
  interactionCount: number;
  lastInteractionAt?: number;
  note?: string;
}

/** How much a single exchange is worth: §6.1 L6 grows slowly, never jumps. */
const STRENGTH_PER_INTERACTION = 0.05;
const MAX_STRENGTH = 1;

interface InboxRow {
  id: string;
  employee_id: string;
  source_type: string;
  source_id: string;
  conversation_id: string | null;
  priority: number;
  status: string;
  requires_wake: number;
  created_at: number;
  processed_at: number | null;
}

interface RelationshipRow {
  id: string;
  from_employee_id: string;
  to_employee_id: string;
  kind: string;
  strength: number;
  interaction_count: number;
  last_interaction_at: number | null;
  note: string | null;
}

interface GuardRow {
  id: string;
  employee_id: string;
  kind: string;
  detail: string;
  conversation_id: string | null;
  created_at: number;
  dismissed_at: number | null;
}

/** `YYYY-MM-DD` in local time: the quota day the boss thinks in. */
export function quotaDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * The four communication tables.
 *
 * Every method takes `now` where time matters, because the behaviour being tested
 * (a quota rolling over at midnight, a one-hour rate window) is entirely about
 * time — a repository that reads the clock itself cannot be tested honestly.
 */
export class CommRepository {
  constructor(private readonly db: CompanyDatabase) {}

  /** Queues one item. Returns undefined when the same source is already pending. */
  enqueue = (input: {
    employeeId: string;
    sourceType: InboxSourceType;
    sourceId: string;
    conversationId?: string;
    priority: InboxPriority;
    requiresWake: boolean;
    now: number;
  }): InboxItem | undefined => {
    const id = `inbox-${crypto.randomUUID()}`;
    const result = this.db
      .prepare(
        `INSERT INTO inbox_item (id, employee_id, source_type, source_id, conversation_id,
                                 priority, status, requires_wake, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(employee_id, source_type, source_id) WHERE status = 'pending' DO NOTHING`,
      )
      .run(
        id,
        input.employeeId,
        input.sourceType,
        input.sourceId,
        input.conversationId ?? null,
        input.priority,
        input.requiresWake ? 1 : 0,
        input.now,
      );
    if (result.changes === 0) return undefined;
    return this.get(id);
  };

  get = (id: string): InboxItem | undefined => {
    const row = this.db.prepare('SELECT * FROM inbox_item WHERE id = ?').get(id) as
      | InboxRow
      | undefined;
    return row ? toInboxItem(row) : undefined;
  };

  /** Waiting work, most important first — the order a heartbeat run consumes. */
  pending = (employeeId: string): InboxItem[] =>
    (
      this.db
        .prepare(
          `SELECT * FROM inbox_item
            WHERE employee_id = ? AND status = 'pending'
            ORDER BY priority ASC, created_at ASC`,
        )
        .all(employeeId) as InboxRow[]
    ).map(toInboxItem);

  pendingCount = (employeeId: string): number =>
    (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM inbox_item WHERE employee_id = ? AND status = 'pending'")
        .get(employeeId) as { n: number }
    ).n;

  /** Every employee's waiting work, for the boss's notification view. */
  pendingAll = (limit = 200): InboxItem[] =>
    (
      this.db
        .prepare(
          `SELECT * FROM inbox_item WHERE status = 'pending'
            ORDER BY priority ASC, created_at ASC LIMIT ?`,
        )
        .all(limit) as InboxRow[]
    ).map(toInboxItem);

  /**
   * Claims a batch for one run. Marking `processing` before the run is what makes
   * a crash safe: a second scheduler tick cannot start the same items twice.
   */
  claim = (employeeId: string, limit: number, now: number): InboxItem[] => {
    const batch = this.db
      .prepare(
        `SELECT * FROM inbox_item
          WHERE employee_id = ? AND status = 'pending'
          ORDER BY priority ASC, created_at ASC
          LIMIT ?`,
      )
      .all(employeeId, limit) as InboxRow[];
    if (batch.length === 0) return [];

    const mark = this.db.prepare(
      "UPDATE inbox_item SET status = 'processing', processed_at = ? WHERE id = ? AND status = 'pending'",
    );
    const run = this.db.transaction(() => {
      for (const row of batch) mark.run(now, row.id);
    });
    run();

    return batch.map((row) => ({ ...toInboxItem(row), status: 'processing' as const, processedAt: now }));
  };

  /** Finishes items the run actually handled. Returns how many changed. */
  complete = (employeeId: string, ids: readonly string[], now: number): number => {
    const statement = this.db.prepare(
      "UPDATE inbox_item SET status = 'done', processed_at = ? WHERE id = ? AND employee_id = ? AND status IN ('pending','processing')",
    );
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const id of ids) changed += statement.run(now, id, employeeId).changes;
    });
    run();
    return changed;
  };

  /** `ack_message` in one statement: everything from this conversation is read. */
  completeConversation = (employeeId: string, conversationId: string, now: number): number =>
    this.db
      .prepare(
        `UPDATE inbox_item SET status = 'done', processed_at = ?
          WHERE employee_id = ? AND conversation_id = ? AND status IN ('pending','processing')`,
      )
      .run(now, employeeId, conversationId).changes;

  /** Items a run was given but never finished go back to the queue. */
  requeueStale = (employeeId: string, claimedAt: number): number =>
    this.db
      .prepare(
        `UPDATE inbox_item SET status = 'pending', processed_at = NULL
          WHERE employee_id = ? AND status = 'processing' AND processed_at <= ?`,
      )
      .run(employeeId, claimedAt).changes;

  quota = (employeeId: string, dailyLimit: number, now: number): WakeQuota => {
    const date = quotaDay(now);
    const row = this.db
      .prepare('SELECT daily_limit, used_count FROM wake_quota WHERE employee_id = ? AND quota_date = ?')
      .get(employeeId, date) as { daily_limit: number; used_count: number } | undefined;

    if (!row) {
      this.db
        .prepare(
          `INSERT INTO wake_quota (id, employee_id, quota_date, daily_limit, used_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(employee_id, quota_date) DO NOTHING`,
        )
        .run(`quota-${employeeId}-${date}`, employeeId, date, Math.max(0, Math.round(dailyLimit)), now, now);
      return { employeeId, quotaDate: date, limit: dailyLimit, used: 0, remaining: dailyLimit };
    }

    return {
      employeeId,
      quotaDate: date,
      limit: row.daily_limit,
      used: row.used_count,
      remaining: Math.max(0, row.daily_limit - row.used_count),
    };
  };

  /** Consumes one wake. False = the daily brake is on (§7.2). */
  consumeQuota = (employeeId: string, dailyLimit: number, now: number): boolean => {
    this.quota(employeeId, dailyLimit, now);
    const result = this.db
      .prepare(
        `UPDATE wake_quota SET used_count = used_count + 1, updated_at = ?
          WHERE employee_id = ? AND quota_date = ? AND used_count < daily_limit`,
      )
      .run(now, employeeId, quotaDay(now));
    return result.changes > 0;
  };

  recordGuard = (input: {
    employeeId: string;
    kind: GuardKind;
    detail?: Record<string, unknown>;
    conversationId?: string;
    now: number;
  }): void => {
    this.db
      .prepare(
        `INSERT INTO guard_event (id, employee_id, kind, detail, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `guard-${crypto.randomUUID()}`,
        input.employeeId,
        input.kind,
        JSON.stringify(input.detail ?? {}),
        input.conversationId ?? null,
        input.now,
      );
  };

  guards = (employeeId?: string, limit = 50): GuardEvent[] => {
    const rows = (
      employeeId
        ? this.db
            .prepare(
              `SELECT * FROM guard_event
                WHERE employee_id = ? AND dismissed_at IS NULL
                ORDER BY created_at DESC LIMIT ?`,
            )
            .all(employeeId, limit)
        : this.db
            .prepare(
              'SELECT * FROM guard_event WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?',
            )
            .all(limit)
    ) as GuardRow[];

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      kind: row.kind as GuardKind,
      detail: parseDetail(row.detail),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      createdAt: row.created_at,
    }));
  };

  /**
   * Marks guards as read. A timestamp rather than a delete: the boss acknowledging a
   * suppression must not erase the record that it happened (§7.3, 决定② C).
   * Passing no ids dismisses every open guard.
   */
  dismissGuards = (ids: readonly string[] | undefined, now: number): number => {
    if (ids && ids.length === 0) return 0;
    if (!ids) {
      return this.db
        .prepare('UPDATE guard_event SET dismissed_at = ? WHERE dismissed_at IS NULL')
        .run(now).changes;
    }

    const statement = this.db.prepare(
      'UPDATE guard_event SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL',
    );
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const id of ids) changed += statement.run(now, id).changes;
    });
    run();
    return changed;
  };

  relationship = (
    fromEmployeeId: string,
    toEmployeeId: string,
    kind: RelationshipKind,
  ): Relationship | undefined => {
    const row = this.db
      .prepare(
        `SELECT * FROM relationship
          WHERE from_employee_id = ? AND to_employee_id = ? AND kind = ?`,
      )
      .get(fromEmployeeId, toEmployeeId, kind) as RelationshipRow | undefined;
    return row ? toRelationship(row) : undefined;
  };

  /** Directional edges, strongest first: what `list_team` and the dossier read. */
  relationships = (fromEmployeeId?: string, limit = 100): Relationship[] =>
    (
      (fromEmployeeId
        ? this.db
            .prepare(
              `SELECT * FROM relationship WHERE from_employee_id = ?
                ORDER BY strength DESC, last_interaction_at DESC LIMIT ?`,
            )
            .all(fromEmployeeId, limit)
        : this.db
            .prepare('SELECT * FROM relationship ORDER BY strength DESC LIMIT ?')
            .all(limit)) as RelationshipRow[]
    ).map(toRelationship);

  /** Sends already made in the current one-hour window (checked before recording). */
  sendsInWindow = (fromEmployeeId: string, toEmployeeId: string, now: number): number => {
    const row = this.db
      .prepare(
        `SELECT window_started_at, window_count FROM relationship
          WHERE from_employee_id = ? AND to_employee_id = ?`,
      )
      .get(fromEmployeeId, toEmployeeId) as
      | { window_started_at: number | null; window_count: number }
      | undefined;
    if (!row || row.window_started_at === null) return 0;
    return now - row.window_started_at >= HOUR ? 0 : row.window_count;
  };

  /** One exchange: strength up a notch, counters up one, window rolled if stale. */
  recordInteraction = (input: {
    fromEmployeeId: string;
    toEmployeeId: string;
    kind: RelationshipKind;
    now: number;
  }): void => {
    const windowFloor = input.now - HOUR;
    this.db
      .prepare(
        `INSERT INTO relationship (id, company_id, from_employee_id, to_employee_id, kind, strength,
                                   interaction_count, last_interaction_at, window_started_at, window_count,
                                   created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)
         ON CONFLICT(from_employee_id, to_employee_id, kind) DO UPDATE SET
           strength = MIN(?, strength + ?),
           interaction_count = interaction_count + 1,
           last_interaction_at = excluded.last_interaction_at,
           window_count = CASE WHEN window_started_at IS NULL OR window_started_at <= ?
                               THEN 1 ELSE window_count + 1 END,
           window_started_at = CASE WHEN window_started_at IS NULL OR window_started_at <= ?
                                    THEN ? ELSE window_started_at END,
           updated_at = excluded.updated_at`,
      )
      .run(
        `rel-${crypto.randomUUID()}`,
        COMPANY_ID,
        input.fromEmployeeId,
        input.toEmployeeId,
        input.kind,
        0.5 + STRENGTH_PER_INTERACTION,
        input.now,
        input.now,
        input.now,
        input.now,
        MAX_STRENGTH,
        STRENGTH_PER_INTERACTION,
        windowFloor,
        windowFloor,
        input.now,
      );
  };
}

const HOUR = 60 * 60 * 1000;

function toInboxItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    employeeId: row.employee_id,
    sourceType: row.source_type as InboxSourceType,
    sourceId: row.source_id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    priority: row.priority as InboxPriority,
    status: row.status as InboxStatus,
    requiresWake: row.requires_wake === 1,
    createdAt: row.created_at,
    ...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
  };
}

function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    fromEmployeeId: row.from_employee_id,
    toEmployeeId: row.to_employee_id,
    kind: row.kind as RelationshipKind,
    strength: row.strength,
    interactionCount: row.interaction_count,
    ...(row.last_interaction_at !== null ? { lastInteractionAt: row.last_interaction_at } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
