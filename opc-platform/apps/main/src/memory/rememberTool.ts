import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';

export interface RememberToolDeps {
  ownerId: string;
  /** Current task, so the memory points back at where it came from. */
  taskId: () => string | undefined;
  remember: (input: {
    content: string;
    scope: 'playbook' | 'topic';
    section?: string;
  }) => Promise<string>;
}

/**
 * Worker-side `remember`: saves a concrete reusable pitfall into `PLAYBOOK.md`
 * or a project fact into `topics/`. Workers never mutate `USER.md` or `RULES.md`.
 */
export function createRememberToolExtension(deps: RememberToolDeps) {
  return defineExtension({
    name: 'opc.memory',
    tools: [
      defineTool({
        name: 'remember',
        description:
          'Save one concrete, reusable lesson into PLAYBOOK.md (scope="playbook", default) or a project fact into topics/ (scope="topic"). For playbook pitfalls, write "避免：... → 正确做法：...". Never use for temporary task progress.',
        parameters: Type.Object({
          content: Type.String({
            description: 'One concise, actionable Chinese sentence or "避免：... → 正确做法：...".',
          }),
          scope: Type.Optional(
            Type.Union([Type.Literal('playbook'), Type.Literal('topic')], {
              description: 'playbook (pitfall/workaround, default) | topic (stable project/domain fact)',
            }),
          ),
          section: Type.Optional(
            Type.String({
              description: 'Optional scenario heading for playbook (e.g. Windows PowerShell) or topic slug/title.',
            }),
          ),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const content = args.content.trim();
          if (content.length < 4) {
            return { isError: true, output: [{ type: 'text' as const, text: '记忆内容太短，没有保存' }] };
          }
          const scope = args.scope === 'topic' ? 'topic' : 'playbook';
          const savedRef = await deps.remember({
            content,
            scope,
            ...(args.section?.trim() ? { section: args.section.trim() } : {}),
          });
          return {
            output: [{ type: 'text' as const, text: `已写入 ${savedRef}：${content}` }],
          };
        },
      }),
    ],
  });
}
