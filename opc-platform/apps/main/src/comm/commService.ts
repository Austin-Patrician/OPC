import type { Message } from '@opc/shared/domain';
import type {
  CommRepository,
  GuardEvent,
  InboxItem,
  InboxPriority,
  Relationship,
  RelationshipKind,
  WakeQuota,
} from '../data/commRepository';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { OrgService } from '../org/orgService';

/** Cadence and brakes, read from company.db settings on bootstrap (§4.2). */
export interface CommSettings {
  /** How often an employee with waiting work is woken by the scheduler. */
  heartbeatMs: number;
  /** Wakes per employee per day, including the ones it asks for itself. */
  dailyWakeQuota: number;
  /** A one-way hourly cap per pair; the rate brake from F5. */
  dmPerHour: number;
  /** How many inbox items one run is given. */
  batchSize: number;
  /** Employee turns one thread may take before it is escalated to the boss (§7.3 ②). */
  maxConversationTurns: number;
}

export const DEFAULT_COMM_SETTINGS: CommSettings = {
  heartbeatMs: 15 * 60 * 1000,
  dailyWakeQuota: 5,
  dmPerHour: 10,
  batchSize: 5,
  maxConversationTurns: 10,
};

/** The part of ChatService comm needs: appending and reading the transcript. */
export interface CommTranscript {
  openPeerDirect(fromAgentId: string, toAgentId: string): string;
  appendAgentMessage(
    conversationId: string,
    from: { id: string; name: string; role?: string },
    text: string,
  ): Message | undefined;
  readTranscript(conversationId: string): Message[];
  /** Turns used and the §7.5 lifecycle state. */
  turnState(conversationId: string): { turns: number; status: 'open' | 'cooling' | 'escalated' };
  /** Stops the thread from auto-replying; only the boss can lift it. */
  escalateConversation(conversationId: string): boolean;
  /** Who is in this conversation and which department it belongs to (§7.4 routing). */
  conversationInfo?: (
    conversationId: string,
  ) => { kind: 'dm' | 'group' | 'channel'; departmentId?: string; memberIds: readonly string[] } | undefined;
}

export interface GroupRouteResult {
  conversationId: string;
  /** Who was put on the queue, most important first. */
  targets: { employeeId: string; name: string; priority: InboxPriority }[];
  /** Mentions that are not members of this conversation; dropped, and reported. */
  ignored: readonly string[];
  /** True when nobody was @-ed and the owner carries the message. */
  delegatedToOwner: boolean;
}

export interface SendDmResult {
  ok: boolean;
  /** Why the message was refused; the tool turns this into a structured answer. */
  code?:
    | 'UNKNOWN_TARGET'
    | 'TARGET_INACTIVE'
    | 'SELF_DM'
    | 'DM_RATE_LIMIT'
    | 'EMPTY_TEXT'
    | 'CONVERSATION_ESCALATED';
  message: string;
  conversationId?: string;
  messageId?: string;
  /** `now` = the recipient was woken, `queued` = it waits for the heartbeat. */
  delivery?: 'now' | 'queued';
  priority?: InboxPriority;
}

/**
 * Communication: who may talk to whom, how often, and who wakes up for it (§7, F5/F6).
 *
 * Three things this class deliberately does *not* do:
 * - it never invents a conversation: the transcript is `ChatService`, the truth is
 *   the `message` table;
 * - it never runs the model: waking is the scheduler's job, so a chatty employee
 *   costs a queue row, not a token;
 * - it never silently drops a message: a refusal is a `guard_event` the boss can
 *   see (决定② → C).
 */
