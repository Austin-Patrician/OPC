import {
  defineExtension,
  hook,
  ToolTask,
  type Extension,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from '@earendil-works/pi-durable';
import type { TaskTraceKind } from '@opc/shared/domain';
import type { TaskRepository } from '../data/taskRepository';

/**
 * 执行体的**动作流**（`09-worker-spec.md` §3.4 / 不变量 W6）。
 *
 * 在这之前，一次尝试只往 `task_step` 写四条系统旁白（交给 pi 循环 / 模型用量 /
 * pi 循环结束）。工具调用、改了哪个文件——一条都没有。三个消费方因此同时瞎：
 *
 * - 界面上的"进度"是装饰，它显示的是我们自己的旁白；
 * - Watchdog 的「转圈」形同不触发：三次尝试写不出五条重复文本；
 * - 「方向是否偏离」没有任何材料，接一个模型去判也只能是猜。
 *
 * 这个文件只做一件事：**把 pi 的工具事件变成一行一行的动作**。三条纪律：
 *
 * 1. **不进 Router。** 结论走 `report`，过程走 trace。混在一起 Router 就成了日志消费者。
 * 2. **摘要不是正文。** 参数只留一个能认出"它在干什么"的开头，全文留在 pi 的会话里。
 * 3. **观测不能拖垮任务。** 拿不到事件流、写不进库，都只是"这一次没有轨迹"，
 *    绝不让它变成一个失败的任务。
 */

/** 裁剪策略：留头 50 条（怎么开头的）与尾 200 条（最近在干什么）。 */
export const TRACE_HEAD = 50;
export const TRACE_TAIL = 200;

/** 摘要上限。轨迹是索引，不是正文——正文在 `recall` 后面。 */
const DIGEST_MAX = 120;

export interface TraceRecorder {
  readonly taskId: string;
  record(input: {
    kind: TaskTraceKind;
    name: string;
    argsDigest?: string;
    /** `null` = 不知道（没拿到结果行）。 */
    ok?: boolean | null;
    ms?: number;
    tokens?: number;
  }): void;
}

/**
 * 一个任务的记录器。
 *
 * `seq` 从库里续：重试、续跑、进程重启都不会把它从头开始，所以空洞的含义永远是
 * "这一段被裁掉了"，不会是"这一段不存在"。
 */
export function createTraceRecorder(deps: {
  repository: TaskRepository;
  taskId: string;
}): TraceRecorder {
  let seq = deps.repository.maxTraceSeq(deps.taskId);
  let warned = false;

  return {
    taskId: deps.taskId,
    record(input) {
      seq += 1;
      try {
        deps.repository.appendTrace({ taskId: deps.taskId, seq, ...input });
        deps.repository.pruneTrace(deps.taskId, TRACE_HEAD, TRACE_TAIL);
      } catch (error) {
        // 记轨迹失败不该让一个正在干活的执行体停下来。说一次，然后继续。
        if (!warned) {
          warned = true;
          console.warn('[trace] 动作没记上（这次任务的轨迹会不完整）', error);
        }
      }
    },
  };
}

/**
 * 参数摘要：一行、能认出在干什么。
 *
 * 优先取"主参数"（命令、路径、查询），拿不到才退成 `key=value` 的短拼装。
 * 不落全文的理由和 spill 一样：**轨迹是索引**，要看内容就去 `recall` 原文。
 */
export function digestArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const preferred = ['command', 'path', 'file_path', 'filePath', 'target', 'url', 'query', 'question', 'text'];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return clip(oneLine(value));
  }

  const summary = Object.keys(args)
    .slice(0, 4)
    .map((key) => {
      const value = args[key];
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      return `${key}=${clip(oneLine(text), 40)}`;
    })
    .join(' ');
  return clip(summary);
}

/** 一串动作渲染给人和模型看；`seq` 的空洞折成一行「略去 N 步」。 */
export { describeTrace, renderTrace } from '@opc/shared/trace';

/**
 * 会话 → 记录器。
 *
 * 记录器是**按任务**的（`seq` 从库里续），而 hook 是**按扩展**装的（一个执行体一份
 * 注册表）。这张表是两者之间的桥：任务开跑时登记，结束时撤掉。放进模块级而不是闭包，
 * 理由和 `investigateTool` 的 `inFlight` 一样——hook 拿不到那个任务的闭包。
 */
const recorders = new Map<string, TraceRecorder>();
/** `callId` → 开始时间。`afterTool` 拿不到时长，只能自己掐表。 */
const started = new Map<string, number>();

/** 登记一个任务的记录器，返回撤销函数（任务结束必须调，否则表会一直长）。 */
export function registerTraceRecorder(conversationId: unknown, recorder: TraceRecorder): () => void {
  recorders.set(String(conversationId), recorder);
  return () => {
    recorders.delete(String(conversationId));
  };
}

/**
 * 动作流扩展：`hook(ToolTask, { beforeTool, afterTool })`。
 *
 * 以前这里接的是 pi 的**事件流**（`watchEvents`），1.5.0 把它删了，理由写在它的
 * CHANGELOG 里：渲染状态，而不是用事件把它拼出来。对我们来说 hook 反而更好——
 * 一个工具调用正好一次 `afterTool`，不需要"start 先到、end 后到"的配对，也不会
 * 因为崩在中间而留下一行永远等不到结尾的轨迹。
 *
 * 代价照实说：`afterTool` 不含时长，所以自己掐秒；pi 自己写的错误结果（参数非法、
 * 被拦、被中止）也走这里，所以"工具没跑成"仍然看得见。
 */
export function createTraceExtension(): Extension {
  return defineExtension({
    name: 'opc.trace',
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: ToolHookCall, api: HookApi) => {
          started.set(`${api.conversationId}:${call.id}`, Date.now());
          return undefined;
        },
        afterTool: (
          call: ToolHookCall,
          result: ToolExecutionResult,
          api: HookApi,
        ) => {
          const key = `${api.conversationId}:${call.id}`;
          const at = started.get(key);
          started.delete(key);
          const recorder = recorders.get(String(api.conversationId));
          // 没有登记 = 这条会话不是一件正在被记录的任务（子代理、探针、Router）。
          if (!recorder) return undefined;
          recorder.record(
            traceRowFor(call, result, at === undefined ? undefined : Date.now() - at),
          );
          return undefined;
        },
      }),
    ],
  });
}

/** 一次工具调用 → 一行动作。纯函数，用例直接驱动它，不必开一个真 harness。 */
export function traceRowFor(
  call: ToolHookCall,
  result: ToolExecutionResult,
  ms?: number,
): Parameters<TraceRecorder['record']>[0] {
  return {
    kind: 'tool',
    // 嵌套调用（`executeTool`）标出来：它在时间线上不是模型的直接一步，
    // 而是一次工具内部的分岔——看轨迹的人需要分得清这两件事。
    name: call.parent ? `${call.name}（嵌套）` : call.name,
    argsDigest: digestArgs(call.arguments as Record<string, unknown> | undefined),
    ok: result.isError !== true,
    ...(ms === undefined ? {} : { ms }),
    ...(result.usage ? { tokens: usageTotal(result.usage) } : {}),
  };
}

/** 一次调用的 token 总和。读不出来就不给（0 和"不知道"不是一回事）。 */
function usageTotal(usage: unknown): number | undefined {
  const models = (usage as { models?: Record<string, { input?: number; output?: number }> }).models;
  if (!models) return undefined;
  let total = 0;
  for (const entry of Object.values(models)) total += (entry.input ?? 0) + (entry.output ?? 0);
  return total > 0 ? total : undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max = DIGEST_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
