import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@opc/shared/domain';
import { ChatService } from '../chat/chatService';
import { CommRepository } from '../data/commRepository';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { OrgService } from '../org/orgService';
import { agentsFromOrg, chatDepartmentsFromOrg } from '../seed/firstCompany';
import { buildCommOverview } from './commOverview';
import { CommService, commSettingsFrom, type CommSettings } from './commService';
import { createInboxRunner } from './inboxRunner';
import { CommScheduler, type WakeInput } from './scheduler';

/**
 * Communication and the heartbeat, on a real database.
 *
 * The invariants under test are the ones the design calls load-bearing: a message
 * wakes someone only if that person's quota allows it, an empty inbox costs nothing,
 * and every suppression is visible as a guard event.
 */
let dir: string;
let db: CompanyDatabase;
let org: OrgService;
let chat: ChatService;
let comm: CommService;
let manager: { id: string; name: string };
let report: { id: string; name: string };
let peer: { id: string; name: string };

const NOW = Date.UTC(2025, 0, 6, 10, 0, 0);
const SETTINGS: CommSettings = {
  heartbeatMs: 15 * 60 * 1000,
  dailyWakeQuota: 1,
  dmPerHour: 3,
  batchSize: 5,
  // High enough that the ordering/rate cases are not cut short by escalation;
  // the turn-limit cases build their own instance with a smaller budget.
  maxConversationTurns: 6,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-comm-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
  const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
  manager = org.hire({ name: '沈聿', role: '技术负责人', departmentId: department.id, isHead: true });
  report = org.hire({
    name: '李雷',
    role: '全栈工程师',
    departmentId: department.id,
    reportsToEmployeeId: manager.id,
  });
  peer = org.hire({
    name: '韩梅梅',
    role: '测试工程师',
    departmentId: department.id,
    reportsToEmployeeId: manager.id,
  });

  chat = new ChatService({
    db,
    agents: agentsFromOrg(org),
    departments: chatDepartmentsFromOrg(org),
    conversations: [],
  });
  comm = new CommService({
    repository: new CommRepository(db),
    org,
    transcript: chat,
    settings: SETTINGS,
  });
});

afterEach(() => {
  chat.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sendDirectMessage', () => {
  it('wakes the recipient when its quota allows it, and spends it once', () => {
    const result = comm.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '把接口测试结果发我',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.delivery).toBe('now');
    // Talking to my own report is a work instruction, not small talk.
    expect(result.priority).toBe(1);
    expect(comm.quota(report.id, NOW)).toMatchObject({ limit: 1, used: 1, remaining: 0 });

    const inbox = comm.inbox(report.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.requiresWake).toBe(true);
  });

  it('degrades to a留言 when the quota is spent, and records the guard', () => {
    comm.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '第一条',
      now: NOW,
    });
    const second = comm.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '第二条',
      now: NOW,
    });

    expect(second.ok).toBe(true);
    expect(second.delivery).toBe('queued');
    expect(second.priority).toBe(3);

    const guards = comm.guards(report.id);
    expect(guards.map((guard) => guard.kind)).toContain('wake_quota');
    // The message is queued, never dropped: the recipient reads it at its heartbeat.
    expect(comm.inbox(report.id)).toHaveLength(2);
  });

  it('keeps inbox order by priority, then arrival', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    comm.sendDirectMessage({ fromEmployeeId: peer.id, toEmployeeId: report.id, text: 'b', now: NOW });

    const priorities = comm.inbox(report.id).map((item) => item.priority);
    expect(priorities).toEqual([1, 3]);
  });

  it('builds the transcript from the message table, not from memory', () => {
    const sent = comm.sendDirectMessage({
      fromEmployeeId: peer.id,
      toEmployeeId: report.id,
      text: '这个接口你测过吗',
      now: NOW,
    });

    const reopened = new ChatService({
      db,
      agents: agentsFromOrg(org),
      departments: chatDepartmentsFromOrg(org),
      conversations: [],
    });
    const transcript = reopened.readTranscript(sent.conversationId ?? '');
    expect(transcript.map((message) => message.text)).toEqual(['这个接口你测过吗']);
    expect(transcript[0]?.senderId).toBe(peer.id);
    reopened.dispose();
  });

  it('refuses self-messages, unknown colleagues and the departed', () => {
    expect(
      comm.sendDirectMessage({ fromEmployeeId: report.id, toEmployeeId: report.id, text: 'x', now: NOW }).code,
    ).toBe('SELF_DM');
    expect(
      comm.sendDirectMessage({ fromEmployeeId: report.id, toEmployeeId: 'agent-ghost', text: 'x', now: NOW })
        .code,
    ).toBe('UNKNOWN_TARGET');

    org.fire(peer.id);
    expect(
      comm.sendDirectMessage({ fromEmployeeId: report.id, toEmployeeId: peer.id, text: 'x', now: NOW }).code,
    ).toBe('TARGET_INACTIVE');
  });

  it('applies the hourly rate brake per pair and records it', () => {
    for (let index = 0; index < SETTINGS.dmPerHour; index += 1) {
      const ok = comm.sendDirectMessage({
        fromEmployeeId: peer.id,
        toEmployeeId: report.id,
        text: `第 ${index + 1} 条`,
        now: NOW,
      });
      expect(ok.ok).toBe(true);
    }

    const refused = comm.sendDirectMessage({
      fromEmployeeId: peer.id,
      toEmployeeId: report.id,
      text: '这条应当被拦下',
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('DM_RATE_LIMIT');
    expect(comm.guards(peer.id).map((guard) => guard.kind)).toContain('dm_rate');

    // A different hour starts a fresh window.
    const later = comm.sendDirectMessage({
      fromEmployeeId: peer.id,
      toEmployeeId: report.id,
      text: '一小时后',
      now: NOW + 61 * 60 * 1000,
    });
    expect(later.ok).toBe(true);
  });

  it('grows the relationship in the right direction', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'x', now: NOW });
    const repo = new CommRepository(db);
    const edge = repo.relationship(manager.id, report.id, 'report');
    expect(edge?.strength).toBeGreaterThan(0.5);
    expect(edge?.interactionCount).toBe(1);
    expect(repo.relationship(report.id, manager.id, 'manager')).toBeUndefined();
  });
});

