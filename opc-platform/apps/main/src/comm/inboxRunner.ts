import type { Agent, Message } from '@opc/shared/domain';
import type { InboxItem } from '../data/commRepository';
import type { CommService } from './commService';
import type { WakeInput } from './scheduler';

export interface InboxRunnerDeps {
  comm: CommService;
  agentFor: (employeeId: string) => Agent | undefined;
  /** Answers as the employee. Absent = the employee cannot answer at all. */
  replyWithModel?: (input: { agent: Agent; text: string; history: Message[] }) => Promise<string>;
  appendAgentMessage: (conversationId: string, agent: Agent, text: string) => void;
  /** Keep the prompt small: recent turns only, and never the whole history. */
  maxHistoryMessages?: number;
}

/**
 * What happens when an employee is woken for its inbox (§5.4 step "B 下次心跳时").
 *
 * The context is rebuilt from the `message` table — not from any private transcript —
 * because the sender may have said three more things while this employee slept.
 *
 * Two honest refusals instead of fake behaviour:
 * - no model configured → the items are closed *and* a `message_dropped` guard is
 *   recorded, so the boss sees the silence rather than wondering;
 * - the model fails → the items go back to the queue for the next heartbeat.
 *
 * The reply does not re-enqueue the sender: one exchange costs one wake, which is
 * what keeps a two-agent conversation from becoming a loop (§R4).
 */
export function createInboxRunner(deps: InboxRunnerDeps) {
  const maxHistory = deps.maxHistoryMessages ?? 12;

  return async ({ employeeId, items, now }: WakeInput): Promise<void> => {
    const byConversation = new Map<string, InboxItem[]>();
    for (const item of items) {
      if (!item.conversationId) continue;
      const group = byConversation.get(item.conversationId) ?? [];
      group.push(item);
      byConversation.set(item.conversationId, group);
    }

    // Task / approval / system items carry no chat: their source is the task card,
    // so there is nothing to answer here.
    const chatless = items.filter((item) => !item.conversationId);
    if (chatless.length > 0) deps.comm.complete(employeeId, chatless.map((item) => item.id), now);

    const agent = deps.agentFor(employeeId);
    for (const [conversationId, group] of byConversation) {
      const ids = group.map((item) => item.id);
      const transcript = deps.comm.transcriptSince(conversationId);
      const incoming = transcript.filter(
        (message) => message.senderId !== employeeId && message.kind === 'text' && message.text,
      );

      if (!agent || incoming.length === 0) {
        deps.comm.complete(employeeId, ids, now);
        continue;
      }

      // §7.3 ②: an escalated thread does not auto-reply. Close the items (they are
      // not lost — the boss will read the thread) and leave the reason on record.
      const state = deps.comm.turnState(conversationId);
      if (state.status === 'escalated') {
        deps.comm.recordGuard({
          employeeId,
          kind: 'turn_limit',
          detail: { reason: 'escalated', turns: state.turns },
          conversationId,
          now,
        });
        deps.comm.complete(employeeId, ids, now);
        continue;
      }

      if (!deps.replyWithModel) {
        deps.comm.recordGuard({
          employeeId,
          kind: 'message_dropped',
          detail: { reason: 'no_model', conversationId, messages: incoming.length },
          conversationId,
          now,
        });
        deps.comm.complete(employeeId, ids, now);
        continue;
      }

      try {
        const reply = await deps.replyWithModel({
          agent,
          text: promptOf(transcript, employeeId, maxHistory),
          history: transcript.slice(-maxHistory),
        });
        const trimmed = reply.trim();
        if (trimmed.length > 0) {
          deps.appendAgentMessage(conversationId, agent, trimmed);
          // The answering turn counts too: a reply loop must hit the same ceiling.
          deps.comm.noteAgentTurn({ conversationId, employeeId, now });
        }
        deps.comm.complete(employeeId, ids, now);
      } catch (error) {
        deps.comm.recordGuard({
          employeeId,
          kind: 'message_dropped',
          detail: { reason: 'model_failed', error: error instanceof Error ? error.message : String(error) },
          conversationId,
          now,
        });
        // Back to pending: a failed turn must be retried, not lost.
        deps.comm.requeue(employeeId, now);
      }
    }
  };
}

/** A compact, role-labelled transcript for the answering model. */
function promptOf(transcript: readonly Message[], employeeId: string, maxHistory: number): string {
  const recent = transcript.slice(-maxHistory);
  const lines = recent.map((message) => {
    const who = message.senderId === employeeId ? '我' : message.senderName;
    return `${who}：${message.text ?? ''}`;
  });
  return [
    '下面是同事发给你的消息，请作为「我」回复最后一条，简短、具体、不要说空话。',
    '',
    ...lines,
  ].join('\n');
}
