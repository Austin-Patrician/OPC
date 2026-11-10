import crypto from 'node:crypto';
import type {
  RouterSchedule,
  RouterScheduleDraft,
  RouterScheduleOccurrence,
  RouterSchedulePatch,
  RouterScheduleRule,
} from '@opc/shared/domain';
import type { CompanyDatabase } from './companyDatabase';
import { latestMissedScheduleAt, nextScheduleAt, validateScheduleRule, validateTimezone } from '../router/scheduleRule';

interface ScheduleRow {
  id: string; title: string; instruction: string; rule_json: string; timezone: string;
  status: RouterSchedule['status']; next_run_at: number | null; last_run_at: number | null;
  created_at: number; updated_at: number;
}

interface OccurrenceRow {
  id: string; schedule_id: string; scheduled_for: number; enqueued_at: number;
  event_id: string; missed_count: number; triage: RouterScheduleOccurrence['triage'];
}

export interface DueScheduleResult {
  due: RouterScheduleOccurrence[];
  skipped: number;
}

export class RouterScheduleRepository {
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly db: CompanyDatabase,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  list(): RouterSchedule[] {
    return (this.db.prepare(`SELECT * FROM router_schedule
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      next_run_at IS NULL, next_run_at, updated_at DESC`).all() as ScheduleRow[]).map(toSchedule);
  }

