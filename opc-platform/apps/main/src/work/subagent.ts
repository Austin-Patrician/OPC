/**
 * 子代理（原文 §2.2：Worker 内部可以再创建 Subagent，对 Router 透明）。
 *
 * **它拆的是思考，不是交付物。** 这两件事在 v2 里必须分开，否则会得到一个既贵又慢的
 * 东西：
 *
 * | | `decompose` | `investigate` |
 * |---|---|---|
 * | 拆什么 | 交付物 | 思考 |
 * | 在库里是什么 | 新任务 + 新线 | **什么都不是**，一段返回 |
 * | 谁验收 | 各自的闸门 | 没有闸门，父自己判断信不信 |
 * | Router 看得见吗 | 看得见（汇报） | 透明，只留步骤记录 |
 * | 账记在谁头上 | 各自的任务 | **父任务** |
 *
 * 为什么需要它：一个任务里常有"先查清三件事，再决定怎么写"。同一份上下文查三件事，
 * 前两件的无关细节就永久留在窗口里，查到第三件时注意力已经被稀释掉了——原文 §2 说的
 * "细节混杂影响完成效果"，在一个任务内部同样会发生。
 */

/** 派出去要查什么。 */
import type { Context } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';

export interface SubagentRequest {
  /** 父任务。作用域、预算、账目都挂在它上面。 */
  taskId: string;
  question: string;
  /** 希望拿到什么形状的答案。空串表示没特别要求。 */
  expects: string;
  /** 父任务的交付物规格：子代理要知道自己查的东西最终为了什么。 */
  deliverableSpec: string;
  /** 父任务的工作目录。**只读**：它只能看，不能写。 */
  workspaceDir: string;
  /** 它唯一可写的地方。 */
  scratchDir: string;
  /** 必须继承的约束：用户要求过、一直有效的，以及做事规矩。 */
  constraints: readonly string[];
}

/** 一个子代理的结论 + 它碰过什么。 */
export interface SubagentAnswer {
  answer: string;
  /** 它读过/写过的相对路径。给引用，不给全文（§3.3）。 */
  written: readonly string[];
  /** 合到父任务上的用量。 */
  tokens: number;
  costUsd: number;
}

export type SubagentRunner = (
  request: SubagentRequest,
  api: SubagentToolApi,
  context: Context,
) => Promise<SubagentAnswer>;

/**
 * 子代理只用到工具调用的四件事：知道自己是谁（作用域与所有权）、能开一个归自己的
 * 会话、能拿到它的句柄、能让界面挂上去。
 *
 * 用 `Pick` 而不是整个 `ToolExecutionApi`：这里声明的是**宿主依赖什么**，多一个
 * 字段，就多一个以后不敢改的地方。
 */
export type SubagentToolApi = Pick<
  ToolExecutionApi,
  'taskId' | 'commit' | 'conversation' | 'details'
>;

/**
 * 子代理的提示词。
 *
 * 三条约束都写在明面上：**不写父目录**、**不派子代理**、**只写结论**。沙箱兜住了
 * 第一条（它唯一可写的根是 scratch），深度兜住了第二条（见 `investigateTool`），
 * 第三条只能靠说——但代价很小，因为它只是浪费自己的几步。
 */
export function buildSubagentPrompt(request: SubagentRequest): string {
  const lines = [
    '你被派出去查清一件事。你不是来完成父任务的，查完就回来。',
    '',
    `要查的问题：${request.question}`,
  ];
  if (request.expects.trim()) lines.push(`希望给出的：${request.expects.trim()}`);
  lines.push(
    `父任务的交付物：${request.deliverableSpec}`,
    '',
    `父任务的工作目录：${request.workspaceDir}`,
    '（那里**只读**——可以读、可以跑只读的命令，但写它会被沙箱拒绝。）',
    `你能写的地方只有当前目录：${request.scratchDir}`,
  );

  if (request.constraints.length > 0) {
    lines.push('', '必须遵守（用户要求过的）：');
    for (const rule of request.constraints) lines.push(`- ${rule}`);
  }

  lines.push(
    '',
    '要求：',
    '1. 把结论写成**你这一轮的回答**：只写结论与依据，不要复述你查的过程。',
    '   父只读得到你最后那段话，读不到你的中间步骤。',
    '2. 不要再派子代理——你已经是最里面那一层了。',
    '3. 查不到就说查不到，并写清你试过什么。编一个像样的结论比没有结论更糟。',
  );

  return lines.join('\n');
}
