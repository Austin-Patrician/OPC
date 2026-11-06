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
import type { ChatSnapshot, SendMessageInput } from '@opc/shared/ipc';

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

/** 聊天里说话的一方。`Agent` 结构上满足它；Router 不是 agent，也满足它。 */
interface Speaker {
  id: string;
  name: string;
  role?: string;
  level?: string;
  avatarUrl?: string;
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
  onUserMessage?: (input: { conversationId: string; text: string }) => void;
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private activeConversationId: string | null = null;

  constructor(seed: ChatServiceSeed & { db?: CompanyDatabase }) {
    this.db = seed.db;
    this.snapshot = {
      agents: seed.agents ?? [],
      conversations: this.db
        ? this.loadConversations(seed.conversations)
        : seed.conversations.map(withVisibleMessages),
      typingByConversation: {},
    };
  }

  /** Stored conversations win; the seed is only used when nothing was persisted. */
  private loadConversations(seed: Conversation[]): Conversation[] {
    if (!this.db) return seed.map(withVisibleMessages);
    const rows = this.db
      .prepare('SELECT payload FROM conversation ORDER BY created_at')
      .all() as { payload: string }[];
    if (rows.length === 0) return seed.map(withVisibleMessages);

    const messageRows = this.db
      .prepare('SELECT conversation_id, payload FROM message ORDER BY created_at, rowid')
      .all() as { conversation_id: string; payload: string }[];

    return rows.map((row) => {
      const base = JSON.parse(row.payload) as Omit<Conversation, 'messages'>;
      return withVisibleMessages({
        ...base,
        messages: messageRows
          .filter((message) => message.conversation_id === base.id)
          .map((message) => JSON.parse(message.payload) as Message),
      } as Conversation);
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
    const messages = conversation.messages
      .filter((message) => message.kind === 'text' && message.text)
      .map((message) => ({ senderId: message.senderId, text: message.text ?? '' }));
    return this.consolidate({ conversationId, ownerId, messages });
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

  sendMessage = ({ conversationId, text }: SendMessageInput): void => {
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
    this.onUserMessage?.({ conversationId: conversation.id, text });
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
  };

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
