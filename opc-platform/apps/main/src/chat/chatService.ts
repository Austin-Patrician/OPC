import type {
  Agent,
  Conversation,
  ConversationKind,
  ConversationStatus,
  Message,
  WorkTask,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { ChatSnapshot, SendMessageInput } from '@opc/shared/ipc';

/** Minimal id helper (main process only; never a database key). */
function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatClock(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export interface ChatServiceSeed {
  agents: Agent[];
  departments: ChatSnapshot['departments'];
  conversations: Conversation[];
}

/**
 * In-memory chat service, owned by the Electron main process.
 *
 * It is the stand-in for the real `WorkService`/`CommService` until SQLite and
 * the pi runtime land, but it already lives on the correct side of the IPC
 * boundary: the renderer can only read snapshots and call intents.
 */
export class ChatService {
  private snapshot: ChatSnapshot;
  private readonly db?: CompanyDatabase;
  /**
   * Injected by bootstrap: turns a settled conversation into long-term memory.
   * Absent (or model-less) means nothing is written — never invented lessons.
   */
  consolidate?: (input: {
    conversationId: string;
    employeeId: string;
    messages: { senderId: string; text: string }[];
  }) => Promise<{ written: number; skipped?: string }>;

  /** Injected by bootstrap; the only way an agent can actually answer. */
  replyWithModel?: (input: { agent: Agent; text: string; history: Message[] }) => Promise<string>;
  /**
   * Injected by bootstrap: §7.4 routing for group/channel messages.
   * Absent (e.g. in a probe) keeps the inline reply path.
   */
  routeGroupMessage?: (input: {
    conversationId: string;
    messageId: string;
    mentionIds?: readonly string[];
  }) => void;
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private activeConversationId: string | null = null;

  constructor(seed: ChatServiceSeed & { db?: CompanyDatabase }) {
    this.db = seed.db;
    this.snapshot = {
      agents: seed.agents,
      departments: seed.departments,
      conversations: this.db ? this.loadConversations(seed.conversations) : seed.conversations,
      typingByConversation: {},
    };
  }

  /** Stored conversations win; the seed is only used when nothing was persisted. */
  private loadConversations(seed: Conversation[]): Conversation[] {
    if (!this.db) return seed;
    const rows = this.db
      .prepare('SELECT payload FROM conversation ORDER BY created_at')
      .all() as { payload: string }[];
    if (rows.length === 0) return seed;

    const messageRows = this.db
      .prepare('SELECT conversation_id, payload FROM message ORDER BY created_at, rowid')
      .all() as { conversation_id: string; payload: string }[];

    return rows.map((row) => {
      const base = JSON.parse(row.payload) as Omit<Conversation, 'messages'>;
      const messages = messageRows
        .filter((message) => message.conversation_id === base.id)
        .map((message) => JSON.parse(message.payload) as Message);
      return { ...base, messages };
    });
  }

  /** Conversation row + its message rows: the whole conversation is durable. */
  private persist(conversationId: string): void {
    if (!this.db) return;
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const { messages, ...rest } = conversation;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversation (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(conversation.id, JSON.stringify(rest), now, now);

    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO message (id, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const message of messages) {
      insert.run(message.id, conversation.id, JSON.stringify(message), now);
    }
  }

  getSnapshot = (): ChatSnapshot => this.snapshot;

  subscribe = (listener: (snapshot: ChatSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Opens the 1v1 with an employee, creating it on first use. `displayName` lets
   * the caller resolve someone hired after the chat seed was built.
   */
  openDirect = (agentId: string, displayName?: string): string => {
    const existing = this.snapshot.conversations.find(
      // `memberIds.length === 1` keeps boss↔agent threads apart from peer threads,
      // which carry both participants.
      (conversation) =>
        conversation.kind === 'dm' &&
        conversation.memberIds.length === 1 &&
        conversation.memberIds[0] === agentId,
    );
    if (existing) return existing.id;

    const agent = this.snapshot.agents.find((item) => item.id === agentId);
    const title = agent?.name ?? displayName ?? agentId;
    const conversation: Conversation = {
      id: `dm-${agentId}`,
      title,
      kind: 'dm',
      memberIds: [agentId],
      messages: [],
      lastMessage: '还没有对话',
      timestamp: formatClock(),
    };
    this.commit({ conversations: [conversation, ...this.snapshot.conversations] });
    return conversation.id;
  };

  /**
   * The peer thread between two employees (F5). Distinct from `openDirect`, which
   * is the boss's 1v1: this one carries both participants and no `primaryAgentId`,
   * so the boss's own thread with either of them is untouched.
   */
  openPeerDirect = (fromAgentId: string, toAgentId: string): string => {
    const pair = [fromAgentId, toAgentId].sort();
    const existing = this.snapshot.conversations.find(
      (conversation) =>
        conversation.kind === 'dm' &&
        conversation.memberIds.length === 2 &&
        [...conversation.memberIds].sort().join() === pair.join(),
    );
    if (existing) return existing.id;

    const nameOf = (id: string) => this.snapshot.agents.find((agent) => agent.id === id)?.name ?? id;
    const conversation: Conversation = {
      id: `dm-${pair.join('--')}`,
      title: `${nameOf(pair[0] ?? '')} × ${nameOf(pair[1] ?? '')}`,
      kind: 'dm',
      memberIds: [...pair],
      messages: [],
      lastMessage: '同事之间开始对话',
      timestamp: formatClock(),
    };
    this.commit({ conversations: [conversation, ...this.snapshot.conversations] });
    return conversation.id;
  };

  /**
   * An employee's own message, appended to the transcript.
   *
   * This is the only way an agent writes into a conversation: the message table
   * stays the single source of truth (§P1), and the boss sees the exchange in the
   * same list as everything else. Each agent message is one *turn* — the counter the
   * turn limit is enforced against (§7.3 ②) — and posting warms a cooling thread.
   */
  appendAgentMessage = (
    conversationId: string,
    from: { id: string; name: string; role?: string; avatarUrl?: string },
    text: string,
  ): Message | undefined => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return undefined;
    if (!conversation.memberIds.includes(from.id)) return undefined;

    const message: Message = {
      id: createId('msg'),
      kind: 'text',
      senderId: from.id,
      senderName: from.name,
      ...(from.role ? { senderRole: from.role } : {}),
      ...(from.avatarUrl ? { senderAvatarUrl: from.avatarUrl } : {}),
      timestamp: formatClock(),
      text,
    };
    this.appendMessage(conversation, message, { read: conversation.id === this.activeConversationId });
    this.patchConversation(conversationId, (item) => ({
      ...item,
      turnCount: (item.turnCount ?? 0) + 1,
      // Work arriving in a cooling thread means it is live again; `escalated` is
      // left alone on purpose — only the boss may lift that (§7.5).
      ...(item.status === 'cooling' ? { status: 'open' as const, statusChangedAt: Date.now() } : {}),
    }));
    return message;
  };

  /** Turns used so far and the §7.5 lifecycle state of one thread. */
  turnState = (conversationId: string): { turns: number; status: ConversationStatus } => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    return {
      turns: conversation?.turnCount ?? 0,
      status: conversation?.status ?? 'open',
    };
  };

  /**
   * Escalation (§7.3 ②): the thread stops auto-replying and waits for the boss.
   * Idempotent, because the same overrun is seen by both the sender and the runner.
   */
  escalateConversation = (conversationId: string): boolean => {
    const state = this.turnState(conversationId);
    if (state.status === 'escalated') return false;
    this.patchConversation(conversationId, (item) => ({
      ...item,
      status: 'escalated',
      statusChangedAt: Date.now(),
    }));
    return true;
  };

  /** §7.5: an idle thread cools down; it may still be read, it just stops replying. */
  coolConversation = (conversationId: string): boolean => {
    const state = this.turnState(conversationId);
    if (state.status !== 'open') return false;
    this.patchConversation(conversationId, (item) => ({
      ...item,
      status: 'cooling',
      statusChangedAt: Date.now(),
    }));
    return true;
  };

  /**
   * The boss's intervention lifts an escalation and resets the turn budget, which is
   * exactly the doc's `escalated →(老板处理)→ open`.
   */
  reopenConversation = (conversationId: string): boolean => {
    const state = this.turnState(conversationId);
    if (state.status === 'open' && state.turns === 0) return false;
    this.patchConversation(conversationId, (item) => ({
      ...item,
      status: 'open',
      turnCount: 0,
      statusChangedAt: Date.now(),
    }));
    return true;
  };

  /** Cools every thread idle longer than `idleMs` (the stage before archiving). */
  coolIdleConversations = (idleMs: number, now = Date.now()): string[] => {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM conversation
          WHERE archived_at IS NULL AND consolidated_at IS NULL AND updated_at <= ?
          ORDER BY updated_at LIMIT 50`,
      )
      .all(now - idleMs) as { id: string }[];

    const cooled: string[] = [];
    for (const row of rows) {
      if (this.coolConversation(row.id)) cooled.push(row.id);
    }
    return cooled;
  };

  /**
   * The transcript as *storage* has it, not as this process happens to remember it.
   *
   * §5.4: the recipient may have been asleep while three more messages arrived, so
   * its context must be rebuilt from `message` rows, never from a private cache.
   */
  readTranscript = (conversationId: string): Message[] => {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT payload FROM message WHERE conversation_id = ? ORDER BY created_at, rowid')
        .all(conversationId) as { payload: string }[];
      if (rows.length > 0) {
        return rows.map((row) => JSON.parse(row.payload) as Message);
      }
    }
    return (
      this.snapshot.conversations.find((item) => item.id === conversationId)?.messages.slice() ?? []
    );
  };

  /** Opens the department group chat, creating it with the current roster. */
  ensureDepartmentGroup = (departmentId: string, displayName?: string): string => {
    const existing = this.snapshot.conversations.find(
      (conversation) => conversation.kind === 'group' && conversation.departmentId === departmentId,
    );
    if (existing) return existing.id;

    const department = this.snapshot.departments.find((item) => item.id === departmentId);
    const members = this.snapshot.agents
      .filter((agent) => agent.departmentId === departmentId)
      .map((agent) => agent.id);
    const name = department?.name ?? displayName ?? departmentId;
    const conversation: Conversation = {
      id: `group-${departmentId}`,
      title: `${name} · 部门群`,
      kind: 'group',
      departmentId,
      memberIds: members,
      messages: [],
      lastMessage: `群聊已创建（${members.length} 名成员）`,
      timestamp: formatClock(),
    };
    this.commit({ conversations: [conversation, ...this.snapshot.conversations] });
    return conversation.id;
  };

  /**
   * Re-reads the org and re-derives everything that is a projection of it.
   *
   * The snapshot used to be built once at startup, which made the org chart and the
   * IM side disagree the moment someone was hired or moved: a new employee never
   * joined their department group until the app restarted. A department group's
   * roster is a view of `position`, so it is recomputed here rather than stored.
   */
  syncOrg = (agents: Agent[], departments: ChatSnapshot['departments']): void => {
    const roster = new Map<string, string[]>();
    for (const agent of agents) {
      const bucket = roster.get(agent.departmentId);
      if (bucket) bucket.push(agent.id);
      else roster.set(agent.departmentId, [agent.id]);
    }

    let changed = false;
    const conversations = this.snapshot.conversations.map((conversation) => {
      if (conversation.kind !== 'group' || !conversation.departmentId) return conversation;
      const members = roster.get(conversation.departmentId) ?? [];
      const before = conversation.memberIds;
      if (before.length === members.length && before.every((id, index) => id === members[index])) {
        return conversation;
      }
      changed = true;
      return { ...conversation, memberIds: members };
    });

    this.commit({ agents, departments, ...(changed ? { conversations } : {}) });
  };

  /** Runs consolidation for one conversation (no-op without a summariser). */
  consolidateConversation = async (conversationId: string): Promise<{ written: number; skipped?: string }> => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation || !this.consolidate) return { written: 0, skipped: '未启用巩固' };
    const employeeId = conversation.memberIds[0];
    if (!employeeId) return { written: 0, skipped: '没有绑定员工' };
    const messages = conversation.messages
      .filter((message) => message.kind === 'text' && message.text)
      .map((message) => ({ senderId: message.senderId, text: message.text ?? '' }));
    return this.consolidate({ conversationId, employeeId, messages });
  };

  /**
   * Archives one conversation and consolidates it exactly once. Archiving is the
   * trigger the design calls "会话归档 → 巩固"; a second call is a no-op, so a
   * sweep that runs twice cannot duplicate memories.
   */
  archiveConversation = async (conversationId: string): Promise<{ archived: boolean; written: number }> => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return { archived: false, written: 0 };
    if (conversation.archivedAt) return { archived: false, written: 0 };

    this.commit({
      conversations: this.snapshot.conversations.map((item) =>
        item.id === conversationId ? { ...item, archivedAt: Date.now(), unreadCount: 0 } : item,
      ),
    });
    this.db
      ?.prepare('UPDATE conversation SET archived_at = ? WHERE id = ?')
      .run(Date.now(), conversationId);

    let written = 0;
    try {
      const result = await this.consolidateConversation(conversationId);
      written = result.written;
      this.db
        ?.prepare('UPDATE conversation SET consolidated_at = ? WHERE id = ?')
        .run(Date.now(), conversationId);
    } catch (error) {
      // Consolidation failing must not resurrect the conversation.
      console.warn('consolidate failed', conversationId, error);
    }
    return { archived: true, written };
  };

  /**
   * Brings an archived conversation back into the active list. `consolidated_at`
   * is intentionally kept, so restoring cannot trigger a second consolidation.
   */
  restoreConversation = (conversationId: string): void => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation?.archivedAt) return;
    this.commit({
      conversations: this.snapshot.conversations.map((item) =>
        item.id === conversationId ? { ...item, archivedAt: undefined } : item,
      ),
    });
    this.db
      ?.prepare('UPDATE conversation SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), conversationId);
  };

  /** Archives every conversation idle longer than `idleMs` (no activity, not archived). */
  sweepIdleConversations = async (idleMs: number, now = Date.now()): Promise<string[]> => {
    if (!this.db) return [];
    const cutoff = now - idleMs;
    const rows = this.db
      .prepare(
        `SELECT id FROM conversation
          WHERE archived_at IS NULL AND consolidated_at IS NULL AND updated_at <= ?
          ORDER BY updated_at LIMIT 20`,
      )
      .all(cutoff) as { id: string }[];

    const archived: string[] = [];
    for (const row of rows) {
      const result = await this.archiveConversation(row.id);
      if (result.archived) archived.push(row.id);
    }
    return archived;
  };

  markRead = (conversationId: string): void => {
    this.activeConversationId = conversationId;
    const target = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!target?.unreadCount) return;

    this.commit({
      conversations: this.snapshot.conversations.map((item) =>
        item.id === conversationId ? { ...item, unreadCount: 0 } : item,
      ),
    });
  };

  updateAgentBrief = (agentId: string, briefMd: string): void => {
    this.commit({
      agents: this.snapshot.agents.map((agent) =>
        agent.id === agentId ? { ...agent, briefMd } : agent,
      ),
    });
  };

  sendMessage = ({ conversationId, text, mentionIds }: SendMessageInput): void => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;

    const now = formatClock();
    const messageId = createId('msg');
    this.appendMessage(
      conversation,
      {
        id: messageId,
        kind: 'text',
        senderId: 'user',
        senderName: '我',
        timestamp: now,
        text,
      },
      { read: true },
    );

    // §7.5: 老板介入即解除升级/冷却。The boss answering *is* the resolution.
    if (conversation.status && conversation.status !== 'open') {
      this.reopenConversation(conversation.id);
    }

    // §7.4: a group/channel message is routed by the comm layer — nobody @-ed means
    // only the owner is woken, otherwise exactly the mentioned people. That path goes
    // through the inbox and the heartbeat, so it must not *also* schedule a timer reply.
    if (conversation.kind !== 'dm' && this.routeGroupMessage) {
      this.routeGroupMessage({ conversationId, messageId, ...(mentionIds ? { mentionIds } : {}) });
      return;
    }

    const responders = this.pickResponders(conversation, mentionIds);
    if (responders.length === 0) return;

    this.setTyping(conversationId, responders.map((agent) => agent.name));

    this.later(760, async () => {
      const [first] = responders;
      if (!first) return;

      const reply = await this.buildReply(first, text);
      this.appendReply(conversation, first, reply);
      this.setTyping(conversationId, []);
    });
  };

  /** Routing facts the comm layer needs; no members = not a conversation we route. */
  conversationInfo = (
    conversationId: string,
  ): { kind: ConversationKind; departmentId?: string; memberIds: readonly string[] } | undefined => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return undefined;
    return {
      kind: conversation.kind,
      ...(conversation.departmentId ? { departmentId: conversation.departmentId } : {}),
      memberIds: conversation.memberIds,
    };
  };

  /**
   * Inserts or refreshes the task card in the assignee's DM, so the boss watches
   * the same object move from running → accepted without polling.
   */
  upsertTaskCard = (task: WorkTask): void => {
    const messageId = `task-card-${task.id}`;
    const target =
      this.snapshot.conversations.find(
        (item) => item.kind === 'dm' && item.primaryAgentId === task.assigneeId,
      ) ?? this.snapshot.conversations[0];
    if (!target) return;

    const previous = target.messages.find((message) => message.id === messageId);
    const card: Message = {
      id: messageId,
      kind: 'task',
      senderId: task.assigneeId,
      senderName: task.assigneeName,
      timestamp: formatClock(),
      task,
    };

    this.commit({
      conversations: this.snapshot.conversations.map((item) => {
        if (item.id !== target.id) return item;
        const messages = previous
          ? item.messages.map((message) => (message.id === messageId ? card : message))
          : [...item.messages, card];
        return {
          ...item,
          messages,
          lastMessage: previewOf(card),
          timestamp: card.timestamp,
        };
      }),
    });
  };

  dispose = (): void => {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.listeners.clear();
  };

  // ── internals ──────────────────────────────────────────────────────────

  private later(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
  }

  private pickResponders(conversation: Conversation, mentionIds?: string[]): Agent[] {
    const members = conversation.memberIds
      .map((id) => this.snapshot.agents.find((agent) => agent.id === id))
      .filter((agent): agent is Agent => Boolean(agent));

    if (mentionIds?.length) {
      const mentioned = members.filter((agent) => mentionIds.includes(agent.id));
      if (mentioned.length > 0) return mentioned.slice(0, 2);
    }

    if (conversation.kind === 'dm') {
      const primary = members.find((agent) => agent.id === conversation.primaryAgentId);
      return primary ? [primary] : members.slice(0, 1);
    }

    return members.slice(0, 2);
  }

  /**
   * A reply must come from a model. Without one there is no honest answer to give,
   * so say exactly that instead of inventing a plausible-sounding plan.
   */
  private async buildReply(agent: Agent, text: string): Promise<string> {
    if (this.replyWithModel) {
      try {
        const answer = await this.replyWithModel({
          agent,
          text,
          history: this.snapshot.conversations.flatMap((item) => item.messages).filter((message) => message.kind === 'text'),
        });
        if (answer.trim()) return answer.trim();
      } catch (error) {
        return `（模型调用失败：${error instanceof Error ? error.message : String(error)}）`;
      }
    }
    return `（还没配置可用模型，我无法回答「${text.slice(0, 30)}」这类问题。到 设置 → 模型 配好 provider 后，我会直接用模型回你。）`;
  }

  private appendReply(conversation: Conversation, agent: Agent, text: string): void {
    this.appendMessage(
      conversation,
      {
        id: createId('msg'),
        kind: 'text',
        senderId: agent.id,
        senderName: agent.name,
        senderRole: `${agent.role} · ${agent.level}`,
        senderAvatarUrl: agent.avatarUrl,
        timestamp: formatClock(),
        text,
      },
      { read: conversation.id === this.activeConversationId },
    );
  }

  private appendMessage(
    conversation: Conversation,
    message: Message,
    { read }: { read: boolean },
  ): void {
    this.commit({
      conversations: this.snapshot.conversations.map((item) => {
        if (item.id !== conversation.id) return item;
        const unread = read ? 0 : (item.unreadCount ?? 0) + 1;
        return {
          ...item,
          messages: [...item.messages, message],
          lastMessage: previewOf(message),
          timestamp: message.timestamp,
          unreadCount: unread || undefined,
        };
      }),
    });
  }

  /** Replaces one conversation object; `commit` persists whichever rows changed. */
  private patchConversation(
    conversationId: string,
    update: (conversation: Conversation) => Conversation,
  ): void {
    this.commit({
      conversations: this.snapshot.conversations.map((item) =>
        item.id === conversationId ? update(item) : item,
      ),
    });
  }

  private setTyping(conversationId: string, names: string[]): void {    const next: Record<string, readonly string[]> = { ...this.snapshot.typingByConversation };
    if (names.length > 0) next[conversationId] = names;
    else delete next[conversationId];
    this.commit({ typingByConversation: next });
  }

  private commit(patch: Partial<ChatSnapshot>): void {
    const previous = this.snapshot;
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.conversations) {
      const touched = new Set(
        this.snapshot.conversations
          .filter((conversation) => {
            const before = previous.conversations.find((item) => item.id === conversation.id);
            return !before || before !== conversation;
          })
          .map((conversation) => conversation.id),
      );
      // Any conversation whose message list changed is durable as well.
      for (const conversation of this.snapshot.conversations) {
        const before = previous.conversations.find((item) => item.id === conversation.id);
        if (!before || before.messages.length !== conversation.messages.length) touched.add(conversation.id);
      }
      for (const id of touched) this.persist(id);
    }
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}

function previewOf(message: Message): string {
  if (message.kind === 'task') {
    return `[任务·${message.task?.status ?? 'open'}] ${message.task?.title ?? ''}`;
  }
  if (message.kind === 'deliverable') return message.deliverable?.title ?? '交付物';
  const text = message.text ?? '';
  return message.senderId === 'user' ? text : `${message.senderName}: ${text}`;
}
