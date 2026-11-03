import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';

/**
 * `recall`：执行体自己回源头看。
 *
 * 提示词里给的是**摘要**，这里给全文。没有它，执行体就只能在 Router 的转述上工作
 * ——而转述是有损的，且无法自纠。
 *
 * 和 Router 的 `recall` 同名同义，只有一个区别：**作用域**。Router 能查全局（它是
 * 序点），执行体只能查自己这条线上的东西。这不是客气，是隔离：一条线的上下文不该
 * 从另一条线漏进来。
 *
 * 读侧限长是硬的（复用 `recallView` 的分页）：把全文倒回上下文，等于把 spill 白做了。
 */

export type RecallOutcome =
  | { found: true; text: string }
  /** `out-of-scope` 与 `not-found` 必须分开说：前者是边界，后者是打错了。 */
  | { found: false; reason: 'out-of-scope' | 'not-found' | 'no-task' };

export interface RecallToolDeps {
  /** 正在跑的任务。作用域由它的 `threadId` 决定，不由模型决定。 */
  taskId: () => string | undefined;
  recall: (input: { taskId: string; id: string; page: number }) => RecallOutcome;
}

const REASONS: Record<Exclude<RecallOutcome, { found: true }>['reason'], string> = {
  'out-of-scope': '那条记录不在这条工作线上。只能看自己这条线上的事件、汇报和任务。',
  'not-found': '找不到这条记录：可能是 id 打错了，或者它已经不在了。',
  'no-task': '现在没有在跑的任务，无从取回。',
};

export function createRecallToolExtension(deps: RecallToolDeps) {
  return defineExtension({
    name: 'opc.recall',
    tools: [
      defineTool({
        name: 'recall',
        description:
          '取回一条记录的全文（事件 / 汇报 / 之前的任务）。提示词里给出的是摘要，' +
          '需要原话、原始报错、完整日志时用它。长内容分页，下一页用同一个 id 加页码。',
        parameters: Type.Object({
          id: Type.String({ description: '记录 id，例如 ev-1a2b、rp-3c4d、task-5e6f' }),
          page: Type.Optional(Type.Number({ description: '第几页，默认 1' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const taskId = deps.taskId();
          if (!taskId) {
            return { isError: true, output: [{ type: 'text' as const, text: REASONS['no-task'] }] };
          }
          const id = args.id.trim();
          if (!id) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '要取哪一条？给一个 id。' }],
            };
          }
          const page = Number.isFinite(args.page) ? Math.max(1, Math.floor(args.page ?? 1)) : 1;
          const outcome = deps.recall({ taskId, id, page });
          if (!outcome.found) {
            return { isError: true, output: [{ type: 'text' as const, text: REASONS[outcome.reason] }] };
          }
          return { output: [{ type: 'text' as const, text: outcome.text }] };
        },
      }),
    ],
  });
}
