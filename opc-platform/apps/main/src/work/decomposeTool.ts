import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { SubtaskDraft, TaskError, WorkTask } from '@opc/shared/domain';

export interface DecomposeToolDeps {
  requesterId: string;
  /** Resolved per call: the harness is cached per employee, tasks are not. */
  parentTaskId: () => string | undefined;
  decompose: (
    parentTaskId: string,
    requesterId: string,
    subtasks: readonly SubtaskDraft[],
  ) => { ok: true; created: WorkTask[] } | { ok: false; error: TaskError };
}

/**
 * `decompose_task`: how a manager hands work down.
 *
 * The tool only proposes; the host enforces depth, fan-out, budget conservation
 * and the reporting line, then creates ordinary child tasks (same loop,
 * acceptance and budget as boss-dispatched work).
 */
export function createDecomposeToolExtension(deps: DecomposeToolDeps) {
  return defineExtension({
    name: 'opc.decompose',
    tools: [
      defineTool({
        name: 'decompose_task',
        description:
          'Split your task into subtasks assigned to your direct reports. Each subtask needs a deliverable and an estimated token budget that fits inside your task.',
        parameters: Type.Object({
          subtasks: Type.Array(
            Type.Object({
              title: Type.String(),
              brief: Type.String(),
              deliverableSpec: Type.String(),
              assigneeId: Type.String({ description: 'id of a direct report' }),
              estTokens: Type.Number({ minimum: 100 }),
              acceptanceTemplate: Type.Optional(
                Type.Union([Type.Literal('http-ok'), Type.Literal('image-200')]),
              ),
            }),
            { minItems: 1, maxItems: 8 },
          ),
        }),
        execute: async (args) => {
          const parentTaskId = deps.parentTaskId();
          if (!parentTaskId) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '当前没有可拆解的任务' }],
            };
          }
          const result = deps.decompose(parentTaskId, deps.requesterId, args.subtasks);
          if (!result.ok) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `拆解被拒绝：${result.error.message}` }],
            };
          }

          const list = result.created.map((task) => `${task.assigneeName}: ${task.title}`).join('\n');
          return {
            output: [
              {
                type: 'text' as const,
                text: `已创建 ${result.created.length} 个子任务：\n${list}`,
              },
            ],
            details: { ids: result.created.map((task) => task.id) },
          };
        },
      }),
    ],
  });
}
