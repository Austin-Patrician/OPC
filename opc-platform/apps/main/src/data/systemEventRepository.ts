import type { CompanyDatabase } from './companyDatabase';
import crypto from 'node:crypto';

/**
 * 系统自身的故障记录（`11-watchdog-spec.md` W1）。
 *
 * 为什么需要它：在这之前，"系统出毛病了"只存在于控制台。Router 交给会话失败、
 * 任务恢复失败、MCP 连不上——全是一行 `console.error`，而 Watchdog 读的是库。
 * 它因此只能看见"某个任务卡住了"，看不见"整个轮次都在失败"。
 *
 * 两条纪律：
 *
 * 1. **只存可安全展示的东西。** 类型、时间、关联对象、一句摘要、一段脱敏 JSON。
 *    凭据和完整提示词不进来——这张表是给诊断和复盘看的，不是日志倾倒场。
 * 2. **写失败不能让业务路径失败。** 记录故障是旁路；`recordSafely` 吞掉异常。
 *    真正要抛的地方用 `record`。
 */

export type SystemEventSeverity = 'info' | 'warning' | 'error';

/** 关联对象。空字符串表示"整件事没有单一对象"。 */
export type SystemEventSubject = 'task' | 'thread' | 'worker' | 'mcp' | 'router' | 'process' | '';

export interface SystemEventInput {
  /** 稳定、可聚合的名字，例如 `router.session_failed`。不是给人读的句子。 */
  kind: string;
  severity?: SystemEventSeverity;
  subjectType?: SystemEventSubject;
  subjectId?: string;
  /** 一句话，给人看。 */
  summary: string;
  /** 结构化补充；写入前会被裁剪。 */
  detail?: Record<string, unknown>;
}

export interface SystemEvent {
  id: string;
  at: number;
  kind: string;
  severity: SystemEventSeverity;
  subjectType: SystemEventSubject;
  subjectId: string;
  summary: string;
  detail: string;
  handledAt?: number;
}

export interface SystemHeartbeat {
  instanceId: string;
  pid: number;
  at: number;
  state: 'running' | 'stopping';
}

/** 只记录、不抛的窄接口：业务代码只依赖这一面。 */
export interface FaultSink {
  recordSafely(input: SystemEventInput): void;
}

const MAX_SUMMARY = 400;
const MAX_DETAIL_CHARS = 2_000;
const MAX_DETAIL_VALUE = 400;
/** 这些键进不了库：诊断不需要它们，泄漏只需要一次。 */
const SECRET_KEY = /pass|secret|token|key|auth|cookie|credential/i;

