import type { ConsolidationRunStore } from './consolidationRun';
import type { MemoryService } from './memoryService';

export interface ConversationSlice {
  conversationId: string;
  employeeId: string;
  messages: { senderId: string; text: string }[];
}

/** Injected by bootstrap; a model is the only honest way to summarise a chat. */
export type Summarizer = (input: {
  messages: ConversationSlice['messages'];
}) => Promise<{ content: string; kind: 'experience' | 'fact' | 'preference' | 'summary' }[]>;

/**
 * Consolidation (design §6.3, "下班反思"): after a conversation settles, its
 * substance becomes long-term memory instead of scrollback.
 *
 * Deliberately model-driven: without a summarizer we write nothing rather than
 * inventing lessons nobody said. Each memory keeps `source_type='consolidation'`
 * and the conversation id, so it can be traced back — and deleted — later.
 */
export async function consolidateConversation(
  memory: MemoryService,
  conversation: ConversationSlice,
  summarize: Summarizer | undefined,
  options: { minMessages?: number; runs?: ConsolidationRunStore } = {},
): Promise<{ written: number; skipped?: string }> {
  const messages = conversation.messages.filter((message) => (message.text ?? '').trim().length > 0);
  const runId = options.runs?.start({
    employeeId: conversation.employeeId,
    conversationIds: [conversation.conversationId],
    episodeCount: messages.length,
  });
  const close = (result: Parameters<ConsolidationRunStore['finish']>[1]) => {
    if (runId) options.runs?.finish(runId, result);
  };

  if (!summarize) {
    // Counted, not hidden: "no model configured" is a real outcome.
    close({ status: 'skipped', error: '未配置模型，跳过巩固' });
    return { written: 0, skipped: '未配置模型，跳过巩固' };
  }
  if (messages.length < (options.minMessages ?? 2)) {
    close({ status: 'skipped', error: '会话太短，不值得巩固' });
    return { written: 0, skipped: '会话太短，不值得巩固' };
  }

  try {
    const lessons = await summarize({ messages: messages.slice(-40) });
    let written = 0;
    for (const lesson of lessons) {
      const content = lesson.content.trim();
      if (content.length < 6) continue;
      await memory.remember({
        employeeId: conversation.employeeId,
        kind: lesson.kind,
        content,
        scope: { type: 'personal' },
        sourceType: 'consolidation',
        sourceId: conversation.conversationId,
      });
      written += 1;
    }
    close({ status: 'done', created: written });
    return { written };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    close({ status: 'failed', error: message });
    throw error;
  }
}