describe('CommScheduler', () => {
  function scheduler(onWake: (input: WakeInput) => Promise<void> | void) {
    return new CommScheduler({ comm, now: () => NOW, onWake });
  }

  it('does not wake anyone whose inbox is empty', async () => {
    const result = await scheduler(async () => undefined).tick();
    expect(result.woken).toHaveLength(0);
  });

  it('wakes a signalled employee once and drains its batch', async () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'b', now: NOW });
    const runner = createInboxRunner({
      comm,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId) as Agent,
      appendAgentMessage: () => undefined,
    });

    const result = await scheduler(runner).tick();
    expect(result.woken).toEqual([{ employeeId: report.id, reason: 'signal', items: 2 }]);
    expect(comm.inbox(report.id)).toHaveLength(0);
  });

  it('leaves work for later when the heartbeat is not due', async () => {
    const sched = scheduler(async () => undefined);
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    await sched.tick();

    // Queued work arrives with no signal while the heartbeat clock is still fresh.
    comm.sendDirectMessage({ fromEmployeeId: peer.id, toEmployeeId: report.id, text: 'b', now: NOW });
    const second = await sched.tick();
    expect(second.woken).toHaveLength(0);
    expect(second.skipped).toEqual([{ employeeId: report.id, pending: 1, reason: 'not_due' }]);
  });

  it('returns a batch to the queue when the run fails', async () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    const failing = scheduler(async () => {
      throw new Error('model down');
    });

    const result = await failing.tick();
    expect(result.woken).toHaveLength(0);
    expect(comm.inbox(report.id)).toHaveLength(1);
  });
});

describe('inbox runner', () => {
  it('closes items and records why it stayed silent when no model is configured', async () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    const runner = createInboxRunner({
      comm,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId) as Agent,
      appendAgentMessage: () => undefined,
    });
    const items = comm.claim(report.id, NOW);

    await runner({ employeeId: report.id, items, reason: 'signal', now: NOW });

    expect(comm.inbox(report.id)).toHaveLength(0);
    expect(comm.guards(report.id).map((guard) => guard.kind)).toContain('message_dropped');
  });

  it('answers into the same conversation when a model is available', async () => {
    const sent = comm.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '接口测了吗',
      now: NOW,
    });
    const runner = createInboxRunner({
      comm,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId) as Agent,
      replyWithModel: async () => '测过了，结果在 report.md',
      appendAgentMessage: (conversationId, agent, text) =>
        void chat.appendAgentMessage(conversationId, agent, text),
    });

    await runner({ employeeId: report.id, items: comm.claim(report.id, NOW), reason: 'signal', now: NOW });

    const transcript = comm.transcriptSince(sent.conversationId ?? '');
    expect(transcript.at(-1)?.text).toBe('测过了，结果在 report.md');
    expect(transcript.at(-1)?.senderId).toBe(report.id);
    // One exchange costs one wake: the sender is not re-queued automatically.
    expect(comm.inbox(manager.id)).toHaveLength(0);
  });
});

