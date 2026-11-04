import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { SubagentAnswer, SubagentToolApi } from './subagent';

/**
 * `investigate`：把一段思考交给一个干净的上下文去查。
 *
 * 三道闸门，每一道都对应一个具体的代价：
 *
 * 1. **深度 1**。子代理不能再派子代理——这条链上没有任何一层在收敛，成本失控，而收益
 *    在第一层就拿到了。实现上它是"同一时刻只允许一个在跑"：子代理调用它时，外层还没返回，
 *    于是这次调用直接被拒。串行与深度因此是同一个开关。
 * 2. **一次任务最多三次**。每次都是一整轮工具调用，是唯一能把单个任务的成本放大一个
 *    数量级的机制。三次以上，模型该自己查了。
 * 3. **空问题不派**。没有问题的子代理只会拿回一段泛泛的话，还要付一笔钱。
 */

export const MAX_INVESTIGATIONS = 3;

export interface InvestigateToolDeps {
  /** 正在跑的父任务。空 = 没有作用域，不派。 */
  taskId: () => string | undefined;
  /**
   * 真的去跑。失败不传染：这里抛错会被工具收成一句"没查出来"。
   *
   * `api` 必须原样传下去：子会话要归**这次工具调用**所有，那个所有权只有
   * 工具调用的 api 能建（`api.commit(tx => tx.createConversation(…))`）。
   */
  run: (
    input: { taskId: string; question: string; expects: string },
    api: SubagentToolApi,
    context: Context,
  ) => Promise<SubagentAnswer>;
  /** 记进父任务的步骤流。子代理对 Router 透明，但对你和 Watchdog 必须可见。 */
  log: (taskId: string, text: string) => void;
}

/**
 * 同一时刻只允许一个在跑，按**任务**键。
 *
 * 之所以是模块级而不是闭包级：子代理跑在另一份存储里，它的工具集是另一次
 * `buildRegistry` 的产物——闭包状态各算各的，深度就会变成 2。按任务键放在进程里，
 * 父在那里挂着的时候，子代理再调它得到的就是"已经有一个在查了"，深度自然是 1。
 *
 * 串行与深度因此是同一个开关，这不是巧合：它们回答的是同一个问题——**这一层还能不能再
 * 分出去**。
 */
const inFlight = new Set<string>();

/** 每个任务派过几次。父任务结束就没人再来查它，所以不必清理。 */
const used = new Map<string, number>();

export function createInvestigateToolExtension(deps: InvestigateToolDeps) {
  return defineExtension({
    name: 'opc.investigate',
    tools: [
      defineTool({
        name: 'investigate',
        description:
          '派一个干净上下文的子代理去查一件事，拿回一句结论。适合"先查清几个事实再决定怎么写"：' +
          '你只拿到结论，不拿到它的过程，所以你的上下文不会被它的日志淹掉。' +
          `一次任务最多派 ${MAX_INVESTIGATIONS} 次，且一次只能有一个在跑。不要用它拆交付物（那是 decompose）。`,
        parameters: Type.Object({
          question: Type.String({ description: '要查清什么，一句话说清。' }),
          expects: Type.Optional(
            Type.String({ description: '希望拿回什么：结论 / 对比 / 一个文件路径 / 一段命令输出。' }),
          ),
        }),
        execute: async (args, api, context): Promise<ToolExecutionResult> => {
          const question = args.question.trim();
          if (question.length < 4) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '要查什么？问题太短了。' }],
            };
          }
          const taskId = deps.taskId();
          if (!taskId) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '现在没有在跑的任务，不派子代理。' }],
            };
          }
          if (inFlight.has(taskId)) {
            return {
              isError: true,
              output: [
                {
                  type: 'text' as const,
                  text: '已经有一个子代理在查了。一次只派一个，等它回来再派下一个。',
                },
              ],
            };
          }
          const count = used.get(taskId) ?? 0;
          if (count >= MAX_INVESTIGATIONS) {
            return {
              isError: true,
              output: [
                {
                  type: 'text' as const,
                  text:
                    `这个任务已经派过 ${MAX_INVESTIGATIONS} 次子代理了。剩下的自己查` +
                    `（read / grep / bash），或者把不确定的地方写进结论里。`,
                },
              ],
            };
          }

          inFlight.add(taskId);
          used.set(taskId, count + 1);
          deps.log(taskId, `[查 ${count + 1}] ${question}`);
          try {
            const result = await deps.run(
              { taskId, question, expects: args.expects?.trim() ?? '' },
              api,
              context,
            );
            deps.log(
              taskId,
              `[查 ${count + 1}] 回来了：${result.answer.replace(/\s+/g, ' ').slice(0, 80)}`,
            );
            return {
              output: [
                { type: 'text' as const, text: render(result) },
                { type: 'text' as const, text: usageLine(result) },
              ],
            };
          } catch (error) {
            // 失败不传染：父还可以自己查或换路子。把一次可恢复的探索升格成任务失败，
            // 是拿最贵的单位（尝试次数）去付最便宜的账。
            const reason = error instanceof Error ? error.message : String(error);
            deps.log(taskId, `[查 ${count + 1}] 没查成：${reason}`);
            return {
              isError: true,
              output: [
                {
                  type: 'text' as const,
                  text: `子代理没查成（${reason}）。你可以自己查，或者在没有这个事实的情况下继续。`,
                },
              ],
            };
          } finally {
            inFlight.delete(taskId);
          }
        },
      }),
    ],
  });
}

function render(result: SubagentAnswer): string {
  const lines = ['子代理回来了：', '', result.answer.trim() || '（它没有留下结论）'];
  if (result.written.length > 0) {
    lines.push(
      '',
      `它动过的文件（在它的临时目录里，不在你的交付目录）：${result.written.join('、')}`,
      '要用就自己写进工作目录——那才是会被验收的东西。',
    );
  }
  return lines.join('\n');
}

function usageLine(result: SubagentAnswer): string {
  return result.costUsd > 0
    ? `（这次查账记在你身上：${result.tokens} tokens · $${result.costUsd.toFixed(4)}）`
    : `（这次查账记在你身上：${result.tokens} tokens）`;
}
