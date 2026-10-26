import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { SendDmResult } from './commService';

export interface CommToolDeps {
  /** The employee whose turn this is; the harness is per employee. */
  employeeId: string;
  /** Colleagues this employee may talk to, with the reason they are reachable. */
  colleagues: () => { id: string; name: string; role: string; reportsToMe: boolean; manager: boolean }[];
  sendDirectMessage: (input: { fromEmployeeId: string; toEmployeeId: string; text: string }) => SendDmResult;
  /** Marks a conversation as read without replying (zero tokens, §R4). */
  ackConversation: (employeeId: string, conversationId: string) => number;
  /** Conversation this run was woken for, so `ack_message` needs no argument. */
  currentConversationId: () => string | undefined;
}

/**
 * Talking to colleagues, and the cheap way to not talk.
 *
 * `send_direct_message` is the only channel between two employees: it creates no
 * task (P4 — a message is not work), spends the *recipient's* wake quota, and
 * refuses with a structured reason when the brake is on. `ack_message` exists so a
 * well-behaved employee can close a thread without generating a reply, which is the
 * difference between a colleague and a chat bot.
 */
export function createCommToolExtension(deps: CommToolDeps) {
  return defineExtension({
    name: 'opc.comm',
    tools: [
      defineTool({
        name: 'send_direct_message',
        description:
          'Send a direct message to one colleague. Use it to ask a question, hand over context, or report back. It does not create a task: to assign work, use decompose_task (managers only).',
        parameters: Type.Object({
          toEmployeeId: Type.String({ description: 'id of the colleague' }),
          text: Type.String({ minLength: 1, maxLength: 4000 }),
        }),
        execute: async (args) => {
          const result = deps.sendDirectMessage({
            fromEmployeeId: deps.employeeId,
            toEmployeeId: args.toEmployeeId,
            text: args.text,
          });

          if (!result.ok) {
            // Explicit string map: a tool result is JSON, which has no `undefined`.
            const details: Record<string, string> = { code: result.code ?? 'UNKNOWN' };
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `消息未发出：${result.message}` }],
              details,
            };
          }

          const details: Record<string, string> = {};
          if (result.conversationId) details.conversationId = result.conversationId;
          if (result.messageId) details.messageId = result.messageId;
          if (result.delivery) details.delivery = result.delivery;

          return {
            output: [
              {
                type: 'text' as const,
                text: `${result.message}${result.delivery === 'queued' ? '（不会立刻看到，等它自己的心跳）' : ''}`,
              },
            ],
            details,
          };
        },
      }),
      defineTool({
        name: 'ack_message',
        description:
          'Mark the conversation you were woken for as read without replying. Use it when the message needs no answer; it costs no tokens and keeps you from becoming a chatterbox.',
        parameters: Type.Object({
          conversationId: Type.Optional(
            Type.String({ description: 'defaults to the conversation that woke you' }),
          ),
        }),
        execute: async (args) => {
          const conversationId = args.conversationId ?? deps.currentConversationId();
          if (!conversationId) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '当前没有可以确认的对话' }],
            };
          }
          const closed = deps.ackConversation(deps.employeeId, conversationId);
          return {
            output: [
              {
                type: 'text' as const,
                text: closed > 0 ? `已确认，关闭了 ${closed} 条待办` : '这段对话没有待办',
              },
            ],
            details: { conversationId, closed },
          };
        },
      }),
    ],
  });
}
