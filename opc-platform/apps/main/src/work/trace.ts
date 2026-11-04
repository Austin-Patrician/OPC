import type { AgentEvent, ConversationId, Harness } from '@earendil-works/pi-durable';
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

export interface TraceStream {
  stop: () => Promise<void>;
}

/**
 * 接上 pi 的事件流，把工具调用写进动作档。
 *
 * 返回 `null` 表示没接上（运行时版本、上下文、库路径都有可能）——那不是失败，
 * 只是这个任务没有轨迹。抛出去就等于用一个观测缺陷拖垮一件正在干的活。
 */
export async function attachTraceStream(deps: {
  harness: Harness;
  conversationId: ConversationId;
  context: unknown;
  recorder: TraceRecorder;
}): Promise<TraceStream | null> {
  try {
    const { watchEvents } = await import('@earendil-works/pi-durable');
    const stream = await watchEvents(
      deps.harness,
      deps.conversationId as never,
      deps.context as never,
    );
    /** toolCallId → 参数摘要。start 与 end 常常不在同一批事件里。 */
    const pendingArgs = new Map<string, string>();

    stream.start(async (events) => {
      for (const event of events) applyAgentEvent(event, pendingArgs, deps.recorder);
    });

    return {
      stop: async () => {
        try {
          await stream.stop();
        } catch {
          // 会话已经关了：没有要收的东西。
        }
      },
    };
  } catch (error) {
    console.warn('[trace] 事件流没接上，这个任务不会有动作记录', error);
    return null;
  }
}

/**
 * 一条事件 → 一行动作。导出是为了用例能拿假事件驱动它，而不必开一个真 harness。
 *
 * `start` 只记参数摘要，`end` 才落一行：参数先到、结果后到，中间可能隔着一整批事件。
 */
export function applyAgentEvent(
  event: AgentEvent,
  pendingArgs: Map<string, string>,
  recorder: TraceRecorder,
): void {
  // 助手消息里带着完整的工具调用参数，这是比任务 checkpoint 更可靠的来源：
  // checkpoint 在调用开始后会被清掉，`tool_execution_start` 就只剩一个空对象。
  if (event.type === 'message_end') {
    for (const message of event.entry.model ?? []) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        if (!pendingArgs.get(block.id)) {
          pendingArgs.set(block.id, digestArgs(block.arguments as Record<string, unknown>));
        }
      }
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    const digest = digestArgs(event.args as Record<string, unknown>);
    // 已经有更完整的（来自助手消息）就不拿空对象覆盖它。
    if (digest || !pendingArgs.get(event.toolCallId)) pendingArgs.set(event.toolCallId, digest);
    return;
  }

  // 真正的"这一轮炸了"。`tool_execution_end` 缺结果时我们只知道"不知道"，
  // 而这条事件给了确定的失败——包括工具任务 faulted 与运行被中止。
  if (event.type === 'task_failed') {
    recorder.record({ kind: 'error', name: event.kind, ok: false, argsDigest: event.message });
    return;
  }

  if (event.type !== 'tool_execution_end') return;

  const argsDigest = pendingArgs.get(event.toolCallId) ?? '';
  pendingArgs.delete(event.toolCallId);
  const outcome = readOutcome(event);
  recorder.record({
    kind: 'tool',
    name: event.toolName,
    argsDigest,
    ok: outcome.ok,
    ...(outcome.ms === undefined ? {} : { ms: outcome.ms }),
  });
}

/**
 * 这次调用成没成——**三态**。
 *
 * - 嵌套调用给 `result`；模型发起的调用给结果 `entry`，里面是 `role: 'toolResult'` 的消息；
 *   两者都能读成成功或失败。
 * - **两样都没有** = 工具任务 faulted / orphaned，或者调用所在的运行结束了。pi 不区分这两件事，
 *   我们也不假装区分：记 `null`（不知道）。把"不知道"画成失败，界面就在替系统撒谎。
 */
function readOutcome(event: {
  entry?: { model?: readonly { role: string; isError?: boolean; durationMs?: number }[] };
  result?: { isError: boolean; durationMs?: number };
}): { ok: boolean | null; ms?: number } {
  if (event.result) {
    return {
      ok: !event.result.isError,
      ...(event.result.durationMs === undefined ? {} : { ms: event.result.durationMs }),
    };
  }

  const message = event.entry?.model?.find((item) => item.role === 'toolResult');
  if (!message) return { ok: null };
  return {
    ok: message.isError !== true,
    ...(typeof message.durationMs === 'number' ? { ms: message.durationMs } : {}),
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max = DIGEST_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
