import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';

export interface RememberToolDeps {
  employeeId: string;
  /** Current task, so the memory points back at where it came from. */
  taskId: () => string | undefined;
  remember: (input: {
    content: string;
    kind: 'experience' | 'fact' | 'preference' | 'summary';
  }) => Promise<string>;
}

/**
 * `remember`: the agent's own way to keep something. Without it a worker can only
 * learn from finished tasks; with it "下次注意 X" survives the run.
 *
 * Scope is decided by the host (personal + optional department), never by the
 * model, so a worker cannot write into another team's memory.
 */
export function createRememberToolExtension(deps: RememberToolDeps) {
  return defineExtension({
    name: 'opc.memory',
    tools: [
      defineTool({
        name: 'remember',
        description:
          'Save one durable lesson for your future self (a pitfall, a preference you were told, a fact about this project). Use it when something would be expensive to rediscover. Write one short sentence, not a paragraph.',
        parameters: Type.Object({
          content: Type.String({ description: 'One sentence, self-contained, in Chinese.' }),
          kind: Type.Optional(
            Type.String({ description: 'experience | fact | preference | summary (default experience)' }),
          ),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const content = args.content.trim();
          if (content.length < 4) {
            return { isError: true, output: [{ type: 'text' as const, text: '记忆内容太短，没有保存' }] };
          }
          const allowed = ['experience', 'fact', 'preference', 'summary'] as const;
          const requested = args.kind?.trim().toLowerCase();
          const kind = (allowed as readonly string[]).includes(requested ?? '')
            ? (requested as (typeof allowed)[number])
            : 'experience';

          await deps.remember({ content, kind });
          return {
            output: [{ type: 'text' as const, text: `已记住（${kind}）：${content}` }],

          };
        },
      }),
    ],
  });
}