/**
 * 摘要里的凭据也要抹掉。
 *
 * `detail` 有键名可判，`summary` 没有——它常是拼出来的错误信息，可能带着
 * `Authorization: Bearer …`、URL 里的 `user:pass@`、或者 `api_key=…`。
 * 只按长度裁剪等于没脱敏。
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|ghp|gho|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@')
    .replace(/\b([A-Za-z0-9_-]*(?:key|token|secret|password)[A-Za-z0-9_-]*)\s*=\s*[^\s,;]+/gi, '$1=[redacted]');
}

interface EventRow {
  id: string;
  at: number;
  kind: string;
  severity: SystemEventSeverity;
  subject_type: SystemEventSubject;
  subject_id: string;
  summary: string;
  detail: string;
  handled_at: number | null;
}

interface HeartbeatRow {
  instance_id: string;
  pid: number;
  at: number;
  state: 'running' | 'stopping';
}

export class SystemEventRepository implements FaultSink {
  constructor(
    private readonly db: CompanyDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 记一条。**会抛**——只在真的希望"记不下来就暴露"的地方用。 */
  record(input: SystemEventInput): SystemEvent {
    const at = this.now();
    const row: EventRow = {
      id: crypto.randomUUID(),
      at,
      kind: clip(input.kind, 80),
      severity: input.severity ?? 'error',
      subject_type: input.subjectType ?? '',
      subject_id: clip(input.subjectId ?? '', 120),
      summary: clip(scrubSecrets(input.summary), MAX_SUMMARY),
      detail: serializeDetail(input.detail),
      handled_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO system_event
           (id, at, kind, severity, subject_type, subject_id, summary, detail, handled_at)
         VALUES (@id, @at, @kind, @severity, @subject_type, @subject_id, @summary, @detail, @handled_at)`,
      )
      .run(row);
    return toEvent(row);
  }

  /**
   * 业务路径用的版本：**永不抛**。
   *
   * 记录故障是旁路。让一条 `INSERT` 的失败去吃掉一个正在跑的轮次，是把观测
   * 变成新的故障源——那比没有观测更糟。
   */
  recordSafely(input: SystemEventInput): void {
    try {
      this.record(input);
    } catch (error) {
      console.warn('[system-event] 记不下来', input.kind, error);
    }
  }

  listRecent(limit = 50): SystemEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM system_event ORDER BY at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as EventRow[];
    return rows.map(toEvent);
  }

  /** 还没人处理过的：Watchdog 每轮从这里读，人也能在界面上看。 */
  listOpen(limit = 50): SystemEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM system_event WHERE handled_at IS NULL ORDER BY at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as EventRow[];
    return rows.map(toEvent);
  }

  markHandled(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const at = this.now();
    const statement = this.db.prepare(`UPDATE system_event SET handled_at = ? WHERE id = ?`);
    for (const id of ids) statement.run(at, id);
  }

  /**
   * 主进程还活着吗。
   *
   * 只有一行（`id='main'`）：心跳不是日志，问的是"现在"，不是"曾经"。
   */
  beat(input: { instanceId: string; pid: number; state?: 'running' | 'stopping' }): void {
    this.db
      .prepare(
        `INSERT INTO system_heartbeat (id, instance_id, pid, at, state)
         VALUES ('main', @instanceId, @pid, @at, @state)
         ON CONFLICT(id) DO UPDATE SET
           instance_id = excluded.instance_id,
           pid = excluded.pid,
           at = excluded.at,
           state = excluded.state`,
      )
      .run({
        instanceId: input.instanceId,
        pid: input.pid,
        at: this.now(),
        state: input.state ?? 'running',
      });
  }

  readHeartbeat(): SystemHeartbeat | null {
    const row = this.db.prepare(`SELECT * FROM system_heartbeat WHERE id = 'main'`).get() as
      | HeartbeatRow
      | undefined;
    if (!row) return null;
    return { instanceId: row.instance_id, pid: row.pid, at: row.at, state: row.state };
  }

  /**
   * 上一次是不是没正常退出。
   *
   * 判据只有一条：上一轮写的心跳不是 `stopping`。**不按时间判**——应用可能
   * 关了几天才再打开，那段时间的长短说明不了任何事。
   */
  uncleanExit(instanceId: string): SystemHeartbeat | null {
    const last = this.readHeartbeat();
    if (!last || last.state === 'stopping') return null;
    if (last.instanceId === instanceId) return null;
    return last;
  }
}

function toEvent(row: EventRow): SystemEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    severity: row.severity,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    summary: row.summary,
    detail: row.detail,
    ...(row.handled_at === null ? {} : { handledAt: row.handled_at }),
  };
}

/**
 * 裁剪 + 脱敏。
 *
 * 故障记录会被 Watchdog 读进模型上下文，所以它必须小而且干净：
 * 值截断到 400 字，整段不超过 2000 字，可疑的键直接丢掉。
 */
function serializeDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) continue;
    cleaned[key] = clip(scrubSecrets(text), MAX_DETAIL_VALUE);
    if (JSON.stringify(cleaned).length >= MAX_DETAIL_CHARS) break;
  }
  const serialized = JSON.stringify(cleaned);
  return serialized.length > MAX_DETAIL_CHARS ? serialized.slice(0, MAX_DETAIL_CHARS) : serialized;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 一句能进库的错误描述：错误本身可能很长，也可能什么都没有。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : String(error);
}