describe('group routing (§7.4)', () => {
  /** A real department group, built by the same code the UI uses. */
  function groupConversation(): string {
    const departmentId = org.list()[0]?.id ?? '';
    return chat.ensureDepartmentGroup(departmentId);
  }

  it('wakes only the department head when nobody is mentioned', () => {
    const conversationId = groupConversation();
    const result = comm.routeGroupMessage({ conversationId, messageId: 'msg-group-1', now: NOW });

    expect(result.delegatedToOwner).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.employeeId).toBe(manager.id);
    // Owner work is a priority-1 instruction, and it is woken now.
    expect(result.targets[0]?.priority).toBe(1);
    expect(comm.inbox(manager.id)).toHaveLength(1);
    expect(comm.inbox(manager.id)[0]?.requiresWake).toBe(true);
    // Nobody else on the roster was disturbed.
    expect(comm.inbox(report.id)).toHaveLength(0);
    expect(comm.inbox(peer.id)).toHaveLength(0);
  });

  it('wakes exactly the mentioned people, and not the head as well', () => {
    const conversationId = groupConversation();
    const result = comm.routeGroupMessage({
      conversationId,
      messageId: 'msg-group-2',
      mentionIds: [report.id, peer.id],
      now: NOW,
    });

    expect(result.delegatedToOwner).toBe(false);
    expect(result.targets.map((target) => target.priority)).toEqual([2, 2]);
    expect(comm.inbox(report.id)).toHaveLength(1);
    expect(comm.inbox(peer.id)).toHaveLength(1);
    expect(comm.inbox(manager.id)).toHaveLength(0);
  });

  it('ignores mentions that are not members, and reports them', () => {
    const conversationId = groupConversation();
    const result = comm.routeGroupMessage({
      conversationId,
      messageId: 'msg-group-3',
      mentionIds: ['agent-outsider'],
      now: NOW,
    });

    expect(result.targets).toHaveLength(0);
    expect(result.ignored).toEqual(['agent-outsider']);
  });

  it('counts the boss as P0: the queue is used, the quota is not', () => {
    const conversationId = groupConversation();
    const before = comm.quota(manager.id, NOW);
    comm.routeGroupMessage({ conversationId, messageId: 'msg-group-4', now: NOW });

    expect(comm.quota(manager.id, NOW)).toEqual(before);
  });

  it('does not route a 1v1 thread', () => {
    const dm = chat.openDirect(report.id);
    const result = comm.routeGroupMessage({ conversationId: dm, messageId: 'msg-dm', now: NOW });
    expect(result.targets).toHaveLength(0);
  });

  it('the woken owner answers in the group and that turn is counted', async () => {
    const conversationId = groupConversation();
    // Bootstrap does this wiring; the test mirrors it so `sendMessage` routes here.
    chat.routeGroupMessage = (input) => void comm.routeGroupMessage(input);
    chat.sendMessage({ conversationId, text: '这周的进度谁来说一下' });

    // Routing replaced the inline timer reply: nothing else was appended.
    expect(chat.readTranscript(conversationId)).toHaveLength(1);

    const runner = createInboxRunner({
      comm,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId) as Agent,
      replyWithModel: async () => '我来说：接口联调完成，测试明天开始。',
      appendAgentMessage: (id, agent, text) => void chat.appendAgentMessage(id, agent, text),
    });

    const items = comm.claim(manager.id, NOW);
    expect(items).toHaveLength(1);
    await runner({ employeeId: manager.id, items, reason: 'signal', now: NOW });

    const transcript = chat.readTranscript(conversationId);
    expect(transcript.at(-1)?.senderId).toBe(manager.id);
    expect(chat.turnState(conversationId).turns).toBe(1);
    expect(comm.inbox(manager.id)).toHaveLength(0);
  });
});

