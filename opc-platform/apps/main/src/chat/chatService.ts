import type {
  Agent,
  ChatContentBlock,
  Conversation,
  ConversationStatus,
  Message,
  WorkTask,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { USER_MEMORY_OWNER } from '../memory/owners';
import type {
  AssistantActivity,
  AssistantActivityPhase,
  ChatMessagePage,
  ChatSearchInput,
  ChatSearchPage,
  ChatSnapshot,
  SendMessageInput,
} from '@opc/shared/ipc';
import type { ChatAttachmentRef } from '@opc/shared/domain';

/** Minimal id helper (main process only; never a database key). */
function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatClock(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Router 的脸。
 *
 * 聊天窗口里对面那个人是 **Router**，不是某个执行体。这是 Super-agent 双层架构
 * 的第一条（docs/v2/04-superagent-check.md §1）：Router 承接人类交互与分派，
 * Worker 在隔离的上下文里干活、不直接对人说话。
 *
 * 所以这条会话不需要「挑一个人来当替身」——Router 常驻，本来就有身份。
 * 执行体是随工作线临时存在的，它们只出现在工作线里。
 */
export const ROUTER_ID = 'router';
export const CHAT_MESSAGE_PAGE_SIZE = 100;
type StoredActionCard = Extract<ChatContentBlock, { type: 'approval' | 'workflow' | 'ontologyApproval' }>;

/** 聊天里说话的一方。`Agent` 结构上满足它；Router 不是 agent，也满足它。 */
interface Speaker {
  id: string;
  name: string;
  role?: string;
  level?: string;
  avatarUrl?: string;
}

function isActionCard(block: ChatContentBlock, type: 'approval' | 'workflow' | 'ontologyApproval', id: string): boolean {
  if (type === 'ontologyApproval') return block.type === 'ontologyApproval' && block.commandId === id;
  return (block.type === 'approval' || block.type === 'workflow') && block.type === type && block.reportId === id;
}

function isStoredActionCard(block: ChatContentBlock): block is StoredActionCard {
  return block.type === 'approval' || block.type === 'workflow' || block.type === 'ontologyApproval';
}

const ROUTER_FACE: Speaker = { id: ROUTER_ID, name: '助手', role: '调度' };

/**
 * v2 的聊天只有一条会话，对面是 Router。
 *
 * `agents` 是 v1 留下的（"和谁聊"）：现在是可选的、没有人会填，留着只是因为
 * `ChatSnapshot` 仍要一个形状。部门那一份（"在哪个部门群"）已经随组织一起删了。
 */
export interface ChatServiceSeed {
  agents?: Agent[];
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
  private initialOlderMessagesByConversation: Record<string, boolean> = {};
  private readonly routerStreams = new Map<string, { messageId: string; started: boolean; generation?: number }>();
  private readonly activityGenerations = new Map<string, number>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Injected by bootstrap: turns a settled conversation into long-term memory.
   * Absent (or model-less) means nothing is written — never invented lessons.
   */
  consolidate?: (input: {
    conversationId: string;
    ownerId: string;
    messages: { senderId: string; text: string }[];
  }) => Promise<{ written: number; skipped?: string }>;

  /**
   * Injected by bootstrap: 你说的话，交给调度层当成一条 Trigger（§3）。
   *
   * 注意方向：**这里不生成回复**。聊天是信道，不是大脑。你说什么进 Router，
   * Router 决定是自己接住还是派活；要说话时通过 `appendRouterMessage` 送回来。
   */
  onUserMessage?: (input: { conversationId: string; text: string; attachments?: ChatAttachmentRef[] }) => void;
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private activeConversationId: string | null = null;

  constructor(seed: ChatServiceSeed & { db?: CompanyDatabase }) {
    this.db = seed.db;
    const conversations = this.db
      ? this.loadConversations(seed.conversations)
      : seed.conversations.map(withVisibleMessages);
    this.snapshot = {
      agents: seed.agents ?? [],
      conversations,
      hasOlderMessagesByConversation: this.initialOlderMessagesByConversation,
      typingByConversation: {},
      activityByConversation: {},
    };
  }

  /** Stored conversations win; the seed is only used when nothing was persisted. */
  private loadConversations(seed: Conversation[]): Conversation[] {
    if (!this.db) return seed.map(withVisibleMessages);
    const rows = this.db
      .prepare('SELECT payload FROM conversation ORDER BY created_at')
      .all() as { payload: string }[];
    if (rows.length === 0) return seed.map(withVisibleMessages);

    return rows.map((row) => {
      const base = JSON.parse(row.payload) as Omit<Conversation, 'messages'>;
      const messageRows = this.db!
        .prepare(
          `SELECT payload FROM message
            WHERE conversation_id = ?
              AND COALESCE(json_extract(payload, '$.kind'), 'text') NOT IN ('task', 'deliverable')
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(base.id, CHAT_MESSAGE_PAGE_SIZE + 1) as { payload: string }[];
      const hasMore = messageRows.length > CHAT_MESSAGE_PAGE_SIZE;
      this.initialOlderMessagesByConversation[base.id] = hasMore;
      return withVisibleMessages({
        ...base,
        messages: messageRows
          .slice(0, CHAT_MESSAGE_PAGE_SIZE)
          .reverse()
          .map((message) => JSON.parse(message.payload) as Message),
      } as Conversation);
    });
  }

  loadOlderMessages = (conversationId: string, beforeMessageId: string): ChatMessagePage => {
    if (!this.db) {
      const messages = this.snapshot.conversations.find((item) => item.id === conversationId)?.messages ?? [];
      const beforeIndex = messages.findIndex((message) => message.id === beforeMessageId);
      if (beforeIndex <= 0) {
        this.setHasOlderMessages(conversationId, false);
        return { messages: [], hasMore: false };
      }
      const start = Math.max(0, beforeIndex - CHAT_MESSAGE_PAGE_SIZE);
      const hasMore = start > 0;
      this.setHasOlderMessages(conversationId, hasMore);
      return { messages: messages.slice(start, beforeIndex), hasMore };
    }

    const cursor = this.db
      .prepare('SELECT created_at, rowid AS row_id FROM message WHERE conversation_id = ? AND id = ?')
      .get(conversationId, beforeMessageId) as { created_at: number; row_id: number } | undefined;
    if (!cursor) {
      this.setHasOlderMessages(conversationId, false);
      return { messages: [], hasMore: false };
    }

    const rows = this.db
      .prepare(
        `SELECT payload FROM message
          WHERE conversation_id = ?
            AND (created_at, rowid) < (?, ?)
            AND COALESCE(json_extract(payload, '$.kind'), 'text') NOT IN ('task', 'deliverable')
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, cursor.created_at, cursor.row_id, CHAT_MESSAGE_PAGE_SIZE + 1) as { payload: string }[];
    const hasMore = rows.length > CHAT_MESSAGE_PAGE_SIZE;
    this.setHasOlderMessages(conversationId, hasMore);
    return {
      messages: rows
        .slice(0, CHAT_MESSAGE_PAGE_SIZE)
        .reverse()
        .map((row) => JSON.parse(row.payload) as Message),
      hasMore,
    };
  };

  searchMessages = (input: ChatSearchInput): ChatSearchPage => {
    const query = input.query?.trim().slice(0, 300).toLocaleLowerCase() ?? '';
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 30)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const from = input.from ? Date.parse(`${input.from}T00:00:00`) : undefined;
    const to = input.to ? Date.parse(`${input.to}T23:59:59.999`) : undefined;
    const matches = (message: Message, createdAt: number) =>
      (input.senderId === undefined || message.senderId === input.senderId) &&
      (input.kind === undefined || message.kind === input.kind) &&
      (!query || (message.text ?? '').toLocaleLowerCase().includes(query)) &&
      (from === undefined || !Number.isFinite(from) || createdAt >= from) &&
      (to === undefined || !Number.isFinite(to) || createdAt <= to);

    if (!this.db) {
      const rows = this.snapshot.conversations.flatMap((conversation) =>
        conversation.messages
          .filter((message) => message.kind !== 'task' && message.kind !== 'deliverable')
          .filter((message) => matches(message, Date.parse(message.timestamp) || 0))
          .map((message) => ({
            conversationId: conversation.id,
            conversationTitle: conversation.title,
            createdAt: Date.parse(message.timestamp) || 0,
            message,
          })),
      ).reverse();
      const page = rows.slice(offset, offset + limit + 1);
      return { results: page.slice(0, limit), hasMore: page.length > limit };
    }

    const clauses = ["COALESCE(json_extract(message.payload, '$.kind'), 'text') NOT IN ('task', 'deliverable')"];
    const params: (string | number)[] = [];
    if (query) {
      clauses.push("instr(lower(COALESCE(json_extract(message.payload, '$.text'), '')), ?) > 0");
      params.push(query);
    }
    if (input.senderId) {
      clauses.push("json_extract(message.payload, '$.senderId') = ?");
      params.push(input.senderId);
    }
    if (input.kind) {
      clauses.push("json_extract(message.payload, '$.kind') = ?");
      params.push(input.kind);
    }
    if (from !== undefined && Number.isFinite(from)) {
      clauses.push('message.created_at >= ?');
      params.push(from);
    }
    if (to !== undefined && Number.isFinite(to)) {
      clauses.push('message.created_at <= ?');
      params.push(to);
    }
    const rows = this.db.prepare(
      `SELECT message.conversation_id, message.payload, message.created_at, conversation.payload AS conversation_payload
         FROM message JOIN conversation ON conversation.id = message.conversation_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY message.created_at DESC, message.rowid DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit + 1, offset) as {
      conversation_id: string;
      payload: string;
      created_at: number;
      conversation_payload: string;
    }[];
    return {
      results: rows.slice(0, limit).map((row) => ({
        conversationId: row.conversation_id,
        conversationTitle: (JSON.parse(row.conversation_payload) as Conversation).title,
        createdAt: row.created_at,
        message: JSON.parse(row.payload) as Message,
      })),
      hasMore: rows.length > limit,
    };
  };

  /** Action cards are few; let SQLite find their rows without hydrating transcripts. */
  readActionCards = (): { conversationId: string; block: StoredActionCard }[] => {
    if (!this.db) {
      return this.snapshot.conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) =>
          (message.content ?? [])
            .filter(isStoredActionCard)
            .map((block) => ({ conversationId: conversation.id, block })),
        ),
      );
    }
    const rows = this.db
      .prepare(
        `SELECT conversation_id, payload FROM message AS m
          WHERE EXISTS (
            SELECT 1 FROM json_each(m.payload, '$.content') AS block
            WHERE json_extract(block.value, '$.type') IN ('approval', 'workflow', 'ontologyApproval')
          )`,
      )
      .all() as { conversation_id: string; payload: string }[];
    return rows.flatMap((row) => {
      const message = JSON.parse(row.payload) as Message;
      return (message.content ?? [])
        .filter(isStoredActionCard)
        .map((block) => ({ conversationId: row.conversation_id, block }));
    });
  };

  /** Conversation metadata and the current hot message window are durable. */
  private persist(conversationId: string): void {
    if (!this.db) return;
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const messages = conversation.messages.filter((message) => !message.streaming);
    const latest = messages.filter((message) => message.kind !== 'task' && message.kind !== 'deliverable').at(-1);
    const { messages: _transientMessages, ...rest } = conversation;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversation (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(conversation.id, JSON.stringify({
        ...rest,
        lastMessage: latest ? previewOf(latest) : '还没有对话',
        ...(latest ? { timestamp: latest.timestamp } : {}),
      }), now, now);

    const insert = this.db.prepare(
      `INSERT INTO message (id, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
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

  /** Start a user-visible assistant turn and return its stale-update guard. */
  beginActivity = (conversationId: string): number | undefined => {
    if (!this.snapshot.conversations.some((item) => item.id === conversationId)) return undefined;
    const generation = (this.activityGenerations.get(conversationId) ?? 0) + 1;
    this.activityGenerations.set(conversationId, generation);
    this.clearActivityTimer(conversationId);
    this.setActivity(conversationId, 'delivered', generation);
    return generation;
  };

  getActivity = (conversationId: string): AssistantActivity | undefined =>
    this.snapshot.activityByConversation[conversationId];

  getActivityGeneration = (conversationId: string): number | undefined =>
    this.activityGenerations.get(conversationId);

  /** Update a phase only when it belongs to the current assistant turn. */
  setActivity = (
    conversationId: string,
    phase: AssistantActivityPhase,
    generation?: number,
  ): boolean => {
    if (!this.snapshot.conversations.some((item) => item.id === conversationId)) return false;
    if (generation !== undefined && generation !== this.activityGenerations.get(conversationId)) return false;
    const previous = this.snapshot.activityByConversation[conversationId];
    if (previous?.phase === phase) return true;
    this.clearActivityTimer(conversationId);
    this.commit({
      activityByConversation: {
        ...this.snapshot.activityByConversation,
        [conversationId]: { phase, updatedAt: Date.now() },
      },
    });
    return true;
  };

  /** Show the short completion acknowledgement, then return to the idle state. */
  completeActivity = (conversationId: string, generation?: number): boolean => {
    if (!this.setActivity(conversationId, 'completed', generation)) return false;
    const timer = setTimeout(() => {
      if (generation !== undefined && generation !== this.activityGenerations.get(conversationId)) return;
      this.setActivity(conversationId, 'idle', generation);
      this.activityTimers.delete(conversationId);
    }, 1_800);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.activityTimers.set(conversationId, timer);
    return true;
  };

  showActivityError = (conversationId: string, generation?: number): boolean => {
    if (!this.setActivity(conversationId, 'error', generation)) return false;
    const timer = setTimeout(() => {
      if (generation !== undefined && generation !== this.activityGenerations.get(conversationId)) return;
      this.setActivity(conversationId, 'idle', generation);
      this.activityTimers.delete(conversationId);
    }, 2_500);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.activityTimers.set(conversationId, timer);
    return true;
  };

  private clearActivityTimer(conversationId: string): void {
    const timer = this.activityTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.activityTimers.delete(conversationId);
  }

  /**
   * 你和 Router 之间唯一的那条会话。
   *
   * v2 之后没有「会话列表」——用户感觉始终只和一个 Agent 打交道，而那个人是
   * **Router**。这里不再需要挑一个人来当门面：Router 常驻，所以「还没有可用的
   * 人」这个状态不存在了，返回值也不再可空。
   */
  ensureAssistant = (): string => {
    const existing = this.snapshot.conversations.find(
      (conversation) =>
        conversation.kind === 'dm' &&
        conversation.memberIds.length === 1 &&
        conversation.memberIds[0] === ROUTER_ID,
    );
    if (existing) return existing.id;

    const conversation: Conversation = {
      id: `dm-${ROUTER_ID}`,
      title: ROUTER_FACE.name,
      kind: 'dm',
      memberIds: [ROUTER_ID],
      messages: [],
      lastMessage: '还没有对话',
      timestamp: formatClock(),
    };
    this.commit({ conversations: [conversation, ...this.snapshot.conversations] });
    return conversation.id;
  };

  /**
   * **删掉的一整条路**：`openDirect(agentId)`。
   *
   * 它曾经给某个执行体开一条私聊，然后 `pickResponders` 把它拉进来、用它的岗位
   * 人设回答你。这正是 §2.2 禁止的事——Worker 的推理和工具调用不该直接出现在
   * 人类面前——而且它把双层架构悄悄压回单层：你的每句话都落进某个执行体的上下文，
   * Router 完全不在人机路径上。
   *
   * 现在聊天只有一条会话（`ensureAssistant`），对面永远是 Router。
   */

  /**
   * An employee's own message, appended to the transcript.
   *
   * This is the only way an agent writes into a conversation: the message table
   * stays the single source of truth (§P1), and you sees the exchange in the
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
      // left alone on purpose — only you may lift that (§7.5).
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
   * Escalation (§7.3 ②): the thread stops auto-replying and waits for you.
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
   * The your intervention lifts an escalation and resets the turn budget, which is
   * exactly the doc's `escalated →(你处理)→ open`.
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
        return rows.map((row) => JSON.parse(row.payload) as Message).filter((message) => message.kind !== 'task' && message.kind !== 'deliverable');
      }
    }
    return this.snapshot.conversations.find((item) => item.id === conversationId)?.messages
      .filter((message) => message.kind !== 'task' && message.kind !== 'deliverable').slice() ?? [];
  };

  /** Runs consolidation for one conversation (no-op without a summariser). */
  consolidateConversation = async (conversationId: string): Promise<{ written: number; skipped?: string }> => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation || !this.consolidate) return { written: 0, skipped: '未启用巩固' };
    // 这条会话的对面是**这个人**，不是 Router。巩固出来的教训是关于他的，所以挂在
    // 用户身上——挂在 Router 名下的话，只有 Router 读得到，干活的人永远看不到。
    const counterpart = conversation.memberIds[0];
    const ownerId = counterpart === ROUTER_ID ? USER_MEMORY_OWNER : counterpart;
    if (!ownerId) return { written: 0, skipped: '这条会话还没有归属' };
    return this.consolidate({
      conversationId,
      ownerId,
      messages: this.readTranscript(conversationId)
        .filter((message) => message.kind === 'text' && message.text)
        .map((message) => ({ senderId: message.senderId, text: message.text ?? '' })),
    });
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

  sendMessage = ({ conversationId, text, attachments }: SendMessageInput): void => {
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
        ...(attachments?.length ? { attachments } : {}),
      },
      { read: true },
    );
    this.beginActivity(conversationId);

    // §7.5: 你介入即解除升级/冷却。You answering *is* the resolution.
    if (conversation.status && conversation.status !== 'open') {
      this.reopenConversation(conversation.id);
    }

    // 对面永远是 Router（§2 双层架构）。
    //
    // v1 在这里会「挑一个 agent 用它的岗位人设回答」，那条路已经删了：Worker 只向
    // Router 汇报，不直接对人说话。所以不管这句话落在哪条会话上，它都只是一条
    // Trigger——写成"发给某个人"就等于又有了第二个人在回答你。
    //
    // `mentionIds`（@ 某人）随之失去意义：这里没有人可以被叫来，能接话的只有 Router。
    this.onUserMessage?.({ conversationId: conversation.id, text, ...(attachments?.length ? { attachments } : {}) });
  };

  /**
   * Router 对你说话。
   *
   * 整个系统里只有这一个地方能让人看见 Router 的结论（§2.2：执行体不直接与人
   * 交互，由 Router 统一回复）。所以它只有一个入口，而且不经过任何"挑谁来回"的
   * 逻辑——说话的就是 Router 本身。
   */
  appendRouterMessage = (conversationId: string, text: string, content?: ChatContentBlock[]): void => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    this.appendReply(conversation, ROUTER_FACE, text, content);
    this.completeActivity(conversationId);
  };

  /** Start an ephemeral Router message. It becomes durable only when finished. */
  beginRouterStream = (conversationId: string): string | undefined => {
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return undefined;
    this.clearRouterStream(conversationId);
    const messageId = createId('msg');
    this.routerStreams.set(conversationId, {
      messageId,
      started: false,
      ...(this.getActivityGeneration(conversationId) !== undefined
        ? { generation: this.getActivityGeneration(conversationId) }
        : {}),
    });
    return messageId;
  };

  /** Replace the visible partial text without writing every token to SQLite. */
  updateRouterStream = (conversationId: string, messageId: string, text: string): void => {
    const state = this.routerStreams.get(conversationId);
    if (!state || state.messageId !== messageId || !text) return;
    const conversation = this.snapshot.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    this.setActivity(conversationId, 'typing', state.generation);
    const content: ChatContentBlock[] = [{ type: 'markdown', text }];
    if (!state.started) {
      state.started = true;
      this.appendMessage(
        conversation,
        {
          id: messageId,
          kind: 'text',
          senderId: ROUTER_FACE.id,
          senderName: ROUTER_FACE.name,
          senderRole: ROUTER_FACE.role,
          timestamp: formatClock(),
          text,
          content,
          streaming: true,
        },
        { read: conversation.id === this.activeConversationId, persist: false },
      );
      return;
    }
    this.patchStreamMessage(conversationId, messageId, (message) => ({
      ...message,
      text,
      content,
      streaming: true,
    }), false);
  };

  /** Commit the final answer, or remove the transient message on a tool reply/error. */
  finishRouterStream = (conversationId: string, messageId: string, text?: string): void => {
    const state = this.routerStreams.get(conversationId);
    if (!state || state.messageId !== messageId) return;
    this.routerStreams.delete(conversationId);
    if (!state.started) {
      if (text?.trim()) this.appendRouterMessage(conversationId, text);
      return;
    }
    if (!text?.trim()) {
      this.removeStreamMessage(conversationId, messageId, false);
      return;
    }
    this.patchStreamMessage(conversationId, messageId, (message) => ({
      ...message,
      text,
      content: [{ type: 'markdown', text }],
      streaming: false,
    }), true);
    this.completeActivity(conversationId, state.generation);
  };

  /** Drop a partial answer that is superseded by a structured `reply_to_user` call. */
  clearRouterStream = (conversationId: string): void => {
    const state = this.routerStreams.get(conversationId);
    if (!state) return;
    this.routerStreams.delete(conversationId);
    if (state.started) this.removeStreamMessage(conversationId, state.messageId, false);
  };

  appendApprovalCard = (conversationId: string, input: Extract<ChatContentBlock, { type: 'approval' }>): void => {
    this.appendRouterMessage(conversationId, input.body, [input]);
    this.setActivity(conversationId, 'waiting_user');
  };

  appendWorkflowCard = (conversationId: string, input: Extract<ChatContentBlock, { type: 'workflow' }>): void => {
    this.appendRouterMessage(conversationId, input.body, [input]);
    this.setActivity(conversationId, 'waiting_user');
  };

  appendOntologyApprovalCard = (conversationId: string, input: Extract<ChatContentBlock, { type: 'ontologyApproval' }>): void => {
    this.appendRouterMessage(conversationId, input.body, [input]);
    this.setActivity(conversationId, 'waiting_user');
  };

  updateApprovalCard = (
    reportId: string,
    _state: Extract<ChatContentBlock, { type: 'approval' }>['state'],
  ): void => {
    this.removeActionCard('approval', reportId);
  };

  updateWorkflowCard = (reportId: string, state: Extract<ChatContentBlock, { type: 'workflow' }>['state']): void => {
    // A resolved workflow card is an acknowledgement, not a historical chat
    // message. Remove it just like a resolved tool approval so it cannot come
    // back from the persisted transcript when the user changes pages.
    if (state === 'resolved') {
      this.removeActionCard('workflow', reportId);
      return;
    }
    if (this.db) {
      const rows = this.actionCardRows('workflow', reportId);
      const updatedById = new Map<string, Message>();
      for (const row of rows) {
        const message = JSON.parse(row.payload) as Message;
        const updated = {
          ...message,
          content: message.content?.map((block) =>
            block.type === 'workflow' && block.reportId === reportId ? { ...block, state } : block,
          ),
        };
        this.db.prepare('UPDATE message SET payload = ? WHERE conversation_id = ? AND id = ?')
          .run(JSON.stringify(updated), row.conversation_id, message.id);
        updatedById.set(message.id, updated);
      }
      if (updatedById.size > 0) {
        this.commit({ conversations: this.snapshot.conversations.map((conversation) => ({
          ...(conversation.messages.some((message) => updatedById.has(message.id))
            ? {
                ...conversation,
                messages: conversation.messages.map((message) => updatedById.get(message.id) ?? message),
              }
            : conversation),
        })) });
      }
      return;
    }
    this.commit({
      conversations: this.snapshot.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          content: message.content?.map((block) =>
            block.type === 'workflow' && block.reportId === reportId ? { ...block, state } : block,
          ),
        })),
      })),
    });
  };

  updateOntologyApprovalCard = (commandId: string, state: Extract<ChatContentBlock, { type: 'ontologyApproval' }>['state']): void => {
    if (state === 'approved' || state === 'rejected') {
      this.removeActionCard('ontologyApproval', commandId);
    }
  };

  private removeActionCard(
    type: 'approval' | 'workflow' | 'ontologyApproval',
    reportId: string,
  ): void {
    if (this.db) {
      const rows = this.actionCardRows(type, reportId);
      const changedByConversation = new Map<string, Set<string>>();
      const updatedById = new Map<string, Message>();
      const deletedIds = new Set<string>();
      for (const row of rows) {
        const message = JSON.parse(row.payload) as Message;
        const content = message.content ?? [];
        const remaining = content.filter((block) => !isActionCard(block, type, reportId));
        const changed = changedByConversation.get(row.conversation_id) ?? new Set<string>();
        changed.add(message.id);
        changedByConversation.set(row.conversation_id, changed);
        if (remaining.length > 0) {
          const updated = { ...message, content: remaining };
          this.db.prepare('UPDATE message SET payload = ? WHERE conversation_id = ? AND id = ?')
            .run(JSON.stringify(updated), row.conversation_id, message.id);
          updatedById.set(message.id, updated);
        } else {
          this.db.prepare('DELETE FROM message WHERE conversation_id = ? AND id = ?')
            .run(row.conversation_id, message.id);
          deletedIds.add(message.id);
        }
      }
      if (changedByConversation.size === 0) return;

      const latestByConversation = new Map<string, Message | undefined>();
      const latestQuery = this.db.prepare(
        `SELECT payload FROM message WHERE conversation_id = ?
          AND COALESCE(json_extract(payload, '$.kind'), 'text') NOT IN ('task', 'deliverable')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      );
      for (const conversationId of changedByConversation.keys()) {
        const row = latestQuery.get(conversationId) as { payload: string } | undefined;
        latestByConversation.set(conversationId, row ? JSON.parse(row.payload) as Message : undefined);
      }
      this.commit({ conversations: this.snapshot.conversations.map((conversation) => {
        const changedIds = changedByConversation.get(conversation.id);
        if (!changedIds) return conversation;
        const messages = conversation.messages
          .filter((message) => !deletedIds.has(message.id))
          .map((message) => updatedById.get(message.id) ?? message);
        const latest = latestByConversation.get(conversation.id);
        return {
          ...conversation,
          messages,
          lastMessage: latest ? previewOf(latest) : '还没有对话',
          ...(latest ? { timestamp: latest.timestamp } : {}),
        };
      }) });
      return;
    }

    const conversations = this.snapshot.conversations.map((conversation) => {
      let changed = false;
      const messages = conversation.messages.flatMap((message) => {
        const content = message.content;
        if (!content?.some((block) => isActionCard(block, type, reportId))) {
          return [message];
        }

        changed = true;
        const remaining = content.filter(
          (block) => !isActionCard(block, type, reportId),
        );
        if (remaining.length > 0) {
          const updated = { ...message, content: remaining };
          return [updated];
        }
        return [];
      });

      if (!changed) return conversation;
      const latest = messages
        .filter((message) => message.kind !== 'task' && message.kind !== 'deliverable')
        .at(-1);
      return {
        ...conversation,
        messages,
        lastMessage: latest ? previewOf(latest) : '还没有对话',
        ...(latest ? { timestamp: latest.timestamp } : {}),
      };
    });
    this.commit({ conversations });
  }

  private actionCardRows(type: 'approval' | 'workflow' | 'ontologyApproval', id: string): { conversation_id: string; payload: string }[] {
    if (!this.db) return [];
    const idField = type === 'ontologyApproval' ? 'commandId' : 'reportId';
    return this.db.prepare(
      `SELECT conversation_id, payload FROM message AS m
        WHERE EXISTS (
          SELECT 1 FROM json_each(m.payload, '$.content') AS block
          WHERE json_extract(block.value, '$.type') = ?
            AND json_extract(block.value, '$.${idField}') = ?
        )`,
    ).all(type, id) as { conversation_id: string; payload: string }[];
  }

  private setHasOlderMessages(conversationId: string, hasMore: boolean): void {
    if (this.snapshot.hasOlderMessagesByConversation[conversationId] === hasMore) return;
    this.commit({
      hasOlderMessagesByConversation: {
        ...this.snapshot.hasOlderMessagesByConversation,
        [conversationId]: hasMore,
      },
    }, { persist: false });
  }

  /**
   * Inserts or refreshes the task card in the assignee's DM, so you watches
   * the same object move from running → accepted without polling.
   */
  upsertTaskCard = (task: WorkTask): void => {
    // Execution state belongs to task/line views, never to chat history.
    void task;
  };

  dispose = (): void => {
    this.listeners.clear();
  };

  // ── internals ──────────────────────────────────────────────────────────

  private appendReply(conversation: Conversation, speaker: Speaker, text: string, content?: ChatContentBlock[]): void {
    this.appendMessage(
      conversation,
      {
        id: createId('msg'),
        kind: 'text',
        senderId: speaker.id,
        senderName: speaker.name,
        senderRole: [speaker.role, speaker.level].filter(Boolean).join(' · '),
        senderAvatarUrl: speaker.avatarUrl,
        timestamp: formatClock(),
        text,
        ...(content?.length ? { content } : {}),
      },
      { read: conversation.id === this.activeConversationId },
    );
  }

  private appendMessage(
    conversation: Conversation,
    message: Message,
    { read, persist = true }: { read: boolean; persist?: boolean },
  ): void {
    const hasOlderMessagesByConversation = { ...this.snapshot.hasOlderMessagesByConversation };
    this.commit({
      conversations: this.snapshot.conversations.map((item) => {
        if (item.id !== conversation.id) return item;
        const unread = read ? 0 : (item.unreadCount ?? 0) + 1;
        const messages = [...item.messages, message];
        if (this.db && messages.length > CHAT_MESSAGE_PAGE_SIZE) {
          hasOlderMessagesByConversation[item.id] = true;
          messages.splice(0, messages.length - CHAT_MESSAGE_PAGE_SIZE);
        }
        return {
          ...item,
          messages,
          lastMessage: previewOf(message),
          timestamp: message.timestamp,
          unreadCount: unread || undefined,
        };
      }),
      hasOlderMessagesByConversation,
    }, { persist });
  }

  private patchStreamMessage(
    conversationId: string,
    messageId: string,
    update: (message: Message) => Message,
    persist: boolean,
  ): void {
    const current = this.snapshot.conversations
      .find((conversation) => conversation.id === conversationId)
      ?.messages.find((message) => message.id === messageId);
    if (!current) return;
    const next = update(current);
    this.commit({
      conversations: this.snapshot.conversations.map((conversation) =>
        conversation.id !== conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === messageId ? next : message,
              ),
              lastMessage: previewOf(next),
            },
      ),
    }, { persist });
  }

  private removeStreamMessage(conversationId: string, messageId: string, persist: boolean): void {
    this.db?.prepare('DELETE FROM message WHERE conversation_id = ? AND id = ?').run(conversationId, messageId);
    this.commit({
      conversations: this.snapshot.conversations.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        const messages = conversation.messages.filter((message) => message.id !== messageId);
        const latest = messages.filter((message) => message.kind !== 'task' && message.kind !== 'deliverable').at(-1);
        return {
          ...conversation,
          messages,
          lastMessage: latest ? previewOf(latest) : '还没有对话',
          ...(latest ? { timestamp: latest.timestamp } : {}),
        };
      }),
    }, { persist });
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

  private commit(patch: Partial<ChatSnapshot>, options: { persist?: boolean } = {}): void {
    const previous = this.snapshot;
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.conversations && options.persist !== false) {
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

function withVisibleMessages<T extends Conversation>(conversation: T): T {
  const messages = conversation.messages.filter(
    (message) => message.kind !== 'task' && message.kind !== 'deliverable',
  );
  const latest = messages.at(-1);
  return {
    ...conversation,
    messages,
    lastMessage: latest ? previewOf(latest) : '还没有对话',
    ...(latest ? { timestamp: latest.timestamp } : {}),
  };
}