export class CommService {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      repository: CommRepository;
      org: OrgService;
      transcript: CommTranscript;
      settings?: Partial<CommSettings>;
    },
  ) {}

  get settings(): CommSettings {
    return { ...DEFAULT_COMM_SETTINGS, ...this.deps.settings };
  }

  /** The boss's notification view listens here; the payload is always re-read. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Queues work for an employee (message, task handoff, approval, system notice). */
  enqueue = (input: {
    employeeId: string;
    sourceType: 'message' | 'task' | 'approval' | 'system';
    sourceId: string;
    conversationId?: string;
    priority: InboxPriority;
    requiresWake?: boolean;
    now?: number;
  }): InboxItem | undefined => {
    const item = this.deps.repository.enqueue({
      employeeId: input.employeeId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      priority: input.priority,
      requiresWake: input.requiresWake ?? false,
      now: input.now ?? Date.now(),
    });
    if (item) this.changed();
    return item;
  };

  /**
   * Employee → employee DM (F5).
   *
   * Admission order matters: an unknown or departed colleague is refused before any
   * side effect; the rate brake is checked before the quota, so a spammer cannot
   * burn the recipient's quota; the quota is consumed *before* the message is routed,
   * so a crash cannot hand out a free wake.
   */
  sendDirectMessage = (input: {
    fromEmployeeId: string;
    toEmployeeId: string;
    text: string;
    now?: number;
  }): SendDmResult => {
    const result = this.deliver(input);
    // Every outcome — sent, queued, refused — changes what the boss can see.
    this.changed();
    return result;
  };

  private deliver = (input: {
    fromEmployeeId: string;
    toEmployeeId: string;
    text: string;
    now?: number;
  }): SendDmResult => {
    const now = input.now ?? Date.now();
    const text = input.text.trim();
    if (text.length === 0) return { ok: false, code: 'EMPTY_TEXT', message: '消息内容为空' };
    if (input.fromEmployeeId === input.toEmployeeId) {
      return { ok: false, code: 'SELF_DM', message: '不能给自己发消息' };
    }

    // `everyone()` and not `list()`: a departed colleague must be distinguishable
    // from an id that never existed.
    const members = this.deps.org.everyone();
    const sender = members.find((member) => member.id === input.fromEmployeeId);
    const target = members.find((member) => member.id === input.toEmployeeId);
    if (!sender || sender.status !== 'active') {
      return { ok: false, code: 'UNKNOWN_TARGET', message: '发送者不在岗' };
    }
    if (!target) {
      return { ok: false, code: 'UNKNOWN_TARGET', message: `未知同事：${input.toEmployeeId}` };
    }
    if (target.status !== 'active') {
      return { ok: false, code: 'TARGET_INACTIVE', message: `${target.name} 已不在岗，消息未发出` };
    }

    const kind = relationshipKind(sender, target);
    const sent = this.deps.repository.sendsInWindow(sender.id, target.id, now);
    if (sent >= this.settings.dmPerHour) {
      this.deps.repository.recordGuard({
        employeeId: sender.id,
        kind: 'dm_rate',
        detail: { toEmployeeId: target.id, toName: target.name, sentInHour: sent, limit: this.settings.dmPerHour },
        now,
      });
      return {
        ok: false,
        code: 'DM_RATE_LIMIT',
        message: `你在一小时内已经给 ${target.name} 发了 ${sent} 条，超过上限 ${this.settings.dmPerHour} 条；等一会儿再发`,
      };
    }

    const conversationId = this.deps.transcript.openPeerDirect(sender.id, target.id);

    // §7.3 ②: an escalated thread does not continue on its own. Checked before the
    // message is written, so the transcript stays a record of what actually happened
    // rather than of what was attempted.
    const state = this.deps.transcript.turnState(conversationId);
    if (state.status === 'escalated') {
      this.deps.repository.recordGuard({
        employeeId: sender.id,
        kind: 'turn_limit',
        detail: {
          reason: 'escalated',
          turns: state.turns,
          limit: this.settings.maxConversationTurns,
          partnerName: target.name,
        },
        conversationId,
        now,
      });
      return {
        ok: false,
        code: 'CONVERSATION_ESCALATED',
        message: `你和 ${target.name} 的这段对话已经升级给老板（超过 ${this.settings.maxConversationTurns} 轮），等老板介入后再继续`,
        conversationId,
      };
    }

    const message = this.deps.transcript.appendAgentMessage(
      conversationId,
      { id: sender.id, name: sender.name, role: `${sender.role} · ${sender.level}` },
      text,
    );
    if (!message) return { ok: false, code: 'UNKNOWN_TARGET', message: '无法写入这段对话' };

    this.deps.repository.recordInteraction({
      fromEmployeeId: sender.id,
      toEmployeeId: target.id,
      kind,
      now,
    });

    // The turn just spent may be the one that ends the conversation's budget.
    this.noteAgentTurn({ conversationId, employeeId: sender.id, partnerName: target.name, now });

    // The recipient's rhythm decides the priority, and its quota decides whether it
    // is woken now or reads it at the next heartbeat (§7.2).
    const priority: InboxPriority = kind === 'manager' || kind === 'report' ? 1 : 2;
    const woken = this.deps.repository.consumeQuota(target.id, this.settings.dailyWakeQuota, now);

    if (!woken) {
      this.deps.repository.recordGuard({
        employeeId: target.id,
        kind: 'wake_quota',
        detail: { fromEmployeeId: sender.id, fromName: sender.name, degradedTo: 3 },
        conversationId,
        now,
      });
    }

    this.deps.repository.enqueue({
      employeeId: target.id,
      sourceType: 'message',
      sourceId: message.id,
      conversationId,
      priority: woken ? priority : 3,
      requiresWake: woken,
      now,
    });

    return {
      ok: true,
      message: woken
        ? `已发给 ${target.name}，它会被立刻唤醒`
        : `${target.name} 今天的唤醒配额已用完，消息进入它的收件箱等心跳`,
      conversationId,
      messageId: message.id,
      delivery: woken ? 'now' : 'queued',
      priority: woken ? priority : 3,
    };
  };

  /**
   * §7.4: 群聊 @ 的路由。
   *
   * 没人被 @ → 只唤醒部门负责人（priority 1），由它决定要不要替大家回答；
   * 有人被 @ → 只唤醒被点名的那几个人（priority 2）。
   *
   * 老板是发送者，所以按 §7.2 的 P0 处理：不计任何人的唤醒配额，直接进队列并立刻唤醒。
   * 消息本身早已写入 transcript（`ChatService`），这里只决定"谁该醒"。
   */
  routeGroupMessage = (input: {
    conversationId: string;
    messageId: string;
    mentionIds?: readonly string[];
    now?: number;
  }): GroupRouteResult => {
    const now = input.now ?? Date.now();
    const empty: GroupRouteResult = {
      conversationId: input.conversationId,
      targets: [],
      ignored: [],
      delegatedToOwner: false,
    };

    const info = this.deps.transcript.conversationInfo?.(input.conversationId);
    if (!info || info.kind === 'dm') return empty;

    const everyone = this.deps.org.everyone();
    const activeMember = (id: string) =>
      info.memberIds.includes(id) && everyone.find((member) => member.id === id)?.status === 'active';

    const mentioned = (input.mentionIds ?? []).filter((id) => id !== 'user');
    const ignored = mentioned.filter((id) => !activeMember(id));

    // No @ (or every @ was bogus) → the department owner speaks for the group.
    let targets: { employeeId: string; priority: InboxPriority }[];
    let delegatedToOwner = false;
    if (mentioned.length === 0) {
      const owner = this.ownerOf(info.departmentId, info.memberIds, everyone);
      if (!owner) return empty;
      targets = [{ employeeId: owner, priority: 1 }];
      delegatedToOwner = true;
    } else {
      targets = mentioned
        .filter((id) => activeMember(id))
        .map((id) => ({ employeeId: id, priority: 2 as InboxPriority }));
    }

    const routed: GroupRouteResult['targets'] = [];
    for (const target of targets) {
      const member = everyone.find((entry) => entry.id === target.employeeId);
      if (!member) continue;
      const queued = this.deps.repository.enqueue({
        employeeId: target.employeeId,
        sourceType: 'message',
        sourceId: input.messageId,
        conversationId: input.conversationId,
        priority: target.priority,
        requiresWake: true,
        now,
      });
      // A duplicate (same message, same person, still pending) is not a new路由.
      if (queued) routed.push({ employeeId: member.id, name: member.name, priority: target.priority });
    }

    if (routed.length > 0) this.changed();
    return { conversationId: input.conversationId, targets: routed, ignored, delegatedToOwner };
  };

  /** Department head first; the most senior member as the fallback. */
  private ownerOf(
    departmentId: string | undefined,
    memberIds: readonly string[],
    everyone: { id: string; status: string; isHead?: boolean }[],
  ): string | undefined {
    if (departmentId) {
      const head = this.deps.org.list().find((node) => node.id === departmentId)?.headEmployeeId;
      if (head && memberIds.includes(head)) return head;
    }
    const head = everyone.find(
      (member) => memberIds.includes(member.id) && member.status === 'active' && member.isHead,
    );
    if (head) return head.id;
    return everyone.find(
      (member) => memberIds.includes(member.id) && member.status === 'active',
    )?.id;
  }

  /** Waiting work for one employee, most important first. */
  inbox = (employeeId: string): InboxItem[] => this.deps.repository.pending(employeeId);
  /** Waiting work across the company, for the boss's notification view. */
  inboxAll = (limit = 200): InboxItem[] => this.deps.repository.pendingAll(limit);

  pendingCount = (employeeId: string): number => this.deps.repository.pendingCount(employeeId);

  quota = (employeeId: string, now = Date.now()): WakeQuota =>
    this.deps.repository.quota(employeeId, this.settings.dailyWakeQuota, now);

  /** Everything waiting for the employee, as the recipient must read it. */
  transcriptSince = (conversationId: string, afterMessageId?: string): Message[] => {
    const messages = this.deps.transcript.readTranscript(conversationId);
    if (!afterMessageId) return messages;
    const index = messages.findIndex((message) => message.id === afterMessageId);
    return index < 0 ? messages : messages.slice(index + 1);
  };

  /**
   * What one run should be given. Claiming marks the items `processing`, so a second
   * tick cannot start them again; a run that ends without finishing returns them
   * with `requeue`.
   */
  claim = (employeeId: string, now = Date.now()): InboxItem[] => {
    const items = this.deps.repository.claim(employeeId, this.settings.batchSize, now);
    if (items.length > 0) this.changed();
    return items;
  };

  complete = (employeeId: string, ids: readonly string[], now = Date.now()): number => {
    const changed = this.deps.repository.complete(employeeId, ids, now);
    if (changed > 0) this.changed();
    return changed;
  };

  /** `ack_message`: read, no reply needed — the cheapest possible turn (§R4). */
  ack = (employeeId: string, conversationId: string, now = Date.now()): number => {
    const changed = this.deps.repository.completeConversation(employeeId, conversationId, now);
    if (changed > 0) this.changed();
    return changed;
  };

  /** Puts a failed run's batch back, so a crash retries instead of dropping work. */
  requeue = (employeeId: string, claimedAt: number): number => {
    const changed = this.deps.repository.requeueStale(employeeId, claimedAt);
    if (changed > 0) this.changed();
    return changed;
  };

  /** The conversation that most recently woke this employee (`ack_message` default). */
  latestConversationId = (employeeId: string): string | undefined =>
    this.deps.repository.pending(employeeId).find((item) => item.conversationId)?.conversationId;

  /** Turns used and the §7.5 state of a thread, as the runner needs it. */
  turnState = (conversationId: string): { turns: number; status: 'open' | 'cooling' | 'escalated' } =>
    this.deps.transcript.turnState(conversationId);

  /**
   * Counts one employee turn and escalates the thread once its budget is gone
   * (§7.3 ②). Idempotent: the sender and the answering run both observe the overrun,
   * and only the first one records the escalation.
   */
  noteAgentTurn = (input: {
    conversationId: string;
    employeeId: string;
    partnerName?: string;
    now?: number;
  }): { turns: number; escalated: boolean } => {
    const now = input.now ?? Date.now();
    const { turns } = this.deps.transcript.turnState(input.conversationId);
    const limit = this.settings.maxConversationTurns;
    if (turns < limit) return { turns, escalated: false };

    const escalated = this.deps.transcript.escalateConversation(input.conversationId);
    if (!escalated) return { turns, escalated: false };

    this.deps.repository.recordGuard({
      employeeId: input.employeeId,
      kind: 'turn_limit',
      detail: {
        reason: 'limit_reached',
        turns,
        limit,
        ...(input.partnerName ? { partnerName: input.partnerName } : {}),
      },
      conversationId: input.conversationId,
      now,
    });
    this.changed();
    return { turns, escalated: true };
  };

  /** Refusals are recorded, never swallowed (决定② C: kept visible to the boss). */
  recordGuard = (input: {
    employeeId: string;
    kind: 'wake_quota' | 'turn_limit' | 'dm_rate' | 'message_dropped';
    detail?: Record<string, unknown>;
    conversationId?: string;
    now?: number;
  }): void => {
    this.deps.repository.recordGuard({
      employeeId: input.employeeId,
      kind: input.kind,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      now: input.now ?? Date.now(),
    });
    this.changed();
  };

  relationships = (employeeId?: string): Relationship[] => this.deps.repository.relationships(employeeId);

  guards = (employeeId?: string, limit = 50): GuardEvent[] => this.deps.repository.guards(employeeId, limit);

  /**
   * 老板处理护栏：标记为已读。带 ids 只处理这几条，不带就处理全部未读。
   * 记录不会被删除 —— 被拦下这件事本身是审计事实。
   */
  dismissGuards = (ids?: readonly string[], now = Date.now()): number => {
    const changed = this.deps.repository.dismissGuards(ids, now);
    if (changed > 0) this.changed();
    return changed;
  };

  /** Active employees, the only ones the scheduler may wake. */
  activeEmployees = (): { id: string; name: string }[] =>
    this.deps.org
      .everyone()
      .filter((member) => member.status === 'active')
      .map((member) => ({ id: member.id, name: member.name }));

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Cadence from company.db (`company.settings`, §4.2), with env overrides so probes
 * can make the brake trip immediately instead of waiting for five real wakes.
 */