  get(id: string): RouterSchedule | null {
    const row = this.db.prepare('SELECT * FROM router_schedule WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  create(draft: RouterScheduleDraft): RouterSchedule {
    const title = required(draft.title, '计划名称');
    const instruction = required(draft.instruction, '计划内容');
    const timezone = draft.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    validateScheduleRule(draft.rule);
    validateTimezone(timezone);
    const now = this.now();
    const nextRunAt = nextScheduleAt(draft.rule, now, timezone);
    if (nextRunAt === null) throw new Error('计划时间必须晚于当前时间');
    const row: ScheduleRow = {
      id: this.id(), title, instruction, rule_json: JSON.stringify(draft.rule), timezone,
      status: 'active', next_run_at: nextRunAt, last_run_at: null, created_at: now, updated_at: now,
    };
    this.db.prepare(`INSERT INTO router_schedule
      (id,title,instruction,rule_json,timezone,status,next_run_at,last_run_at,created_at,updated_at)
      VALUES (@id,@title,@instruction,@rule_json,@timezone,@status,@next_run_at,@last_run_at,@created_at,@updated_at)`).run(row);
    this.changed();
    return toSchedule(row);
  }

  update(id: string, patch: RouterSchedulePatch): RouterSchedule {
    const current = this.get(id);
    if (!current) throw new Error(`未知定时计划：${id}`);
    const title = patch.title === undefined ? current.title : required(patch.title, '计划名称');
    const instruction = patch.instruction === undefined ? current.instruction : required(patch.instruction, '计划内容');
    const rule = patch.rule ?? current.rule;
    const timezone = patch.timezone?.trim() || current.timezone;
    validateScheduleRule(rule);
    validateTimezone(timezone);
    const status = patch.status ?? current.status;
    if (current.status === 'cancelled' || current.status === 'completed') {
      throw new Error('已结束的计划不能再修改');
    }
    const nextRunAt = status === 'active' ? nextScheduleAt(rule, this.now(), timezone) : null;
    if (status === 'active' && nextRunAt === null) throw new Error('计划时间必须晚于当前时间');
    const updatedAt = this.now();
    this.db.prepare(`UPDATE router_schedule SET title=?, instruction=?, rule_json=?, timezone=?,
      status=?, next_run_at=?, updated_at=? WHERE id=?`).run(
      title, instruction, JSON.stringify(rule), timezone, status, nextRunAt, updatedAt, id,
    );
    this.changed();
    return this.get(id)!;
  }

  cancel(id: string): RouterSchedule {
    const schedule = this.get(id);
    if (!schedule) throw new Error(`未知定时计划：${id}`);
    if (schedule.status === 'completed') return schedule;
    this.db.prepare(`UPDATE router_schedule SET status='cancelled', next_run_at=NULL, updated_at=? WHERE id=?`)
      .run(this.now(), id);
    this.changed();
    return this.get(id)!;
  }

  occurrences(scheduleId: string, limit = 10): RouterScheduleOccurrence[] {
    return (this.db.prepare(`SELECT o.*, e.triage FROM router_schedule_occurrence o
      JOIN event e ON e.id=o.event_id WHERE o.schedule_id=?
      ORDER BY o.scheduled_for DESC LIMIT ?`).all(scheduleId, Math.max(1, Math.min(100, limit))) as OccurrenceRow[])
      .map(toOccurrence);
  }

  /** Each overdue schedule produces one event, even after a long offline period. */
  enqueueDue(): DueScheduleResult {
    const now = this.now();
    const due = this.db.prepare(`SELECT * FROM router_schedule
      WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`)
      .all(now) as ScheduleRow[];
    const write = this.db.transaction(() => {
      const occurrences: RouterScheduleOccurrence[] = [];
      let skipped = 0;
    for (const row of due) {
        const rule = parseRule(row.rule_json);
        const latest = latestMissedScheduleAt(rule, row.next_run_at!, now, row.timezone);
        if (latest === null) continue;
        const eventId = this.id();
        const occurrenceId = this.id();
        const missedCount = countMissed(rule, row.next_run_at!, latest, row.timezone);
        this.db.prepare(`INSERT INTO event
          (id,source,kind,payload,thread_id,dedupe_key,triage,created_at,triaged_at)
          VALUES (?,'manual','schedule.due',?,NULL,?,'pending',?,NULL)`)
          .run(eventId, JSON.stringify({ scheduleId: row.id, title: row.title, instruction: row.instruction,
          scheduledFor: latest, timezone: row.timezone, missedCount }), `schedule:${row.id}:${latest}`, now);
        this.db.prepare(`INSERT INTO router_schedule_occurrence
          (id,schedule_id,scheduled_for,enqueued_at,event_id,missed_count) VALUES (?,?,?,?,?,?)`)
          .run(occurrenceId, row.id, latest, now, eventId, missedCount);
        const nextRunAt = rule.kind === 'once' ? null : nextScheduleAt(rule, now, row.timezone);
        const status = rule.kind === 'once' ? 'completed' : 'active';
        this.db.prepare(`UPDATE router_schedule SET status=?, last_run_at=?, next_run_at=?, updated_at=? WHERE id=?`)
          .run(status, latest, nextRunAt, now, row.id);
        occurrences.push({ id: occurrenceId, scheduleId: row.id, scheduledFor: latest,
          enqueuedAt: now, eventId, missedCount, triage: 'pending' });
        skipped += missedCount;
      }
      return { due: occurrences, skipped };
    });
    const result = write();
    if (result.due.length > 0) this.changed();
    return result;
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > 5000) throw new Error(`${label}不能超过 5000 个字符`);
  return normalized;
}

function parseRule(value: string): RouterScheduleRule {
  const rule = JSON.parse(value) as RouterScheduleRule;
  validateScheduleRule(rule);
  return rule;
}

function countMissed(rule: RouterScheduleRule, first: number, latest: number, timezone: string): number {
  let count = 0;
  let cursor = first;
  while (cursor < latest && count < 10_000) {
    const next = nextScheduleAt(rule, cursor, timezone);
    if (next === null || next <= cursor || next > latest) break;
    cursor = next;
    count += 1;
  }
    return count;
}

function toSchedule(row: ScheduleRow): RouterSchedule {
  return {
    id: row.id, title: row.title, instruction: row.instruction, rule: parseRule(row.rule_json),
    timezone: row.timezone, status: row.status, nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toOccurrence(row: OccurrenceRow): RouterScheduleOccurrence {
  return { id: row.id, scheduleId: row.schedule_id, scheduledFor: row.scheduled_for,
    enqueuedAt: row.enqueued_at, eventId: row.event_id, missedCount: row.missed_count, triage: row.triage };
}
