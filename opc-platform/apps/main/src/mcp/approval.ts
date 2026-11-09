import {
  hook,
  ToolTask,
  type HookApi,
  type HookRegistration,
  type ToolHookCall,
} from '@earendil-works/pi-durable';

/**
 * 动作级审批（M3）。
 *
 * 前面几件都不是"要不要拦"的问题：MCP 服务器会自己声明 `destructiveHint` /
 * `openWorldHint`——**这是它说的话，不是我们猜的**。缺的是"停下来等人点头"那条路。
 *
 * 形状定下来是这样：
 *
 * ```
 * beforeTool 看到要审批的工具、没有放行条
 *   → 写一条 approval 审计记录，并推送 Router 聊天卡片
 *   → 这次调用被拦，模型收到一句"已经问到队列里了"
 * 你在聊天卡片上按「允许」
 *   → 落一张放行条（这件活 × 这个工具）
 *   → 回答也插进它正在跑的会话："他批准了，你可以重试"
 * 它重试 → 放行条在 → 通过
 * ```
 *
 * 一个判断：**拦住之后必须由系统去问，不能指望模型记得请示。** 模型被拦之后最常见的
 * 反应是换个做法继续，而不是回头报告"我被拦了"——那条"我卡住了"的话如果只写在工具
 * 返回里，你就永远看不到。
 */

/** 审批要问谁。由宿主（`workService`）在开跑时挂上，因为只有它知道这条会话在跑哪件活。 */
export interface ApprovalBridge {
  /** 这条会话正在跑的活。空 = 不在任务里（探针、Router），不拦。 */
  taskId(): string | undefined;
  hasPermit(taskId: string, tool: string): boolean;
  /** 把"要你点头"投到线上。宿主负责写汇报、定等级。 */
  ask(input: { taskId: string; tool: string; title: string }): void;
}

/**
 * 会话 → 桥。和 `opc.trace` 是同一个理由：hook 是按扩展装的，桥是**按任务**的。
 */
const bridges = new Map<string, ApprovalBridge>();

export function registerApprovalBridge(conversationId: unknown, bridge: ApprovalBridge): () => void {
  bridges.set(String(conversationId), bridge);
  return () => {
    bridges.delete(String(conversationId));
  };
}

/**
 * 造那条 hook。
 *
 * `gated` 是「工具名 → 给人看的一行」，只在需要审批的工具上出现。空表就不装 hook
 * ——没有要拦的东西时，多一个每次调用都跑的监听没有意义。
 */
export function approvalHook(gated: ReadonlyMap<string, string>): HookRegistration | null {
  if (gated.size === 0) return null;

  return hook(ToolTask, {
    beforeTool: (call: ToolHookCall, api: HookApi) => {
      const title = gated.get(call.name);
      if (!title) return undefined;

      const bridge = bridges.get(String(api.conversationId));
      if (!bridge) return undefined;
      const taskId = bridge.taskId();
      if (!taskId) return undefined;
      if (bridge.hasPermit(taskId, call.name)) return undefined;

      bridge.ask({ taskId, tool: call.name, title });
      return {
        block:
          `「${title}」会改动东西或者伸到外面去，需要他点头。` +
          '这件事已经在 Router 聊天里请求审批：先做不依赖这一步的部分，别换个绕路的方式做同一件事。',
      };
    },
  }) as HookRegistration;
}

/** 用例用：把 hook 当普通函数驱动，不必开一个真 harness。 */
export function driveApproval(
  registration: HookRegistration,
  call: ToolHookCall,
  conversationId: string,
): { block?: string } | undefined {
  const handlers = registration.handlers as {
    beforeTool?: (call: ToolHookCall, api: HookApi) => { block?: string } | undefined;
  };
  return handlers.beforeTool?.(call, { conversationId } as unknown as HookApi);
}
