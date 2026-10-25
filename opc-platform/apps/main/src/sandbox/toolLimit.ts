import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';

const calls = new Map<string, number>();

/**
 * Hard cap on tool calls per conversation.
 *
 * A weak model can loop "write → read → edit → check" indefinitely; every round
 * re-sends the whole transcript, so the cost grows quadratically. Blocking the
 * call still returns a tool result, which lets the model conclude instead of
 * failing the task.
 */
export function createToolLimitExtension(limit = Number(process.env.OPC_MAX_TOOL_CALLS ?? 12)) {
  return defineExtension({
    name: 'opc.limits',
    hooks: [
      hook(ToolTask, {
        beforeTool: (_call, api) => {
          const key = String(api.conversationId);
          const used = (calls.get(key) ?? 0) + 1;
          calls.set(key, used);

          if (used > limit) {
            return {
              block: `已达到本任务的工具调用上限（${limit} 次）。请基于已有文件直接结束，不要继续调用工具。`,
            };
          }
          return undefined;
        },
      }),
    ],
  });
}