describe('boss actions', () => {
  it('wakes a person on demand, without spending their quota or waiting for the heartbeat', async () => {
    const runner = vi.fn(async () => undefined);
    const scheduler = new CommScheduler({ comm, now: () => NOW, onWake: runner });

    // One wake already happened today, so the heartbeat is not due again.
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    await scheduler.tick();
    comm.sendDirectMessage({ fromEmployeeId: peer.id, toEmployeeId: report.id, text: 'b', now: NOW });
    const quotaBefore = comm.quota(report.id, NOW);

    const result = await scheduler.wakeNow(report.id);

    expect(result).toMatchObject({ ok: true, items: 1 });
    expect(runner).toHaveBeenCalledTimes(2);
    // §7.2: the boss is P0 and does not touch the recipient's daily quota.
    expect(comm.quota(report.id, NOW)).toEqual(quotaBefore);
    expect(comm.inbox(report.id)).toHaveLength(0);
  });

  it('says so instead of waking an empty inbox', async () => {
    const scheduler = new CommScheduler({ comm, now: () => NOW, onWake: async () => undefined });
    const result = await scheduler.wakeNow(report.id);
    expect(result.ok).toBe(false);
    expect(result.items).toBe(0);
  });

  it('dismisses guards without deleting the audit record', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'b', now: NOW });
    const open = comm.guards(report.id);
    expect(open.length).toBeGreaterThan(0);

    expect(comm.dismissGuards([open[0]!.id])).toBe(1);
    expect(comm.guards(report.id)).toHaveLength(open.length - 1);

    // The row is still there for audit; it is only marked as read.
    const kept = db
      .prepare('SELECT COUNT(*) AS n FROM guard_event WHERE dismissed_at IS NOT NULL')
      .get() as { n: number };
    expect(kept.n).toBe(1);

    expect(comm.dismissGuards()).toBe(open.length - 1);
    expect(comm.guards(report.id)).toHaveLength(0);
  });

  it('hides dismissed guards from the notification projection', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'b', now: NOW });
    const build = () =>
      buildCommOverview({
        comm,
        org,
        readTranscript: (conversationId) => chat.readTranscript(conversationId),
        now: () => NOW,
      });

    expect(build().guards.length).toBeGreaterThan(0);
    comm.dismissGuards();
    expect(build().guards).toHaveLength(0);
  });
});

describe('commSettingsFrom', () => {  it('reads the company policy and falls back to §4.2 defaults', () => {
    const settings = commSettingsFrom(db);
    expect(settings.heartbeatMs).toBe(15 * 60 * 1000);
    expect(settings.dailyWakeQuota).toBe(5);
    expect(settings.dmPerHour).toBe(10);
  });
});

/** A separate instance with its own brakes: the turn ceiling is 2 for these cases. */
function strictComm(overrides: Partial<CommSettings> = {}): CommService {
  return new CommService({
    repository: new CommRepository(db),
    org,
    transcript: chat,
    settings: { ...SETTINGS, maxConversationTurns: 2, dailyWakeQuota: 5, dmPerHour: 10, ...overrides },
  });
}

describe('turn limit (§7.3 ②)', () => {
  it('escalates the thread at the ceiling and records why', () => {
    const comm2 = strictComm();
    const first = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '一',
      now: NOW,
    });
    const second = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '二',
      now: NOW,
    });

    expect(first.ok && second.ok).toBe(true);
    // Two employee turns reached the budget: the thread is out of the automatic loop.
    expect(chat.turnState(first.conversationId ?? '')).toEqual({ turns: 2, status: 'escalated' });

    const guard = comm2.guards(manager.id).find((event) => event.kind === 'turn_limit');
    expect(guard?.detail).toMatchObject({ reason: 'limit_reached', turns: 2, limit: 2 });
  });

  it('refuses the next message instead of letting the two keep going', () => {
    const comm2 = strictComm();
    comm2.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: '一', now: NOW });
    comm2.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: '二', now: NOW });

    const third = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '三',
      now: NOW,
    });
    expect(third.ok).toBe(false);
    expect(third.code).toBe('CONVERSATION_ESCALATED');
    // Refused *before* writing: the transcript records what happened, not attempts.
    expect(comm2.transcriptSince(third.conversationId ?? '')).toHaveLength(2);
    expect(
      comm2.guards(manager.id).some(
        (event) => event.kind === 'turn_limit' && event.detail.reason === 'escalated',
      ),
    ).toBe(true);
  });

  it('stops the answering run from replying in an escalated thread', async () => {
    const comm2 = strictComm();
    const sent = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '接口测了吗',
      now: NOW,
    });
    comm2.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: '再问一句', now: NOW });
    expect(chat.turnState(sent.conversationId ?? '').status).toBe('escalated');

    const reply = vi.fn(async () => '测过了');
    const runner = createInboxRunner({
      comm: comm2,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId) as Agent,
      replyWithModel: reply,
      appendAgentMessage: (conversationId, agent, text) =>
        void chat.appendAgentMessage(conversationId, agent, text),
    });

    await runner({
      employeeId: report.id,
      items: comm2.claim(report.id, NOW),
      reason: 'signal',
      now: NOW,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(comm2.transcriptSince(sent.conversationId ?? '')).toHaveLength(2);
  });

  it('lets the boss lift the escalation, which resets the turn budget', () => {
    const comm2 = strictComm();
    const sent = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '一',
      now: NOW,
    });
    comm2.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: '二', now: NOW });

    // The boss answering *is* the resolution (§7.5: escalated → 老板处理 → open).
    chat.sendMessage({ conversationId: sent.conversationId ?? '', text: '这件事我来定' });
    expect(chat.turnState(sent.conversationId ?? '')).toEqual({ turns: 0, status: 'open' });

    const after = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '三',
      now: NOW,
    });
    expect(after.ok).toBe(true);
  });
});