export function commSettingsFrom(db: CompanyDatabase): CommSettings {
  const row = db.prepare('SELECT settings FROM company LIMIT 1').get() as
    | { settings: string }
    | undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row?.settings ?? '{}') as Record<string, unknown>;
  } catch {
    // A hand-edited settings blob must not stop the heartbeat from starting.
    parsed = {};
  }

  const minutes = readInt(parsed.heartbeatMinutes) ?? 15;
  const quota = readInt(process.env.OPC_WAKE_QUOTA) ?? readInt(parsed.defaultDailyWakeQuota) ?? 5;
  const rate = readInt(process.env.OPC_DM_PER_HOUR) ?? 10;
  const batch = readInt(process.env.OPC_INBOX_BATCH) ?? 5;
  const turns = readInt(process.env.OPC_MAX_TURNS) ?? readInt(parsed.maxConversationTurns) ?? 10;

  return {
    // A heartbeat below a minute is a busy loop, not a rhythm.
    heartbeatMs: Math.max(60_000, minutes * 60_000),
    dailyWakeQuota: Math.max(0, quota),
    dmPerHour: Math.max(1, rate),
    batchSize: Math.max(1, batch),
    // A pair must be able to say hello and answer once, or the limit is a snooze.
    maxConversationTurns: Math.max(2, turns),
  };
}

function readInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

/** Direction of the edge, from the sender's point of view. */
function relationshipKind(
  sender: { id: string; reportsToEmployeeId?: string },
  target: { id: string; reportsToEmployeeId?: string },
): RelationshipKind {
  // Talking upward to my own manager; talking downward to one of my reports.
  if (sender.reportsToEmployeeId === target.id) return 'manager';
  if (target.reportsToEmployeeId === sender.id) return 'report';
  return 'colleague';
}
