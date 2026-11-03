import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';

/**
 * 执行体只有终局的那张嘴——这是一个必须修的结构缺陷。
 *
 * 它遇到需要更大视野的决定时，今天只有两条路：猜，或者失败。
 *
 * - 猜：跑完一个用户不想要的东西；
 * - 失败：花掉一次尝试 + 一笔钱，然后 Router 看到一条"跑挂了"，还得自己复盘。
 *
 * 所以给它两个工具：**请示**（我卡在一个需要你定的地方）和**交回**（这条线不该由我做）。
 *
 * 一条闸门同样是设计的一部分：**进度不进 Router**。每一步都汇报，Router 就变成日志
 * 消费者——那和记忆里删掉的"日志冒充记忆"是同一个错误，只是换成了"日志冒充汇报"。
 * 进度走 `task.steps`（界面与 Watchdog 看），不走 `report` 队列。
 */

/**
 * 同一件事请示第二次，就不再是 `decide`。
 *
 * 为什么：`decide` 的意思是「我要你放下手上的事」。一个执行体在同一件事上请示两次，
 * 说明它不该接这件事；而每请示一次，你就得放下手上的事一次。第二次降成 `notify`——
 * 你仍然看得见，但它不再插队。
 */
export function escalationLevel(previous: number): 'decide' | 'notify' {
  return previous === 0 ? 'decide' : 'notify';
}

export interface EscalateToolDeps {
  taskId: () => string | undefined;
  /**
   * 把请示投到线上。宿主决定等级（它知道这是第几次），并落一条步骤。
   * 返回等级是为了让工具能如实告诉模型"这句话有没有插队"。
   */
  escalate: (input: {
    taskId: string;
    question: string;
    tried: string;
    suggestion: string;
  }) => { level: 'decide' | 'notify' };
}

export function createEscalateToolExtension(deps: EscalateToolDeps) {
  return defineExtension({
    name: 'opc.escalate',
    tools: [
      defineTool({
        name: 'escalate',
        description:
          '把一件你定不了的事问到线上（给用户和调度那个常驻助手看）。只在真的卡住时用：' +
          '两种方案拿不准、缺一个只有他能给的信息、或者缺验收标准。' +
          '每一个任务最多问两次，第二次不会插队。不要用它汇报进度——进度记在工作步骤里就行。',
        parameters: Type.Object({
          question: Type.String({ description: '要他定的是什么，一句话。' }),
          tried: Type.Optional(Type.String({ description: '你已经试过什么（一句话）。' })),
          suggestion: Type.Optional(Type.String({ description: '你倾向怎么办，以及为什么。' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const question = args.question.trim();
          if (question.length < 4) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '要问什么？问题太短了。' }],
            };
          }
          const taskId = deps.taskId();
          if (!taskId) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '现在没有在跑的任务，没有可请示的线。' }],
            };
          }

          const { level } = deps.escalate({
            taskId,
            question,
            tried: args.tried?.trim() ?? '',
            suggestion: args.suggestion?.trim() ?? '',
          });

          return {
            output: [
              {
                type: 'text' as const,
                text:
                  level === 'decide'
                    ? '已经问到线上了，会插进他要处理的事里。等回话期间先做不依赖这个答案的部分。'
                    : '又问了一次。这次不会插队，只是记在那条线上——同一件事问两次，说明该自己拿主意了。',
              },
            ],
          };
        },
      }),
    ],
  });
}

export interface HandBackToolDeps {
  taskId: () => string | undefined;
  handBack: (input: { taskId: string; reason: string }) => { ok: boolean; reason?: string };
}

/**
 * `hand_back`：这条线不该由我做。
 *
 * 原文 §3.2 明说执行体可以取消订阅、把线交回 Router 重新分派。**它不是失败**：失败要花掉
 * 一次尝试、还要耗预算，而"这件事不是我该做的"是一次成功的判断——目标变了、缺权限、
 * 本来就不是执行类的工作，都属于这一类。
 */
export function createHandBackToolExtension(deps: HandBackToolDeps) {
  return defineExtension({
    name: 'opc.handback',
    tools: [
      defineTool({
        name: 'hand_back',
        description:
          '把这条工作线交回给调度它的那个助手：目标变了、缺权限、或者本来就不是执行类的工作。' +
          '交回不是失败——它不消耗一次尝试。交回之后你不会再收到这条线上的新事件。',
        parameters: Type.Object({
          reason: Type.String({ description: '为什么不该由你做，一句话说清。' }),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const reason = args.reason.trim();
          if (reason.length < 4) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '要交回就得说清原因。' }],
            };
          }
          const taskId = deps.taskId();
          if (!taskId) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: '现在没有在跑的任务，没有可交回的线。' }],
            };
          }

          const result = deps.handBack({ taskId, reason });
          if (!result.ok) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `交回失败：${result.reason ?? '未知原因'}` }],
            };
          }
          return {
            output: [
              {
                type: 'text' as const,
                text:
                  '已经交回了，这条线回到未指派状态，后续事件不会再直通给你。' +
                  '手上的改动不用回滚，但不要再往下做了。',
              },
            ],
          };
        },
      }),
    ],
  });
}