describe('cooling (§7.5)', () => {
  it('cools an idle thread and warms it again when someone writes', () => {
    // A generous turn budget: this case is about the idle lifecycle, not the ceiling.
    const comm2 = strictComm({ maxConversationTurns: 6 });
    const now = Date.now();
    const sent = comm2.sendDirectMessage({
      fromEmployeeId: peer.id,
      toEmployeeId: report.id,
      text: '在吗',
      now,
    });

    // Real clock on purpose: `coolIdleConversations` reads `updated_at` from rows.
    const cooled = chat.coolIdleConversations(60_000, now + 5 * 60_000);
    expect(cooled).toContain(sent.conversationId);
    expect(chat.turnState(sent.conversationId ?? '').status).toBe('cooling');

    const again = comm2.sendDirectMessage({
      fromEmployeeId: peer.id,
      toEmployeeId: report.id,
      text: '再问一下',
      now: now + 10 * 60_000,
    });
    expect(again.ok).toBe(true);
    expect(chat.turnState(sent.conversationId ?? '').status).toBe('open');
  });

  it('keeps turns and status across a restart', () => {
    const comm2 = strictComm();
    const sent = comm2.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '一',
      now: NOW,
    });
    comm2.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: '二', now: NOW });

    // The conversation payload is the record: a restart must not forget the ceiling.
    const reopened = new ChatService({
      db,
      agents: agentsFromOrg(org),
      departments: chatDepartmentsFromOrg(org),
      conversations: [],
    });
    expect(reopened.turnState(sent.conversationId ?? '')).toEqual({
      turns: 2,
      status: 'escalated',
    });
    reopened.dispose();
  });
});

describe('buildCommOverview', () => {  const build = () =>
    buildCommOverview({
      comm,
      org,
      readTranscript: (conversationId) => chat.readTranscript(conversationId),
      now: () => NOW,
    });

  it('projects waiting work with the sender and a preview', () => {
    comm.sendDirectMessage({
      fromEmployeeId: manager.id,
      toEmployeeId: report.id,
      text: '把接口测试结果发我',
      now: NOW,
    });

    const overview = build();
    expect(overview.inbox).toHaveLength(1);
    expect(overview.inbox[0]).toMatchObject({
      employeeName: report.name,
      fromName: manager.name,
      priority: 1,
      requiresWake: true,
      preview: '把接口测试结果发我',
    });
    expect(overview.inbox[0]?.conversationId).toBeTruthy();
  });

  it('resolves names in guard details instead of leaking ids', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'b', now: NOW });

    const quotaGuard = build().guards.find((guard) => guard.kind === 'wake_quota');
    expect(quotaGuard?.employeeName).toBe(report.name);
    // The name is what the page prints; the id stays available but is never shown alone.
    expect(quotaGuard?.detail.fromName).toBe(manager.name);
  });

  it('shows relationship direction, strength and quotas for active people only', () => {
    comm.sendDirectMessage({ fromEmployeeId: manager.id, toEmployeeId: report.id, text: 'a', now: NOW });
    const overview = build();

    expect(overview.relationships).toEqual([
      expect.objectContaining({ fromName: manager.name, toName: report.name, kind: 'report' }),
    ]);
    expect(overview.relationships[0]?.strength).toBeGreaterThan(0.5);
    expect(overview.quotas.map((quota) => quota.employeeName)).toContain(report.name);
    expect(overview.quotas.find((quota) => quota.employeeName === report.name)).toMatchObject({
      limit: 1,
      used: 1,
      remaining: 0,
    });

    org.fire(peer.id);
    expect(build().quotas.map((quota) => quota.employeeName)).not.toContain(peer.name);
  });
});
